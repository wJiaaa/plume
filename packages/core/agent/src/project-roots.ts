import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectEntry } from "@plume/contract";

/** 只认会话记下的项目；工作目录移入独立工作树后，不再给原项目的读取权限。 */
export function projectRootsFor(projects: readonly ProjectEntry[], cwd: string, project?: string): string[] {
	const own = projects.find((entry) => entry.id === project);
	if (!own) return [];
	const roots = [...new Set([own.path, ...(own.folders ?? [])].filter(Boolean))];
	return roots.some((root) => {
		const rel = relative(resolve(root), resolve(cwd));
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	})
		? roots
		: [];
}
