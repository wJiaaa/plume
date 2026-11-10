/**
 * 三个自定义协议：
 *
 * - `plume-plugin://<目录名>/<路径>`：插件目录里的文件（界面入口 dist/ui.mjs 等）。每个插件一个源，路径不能跳出插件目录。
 * - `plume-host://shared/<模块名>.js`：产品共享给插件界面入口的模块（React、@plume/ui、@plume/styles）。返回一个薄壳，
 *   从 `globalThis.__PLUME_SHARED__` 重新导出宿主正在用的实例，所以插件和宿主用的是同一份 React。
 * - `plume-media://m/<名字>[?thumb=<边长>]`：会话里挪出消息的图片（agent 进程存在数据目录的 `session-media/` 下，按内容的 sha1 命名）。
 *   只认那种名字，路径跳不出目录；内容按名字定死，可以一直缓存。带 `thumb` 时发长边缩到这么长的 PNG（见 `media-thumbs.ts`），
 *   原图本来就不比它大时发原图。
 * - `plume-media://f/<会话 id>/<编码过的路径>?v=<修改时间>`：文件面板里的图片、PDF、音视频。每次请求都先问 agent 进程
 *   这个路径在不在会话的工作目录里（和读文件是同一道检查），读的是它交回的真实路径；只发这几类，别的回 404。
 *   `v` 只为让原地改写过的文件换个地址重新取，这里不看它。走协议而不是把字节经 RPC 递过去：几十 MB 的视频
 *   要先变成更大的字符串，音视频还要按 Range 分段才能拖进度。
 */

import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readMediaBytes } from "@plume/agent";
import { nativeImage, net, protocol } from "electron";
import { mediaThumb } from "./media-thumbs.ts";
import { serveRanged } from "./ranged-file.ts";

const PLUGIN_SCHEME = "plume-plugin";
const HOST_SCHEME = "plume-host";
const MEDIA_SCHEME = "plume-media";
const MEDIA_NAME = /^[0-9a-f]{40}\.(png|jpg|webp|gif|bmp)$/;
const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };
const CACHED = "max-age=31536000, immutable";
/** 缩略图边长的上限：再大就不是缩略图了，也不让一个地址在盘上存出任意多份。 */
const MAX_THUMB = 2048;

/** 文件面板能直接显示的几类，和渲染进程 files/FileViewer.tsx 的分类对得上。 */
const FILE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
};

/** 会话工作目录里这个文件的真实路径；不在目录里、不是文件时是 null。由 agent 进程判断。 */
export type ResolveSessionFile = (sessionId: string, path: string) => Promise<string | null>;

const MIME: Record<string, string> = {
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".html": "text/html",
	".svg": "image/svg+xml",
	".png": "image/png",
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** 必须在 app ready 之前调用。 */
export function registerSchemes(): void {
	const privileges = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true };
	protocol.registerSchemesAsPrivileged([
		{ scheme: PLUGIN_SCHEME, privileges },
		{ scheme: HOST_SCHEME, privileges },
		// stream：音视频按 Range 分段取，没有它 `<video>` 收不到分段的回答。
		{ scheme: MEDIA_SCHEME, privileges: { ...privileges, stream: true } },
	]);
}

/** 共享模块的导出名，由渲染进程启动时上报（只有它手里有真正的模块对象）。 */
export const sharedExports = new Map<string, string[]>();

export function handleProtocols(pluginDirs: ReadonlyMap<string, string>, mediaDir: string, resolveFile: ResolveSessionFile): void {
	protocol.handle(MEDIA_SCHEME, async (request) => {
		const url = new URL(request.url);
		if (url.hostname === "f") return serveSessionFile(url, request, resolveFile, mediaDir);
		let name: string;
		try {
			name = decodeURIComponent(url.pathname).replace(/^\/+/, "");
		} catch {
			return notFound();
		}
		const match = url.hostname === "m" ? MEDIA_NAME.exec(name) : null;
		if (!match) return notFound();
		try {
			const thumb = Math.round(Number(url.searchParams.get("thumb")));
			// GIF 不缩：缩出来是一张静止的 PNG，动图就不动了。
			if (thumb > 0 && thumb <= MAX_THUMB && match[1] !== "gif") {
				const png = await mediaThumb(mediaDir, name, thumb, { source: () => readMediaBytes(mediaDir, name), shrink });
				if (png) return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": CACHED } });
			}
			const body = await readMediaBytes(mediaDir, name);
			if (!body) return notFound();
			return new Response(new Uint8Array(body), {
				headers: { "content-type": MEDIA_TYPES[match[1] as string] ?? "application/octet-stream", "cache-control": CACHED },
			});
		} catch {
			return notFound();
		}
	});

	protocol.handle(PLUGIN_SCHEME, async (request) => {
		const url = new URL(request.url);
		const root = pluginDirs.get(url.hostname);
		if (!root) return notFound();
		const file = resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
		if (!file.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
		try {
			const body = await readFile(file);
			return new Response(body, { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream", "access-control-allow-origin": "*" } });
		} catch {
			return notFound();
		}
	});

	protocol.handle(HOST_SCHEME, (request) => {
		const url = new URL(request.url);
		const match = /^\/(.+)\.js$/.exec(url.pathname);
		const specifier = url.hostname === "shared" && match ? decodeURIComponent(match[1] as string) : undefined;
		const names = specifier ? sharedExports.get(specifier) : undefined;
		if (!specifier || !names) return notFound();
		const named = names.filter((name) => name !== "default" && IDENTIFIER.test(name));
		const source = [
			`const m = globalThis.__PLUME_SHARED__[${JSON.stringify(specifier)}];`,
			"export default m.default ?? m;",
			named.length > 0 ? `export const { ${named.join(", ")} } = m;` : "",
		].join("\n");
		return new Response(source, { headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" } });
	});
}

/** 缩到这个边长的 PNG。本来就比它小、或解不开的，交回 null 发原图：放大只会糊，还白存一份。 */
function shrink(bytes: Uint8Array, edge: number): Uint8Array | null {
	const image = nativeImage.createFromBuffer(Buffer.from(bytes));
	if (image.isEmpty()) return null;
	const { width, height } = image.getSize();
	const longest = Math.max(width, height);
	if (longest <= edge) return null;
	const scale = edge / longest;
	return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toPNG();
}

async function serveSessionFile(url: URL, request: Request, resolveFile: ResolveSessionFile, mediaDir: string): Promise<Response> {
	// 路径整段编码过（斜杠是 %2F），按第一个斜杠分开会话 id 和路径。
	const [, session, encoded] = /^\/([^/]+)\/([^/]+)$/.exec(url.pathname) ?? [];
	if (!session || !encoded) return notFound();
	let sessionId: string;
	let target: string;
	try {
		sessionId = decodeURIComponent(session);
		target = decodeURIComponent(encoded);
	} catch {
		return notFound();
	}
	const type = FILE_TYPES[extname(target).toLowerCase()];
	if (!type) return notFound();
	const file = await resolveFile(sessionId, target).catch(() => null);
	if (!file) return new Response("forbidden", { status: 403 });
	const mediaRoot = await realpath(mediaDir).catch(() => null);
	if (dirname(file) === resolve(mediaDir) || dirname(file) === mediaRoot) {
		const body = await readMediaBytes(mediaDir, basename(file)).catch(() => null);
		return body ? new Response(new Uint8Array(body), { headers: { "content-type": type } }) : notFound();
	}
	if (type.startsWith("video/") || type.startsWith("audio/")) return serveRanged(file, request, type);
	const answer = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
	if (!answer?.ok) return notFound();
	// file:// 按扩展名猜类型，猜不准的（.avif、.ico）界面就显示不出来；这里按上面的表写定。
	return new Response(answer.body, { headers: { "content-type": type } });
}

function notFound(): Response {
	return new Response("not found", { status: 404 });
}
