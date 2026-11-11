/**
 * 在浏览器里开本机的 `.html` 文件。
 *
 * 页面只开 http(s)，所以由逻辑入口起一个只听 127.0.0.1 的小服务，一个文件一个地址：前缀是这次启动的随机数和路径一起算的，
 * 别的页面猜不到；只给这一个文件，不给它所在的目录——整个目录交出去，页面里的脚本就读得到项目的 `.env`。代价是旁边的
 * 样式、脚本、图片加载不到，只有自成一体的页面能看。
 *
 * 每次请求现读磁盘：改了文件，刷新就是新的；同一个文件的地址不变，再开一次就是同一页重新加载。
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// i18n-exempt：下面的报错给模型（工具结果）和面板，面板换成当前语言的话再给人看。

const MAX_BYTES = 2 * 1024 * 1024;

/** 看着像本机的一个 `.html`：`file:` 地址、`~/`、绝对路径；`cwd` 给了时相对路径也算。不像的是 null。 */
export function localPath(raw: string, cwd?: string): string | null {
	const text = raw.trim();
	let path: string;
	if (/^file:/i.test(text)) {
		try {
			path = fileURLToPath(text);
		} catch {
			return null;
		}
	} else if (/^~[\\/]/.test(text)) path = join(homedir(), text.slice(2));
	else if (isAbsolute(text)) path = text;
	else if (cwd && !/^[a-z][\w+.-]*:/i.test(text) && !/\s/.test(text)) path = resolve(cwd, text);
	else return null;
	return /\.html?$/i.test(path) ? path : null;
}

export interface LocalPages {
	/** 这个文件在浏览器里的地址。不是能读的 `.html` 文件时抛错。 */
	address(path: string): Promise<string>;
	/** 这个地址是哪个文件给的；不是本机页面时是 undefined。 */
	source(url: string): string | undefined;
	close(): void;
}

export function createLocalPages(): LocalPages {
	const secret = randomBytes(16).toString("hex");
	/** 前缀 → 文件。 */
	const files = new Map<string, string>();
	let server: Promise<{ server: Server; origin: string }> | undefined;

	const start = () =>
		(server ??= new Promise((done, fail) => {
			const created = createServer((request, response) => {
				const [, token] = /^\/([a-f0-9]{24})\//.exec(request.url ?? "") ?? [];
				const file = token ? files.get(token) : undefined;
				if (request.method !== "GET" || !file) {
					response.writeHead(404).end();
					return;
				}
				void readPage(file).then(
					(content) => response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(content),
					(error: unknown) =>
						response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(error instanceof Error ? error.message : String(error)),
				);
			});
			created.once("error", fail);
			created.listen(0, "127.0.0.1", () => done({ server: created, origin: `http://127.0.0.1:${(created.address() as AddressInfo).port}` }));
		}));

	return {
		async address(path) {
			await readPage(path);
			// 同一个文件两种写法（`/private/var` 和 `/var`、软链）还是同一页。
			const real = await realpath(path);
			const token = createHash("sha256").update(`${secret}\n${real}`).digest("hex").slice(0, 24);
			files.set(token, real);
			const { origin } = await start();
			return `${origin}/${token}/${encodeURIComponent(basename(real))}`;
		},
		source(url) {
			const [, token] = /^http:\/\/127\.0\.0\.1:\d+\/([a-f0-9]{24})\//.exec(url) ?? [];
			return token ? files.get(token) : undefined;
		},
		close() {
			void server?.then(
				({ server }) => server.close(),
				() => {},
			);
		},
	};
}

async function readPage(path: string): Promise<string> {
	if (!/\.html?$/i.test(path)) throw new Error(`Only .html files can be opened: ${path}`);
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) throw new Error(`No such file: ${path}`);
	if (info.size > MAX_BYTES) throw new Error(`The page is larger than 2 MB: ${path}`);
	return readFile(path, "utf8");
}
