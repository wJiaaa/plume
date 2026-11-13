/**
 * 路径交给模型时怎么写，和几样只看文件本身的判断。模型写的路径指的是哪里由本体解析（`ToolRun.files.resolve`），读写边界也在本体。
 */

import { isAbsolute, relative, sep } from "node:path";
import type { PluginResources } from "@plume/contract";

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

/** scheme 的写法：必须有 `://`，`C:\Users` 不是地址（和本体拆地址的规则一样）。 */
const SCHEME = /^([a-z][a-z0-9-]*):\/\//i;

/**
 * `input` 是不是有人登记了的资源地址（`ctx.resources.list()`）：是的话经本体按地址读写（`ToolRun.files.read`、`write`），
 * 不是的话（普通路径、没人认的 `foo://`）照路径处理——没人认的 `foo://` 在文件系统那里以「找不到」失败，那是实话。
 * 不给登记表（直接调工具的测试）时都不是。
 */
export function isAddress(resources: Pick<PluginResources, "list"> | undefined, input: string): boolean {
	if (!resources || typeof input !== "string") return false;
	const scheme = SCHEME.exec(input.trim())?.[1]?.toLowerCase();
	return scheme !== undefined && resources.list().some((entry) => entry.scheme === scheme);
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
