import { baseName } from "./open-file.ts";
export { baseName };

const TRAILING = /[/\\]+$/;

function lastCut(path: string): number {
	return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

function separatorOf(path: string): string {
	return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function joinPath(dir: string, name: string): string {
	const separator = separatorOf(dir);
	return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${separator}${name}`;
}

function windowsPath(path: string): boolean {
	return /^[a-zA-Z]:[/\\]/.test(path) || path.startsWith("\\\\");
}

function canonicalPath(path: string): string {
	if (/^[a-zA-Z]:[/\\]/.test(path)) {
		const rest = path.slice(2).replace(/[/\\]+/g, "\\");
		return `${path[0]!.toUpperCase()}:${rest.length > 1 ? rest.replace(/\\$/, "") : rest}`;
	}
	if (path.startsWith("\\\\"))
		return `\\\\${path
			.slice(2)
			.replace(/[/\\]+/g, "\\")
			.replace(/\\$/, "")}`;
	return path;
}

function samePath(a: string, b: string): boolean {
	if (a === b) return true;
	return windowsPath(a) && windowsPath(b) && canonicalPath(a).toLowerCase() === canonicalPath(b).toLowerCase();
}

function comparable(root: string, path: string): { prefix: string; path: string; fold: (text: string) => string } {
	const windows = windowsPath(root) && windowsPath(path);
	const base = windows ? canonicalPath(root) : root;
	return {
		prefix: base.endsWith("/") || base.endsWith("\\") ? base : base + separatorOf(base),
		path: windows ? canonicalPath(path) : path,
		fold: windows ? (text) => text.toLowerCase() : (text) => text,
	};
}

export function relativeTo(root: string, path: string): string {
	if (samePath(path, root)) return baseName(root);
	const at = comparable(root, path);
	return at.fold(at.path).startsWith(at.fold(at.prefix)) ? at.path.slice(at.prefix.length) : path;
}

export const DRAGGED_PATHS = "application/x-plume-paths";

/**
 * 一次拖放带着的本机路径，见 `UiContext.droppedPaths`：文件树的行带着绝对路径，访达里的文件经 `pathFor` 问。
 *
 * 只能同步读：drop 处理函数一返回 `DataTransfer` 就空了。dragover 时浏览器不给读内容，带路径也只能答空数组。
 */
export function droppedPaths(transfer: DataTransfer, pathFor: (file: File) => string): string[] | null {
	if (transfer.types.includes(DRAGGED_PATHS)) {
		try {
			const paths: unknown = JSON.parse(transfer.getData(DRAGGED_PATHS) || "[]");
			return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
		} catch {
			return [];
		}
	}
	if (!transfer.types.includes("Files")) return null;
	return Array.from(transfer.files).flatMap((file) => {
		try {
			const path = pathFor(file);
			return path ? [path] : [];
		} catch {
			return [];
		}
	});
}

export function isDescendantPath(parent: string, child: string): boolean {
	if (samePath(child, parent)) return false;
	const at = comparable(parent, child);
	return at.fold(at.path).startsWith(at.fold(at.prefix));
}

/** 几个源文件夹里装着这个路径的那一个：嵌套时取最深的，本身就是源文件夹的取它自己；都不装着时没有。 */
export function rootOf(roots: readonly string[], path: string): string | undefined {
	return [...roots].sort((a, b) => b.length - a.length).find((root) => samePath(root, path) || isDescendantPath(root, path));
}

export function parentOf(path: string): string {
	const trimmed = path.replace(TRAILING, "");
	const at = lastCut(trimmed);
	if (at < 0) return "";
	return at === 0 ? trimmed.slice(0, 1) : at === 2 && /^[a-z]:/i.test(trimmed) ? trimmed.slice(0, 3) : trimmed.slice(0, at);
}

export function splitExtension(name: string): [stem: string, extension: string] {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}
