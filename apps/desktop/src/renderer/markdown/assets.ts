/**
 * Markdown 里写的一个相对地址，在这台机器上实际是哪个文件。
 *
 * 回复里写 `[说明](docs/a.md)`，意思是「相对会话的工作目录」。渲染组件拿到的只是一段字，不知道这段字
 * 是在哪写的，所以由提供场景的地方把目录交下来，这里把两者拼成绝对路径。
 *
 * 纯 `.ts`，不用 `node:path`：渲染进程两样都没有，而这正是在 macOS 上没问题、到 Windows 上悄悄出错的
 * 那种代码。有测试。
 */

import { isRemoteOrDevicePath, remoteShareOf } from "../../shared/remote-path.ts";

/** 这个路径用哪种分隔符写的。Windows 路径保留它的反斜杠。 */
function separatorOf(dir: string): string {
	return dir.includes("\\") && !dir.startsWith("/") ? "\\" : "/";
}

/** 绝对路径，两种平台都认：`/a/b`、`C:\a\b`、`C:/a/b`，或 UNC 共享。 */
export function isAbsolutePath(target: string): boolean {
	return target.startsWith("/") || target.startsWith("\\\\") || /^[a-zA-Z]:[/\\]/.test(target);
}

/** 文件所在的目录。根目录下的 `/README.md` 在 `/` 里，不在空串里。 */
export function directoryOf(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	if (cut < 0) return "";
	return cut === 0 ? path.slice(0, 1) : path.slice(0, cut);
}

/** `path` 写在 `root` 下的那一段，两种分隔符都认；不在它下面（或就是它本身）时是 null。 */
export function relativeTo(root: string, path: string): string | null {
	const slashed = (text: string) => text.replaceAll("\\", "/");
	const inside = `${slashed(root).replace(/\/+$/, "")}/`;
	return slashed(path).startsWith(inside) ? path.slice(inside.length) || null : null;
}

/**
 * `src` 指的是什么，给定它所在的目录。
 *
 * 不是文件系统路径的一律 null——网址、data URI、单独的锚点：它们各有各的处理，替它们猜一个文件，
 * 猜出来的路径存在与否全凭运气。
 */
export function resolveAsset(dir: string | undefined, src: string): string | null {
	if (!dir) return null;

	const raw = src.trim();
	/*
	 * 协议、省略协议的网址、锚点：不归这里管。
	 *
	 * 先判绝对路径：`C:\pictures\a.png` 也符合协议的样子（一个字母加冒号），把 Windows 盘符当成协议，
	 * 就是在最少有人手动测的那个平台上永远打不开。
	 */
	if (!raw || raw.startsWith("#") || raw.startsWith("//")) return null;
	if (!isAbsolutePath(raw) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;

	/*
	 * `?raw=true`、`#gh-dark-mode-only` 是写给 GitHub 的，不是写给磁盘的。
	 *
	 * 两样在 README 里都常见，留在末尾就成了文件名的一部分，那个文件并不存在。
	 */
	let path: string;
	try {
		path = decodeURI(raw.split("#")[0]!.split("?")[0]!).trim();
	} catch {
		return null;
	}
	if (!path) return null;

	const separator = separatorOf(dir);
	const base = dir.endsWith(separator) ? dir.slice(0, -1) : dir;
	const resolved = isAbsolutePath(path) ? normalise(path, separatorOf(path)) : normalise(`${base}${separator}${path}`, separator);
	/*
	 * 别的机器上的文件，只在目录本身就在那个共享上时才认。
	 *
	 * 这里不是边界——读文件的一侧还会再拒一次——但这里出来的路径会变成一枚可点的文件签和一份菜单，而在
	 * Windows 上光是碰一下 `\\evil\s\a.md` 就会连上那台机器、递上用户的 NTLM 凭据。从自己的共享用 `..`
	 * 走到隔壁的共享，同样拒掉。
	 */
	if (isRemoteOrDevicePath(resolved) && remoteShareOf(resolved) !== (remoteShareOf(dir) ?? "")) return null;
	return resolved;
}

/**
 * 手动消掉 `.` 和 `..`。
 *
 * 读文件的一侧会再解析一次，这里不是边界；但留在字符串里的 `..` 让同一条路径在这里和那里读出两种
 * 意思，检查就是这样被绕过去的。
 */
function normalise(path: string, separator: string): string {
	const parts = path.split(/[/\\]/);
	// 开头的空段是根（`/a`），UNC 路径有两个，都留着。
	const lead = /^([/\\]*)/.exec(path)?.[1] ?? "";
	const out: string[] = [];

	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") {
			out.pop();
			continue;
		}
		out.push(part);
	}

	return lead.replace(/[/\\]/g, separator) + out.join(separator);
}
