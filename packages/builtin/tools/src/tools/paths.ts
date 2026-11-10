import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { appHomes, home, withinOrIs } from "./home.ts";
import type { ToolContext } from "./types.ts";

/** 这个会话的工具能写的临时目录：同一脉的会话（`ToolRun.scratchDirs`）的那几个，宿主没给时只有自己的。读不受它限制，见 `read-access.ts`。 */
export function scratchDirsOf(ctx: Pick<ToolContext, "scratchDir" | "scratchDirs">): readonly string[] {
	return ctx.scratchDirs ?? (ctx.scratchDir ? [ctx.scratchDir] : []);
}

/**
 * 模型要**写**的路径，只拒绝 Plume 自己的目录（见 `home.ts`）。
 *
 * 工作区外不在这里拒：写的时候审批卡照样会问。拒了的话，人说「存到桌面」，模型会改用
 * `cat > ~/Desktop/… <<EOF`——一样写到那里，只是卡片上没有 diff、没有「先读再写」的检查。
 * shell 不认的拒绝不是边界，只是绕路。
 *
 * Plume 自己的目录不开：那里有模型设置（含 API key）、权限、会话和插件，写得到它们的工具，
 * 一次看起来和别的调用没两样的调用就能改掉自己的权限。工作区本身在这些目录下的照样能写，同一脉的会话的临时目录（`scratchDirs`，见 `scratchDirsOf`）也能写；
 * 别的会话的临时目录不行：那是别的对话的草稿和原始输出。
 *
 * 附件（`ToolContext.allowedPaths`）不算：拖一个文件进来是「看看这个」，不是「可以改它」。
 */
export function resolveWorkspacePath(cwd: string, input: string, scratchDirs: readonly string[] = []): string {
	if (!input || typeof input !== "string") throw new Error("A path is required.");
	// 与读取侧同一套写法解析：以前这里只认 `~/`，Windows 上 `/c/…`、`~\` 读得到、写却报越界。
	const absolute = toAbsolute(cwd, input);
	if (writable([cwd, ...scratchDirs], appHomes(), absolute)) return absolute;
	// i18n-exempt：发给模型的话。
	throw new Error(
		`${input} is inside Plume's own data directory, which file tools do not write. Tell the user what to change there instead of changing it another way.`,
	);
}

/** Plume 自己的目录以外都行——除非那就是工作区或临时目录。 */
function writable(roots: string[], homes: string[], absolute: string): boolean {
	return homes.every((appHome) => !withinOrIs(appHome, absolute)) || roots.some((root) => withinOrIs(root, absolute));
}

/** `~/x` as an absolute path, and anything already absolute resolved against the session's cwd. */
export function toAbsolute(cwd: string, input: string): string {
	const native = process.platform === "win32" ? windowsSpelling(input, home(), tmpdir()) : input;
	const expanded = native.startsWith("~/") || native === "~" ? native.replace("~", home()) : native;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * A path as a Windows shell spelled it, as the Windows path it names.
 *
 * On Windows the agent's commands run in Git Bash, which reads `/c/Users/me` as `C:\Users\me` and
 * `/tmp` as the user's temp directory. Node reads the same strings as `C:\c\Users\me` and `C:\tmp`
 * — paths that do not exist, and a path that does not exist is not asked about (`worthAsking`).
 * So `cat /c/Users/me/.ssh/id_ed25519` read the key without a question. `~\` is PowerShell's
 * spelling of the home directory, which only `~/` was expanded for.
 *
 * Pure, with the home and temp directories handed in, so it can be tested on any platform.
 */
export function windowsSpelling(input: string, homeDir: string, tempDir: string): string {
	const drive = /^(?:\/cygdrive)?\/([a-zA-Z])(?=\/|$)(.*)$/.exec(input);
	if (drive) return `${drive[1]!.toUpperCase()}:\\${drive[2]!.replace(/^[/]/, "").replaceAll("/", "\\")}`;
	const temp = /^\/tmp(?=\/|$)(.*)$/.exec(input);
	if (temp) return `${tempDir}${temp[1]!.replaceAll("/", "\\")}`;
	if (input === "~" || input.startsWith("~\\")) return `${homeDir}${input.slice(1)}`;
	return input;
}

/** Canonicalize existing parents too, so aliases share a lock and a link cannot reach what the literal path may not. */
export async function resolveFilePath(cwd: string, input: string, scratchDirs: readonly string[] = []): Promise<string> {
	const absolute = resolveWorkspacePath(cwd, input, scratchDirs);
	const canonical = async (path: string): Promise<string> => {
		try {
			return await realpath(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
			return resolve(await canonical(dirname(path)), basename(path));
		}
	};
	const target = await canonical(absolute);
	const [root, scratch, realHomes] = await Promise.all([canonical(cwd), Promise.all(scratchDirs.map(canonical)), Promise.all(appHomes().map(canonical))]);
	if (!writable([root, ...scratch], realHomes, target)) {
		// i18n-exempt：发给模型的话。
		throw new Error(`${input} links into Plume's own data directory, which file tools do not write.`);
	}
	/*
	 * A link that looks like it is in the workspace and lands outside it is still refused. The
	 * approval card names the path as written, so it would read "Edit notes.md" over a change to
	 * whatever the link points at. Writing the target by its own name asks with that name instead.
	 */
	const near = [cwd, ...scratchDirs].some((place) => withinOrIs(place, absolute));
	if (near && ![root, ...scratch].some((place) => withinOrIs(place, target))) {
		// i18n-exempt：发给模型的话。
		throw new Error(`${input} is a link to ${target}, outside the workspace. Write ${target} by that path instead, so the approval names what changes.`);
	}
	return target;
}

/**
 * 给模型看的路径：相对工作区根，出了工作区写绝对路径。`read`/`edit` 按工作区根解析相对路径，
 * 所以 `grep`/`glob` 报出来的也必须这样写——相对搜索目录写过一次，`path: "src"` 搜出的
 * `pages/a.tsx` 拿去读就是 File not found。
 */
export function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute);
	if (rel === "") return ".";
	// `..x/a.ts` 是工作区里一个以 `..` 开头的目录，不是上一级。
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return absolute;
	return rel.split(sep).join("/");
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

export function imageMimeType(path: string): string | null {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return null;
	return IMAGE_EXTENSIONS[path.slice(dot).toLowerCase()] ?? null;
}

/** Heuristic: a NUL byte in the first 8 KiB means the file is not text. */
export function looksBinary(buffer: Buffer): boolean {
	const limit = Math.min(buffer.length, 8192);
	for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
	return false;
}
