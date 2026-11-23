/**
 * 文件列表和目录树的纯计算：路径拆分、紧凑目录树、统计数字缩写。
 *
 * 都是无副作用的纯函数，不碰 DOM 和 React，可以直接单测。
 */

import type { DiffFile } from "../api.ts";

/** 拆出目录前缀和文件名；目录行保留末尾的 `/`，让调用方分清文件和未跟踪目录。 */
export function splitPath(path: string): { dir: string; name: string } {
	const dirSuffix = path.endsWith("/") ? "/" : "";
	const trimmed = dirSuffix ? path.slice(0, -1) : path;
	const slash = trimmed.lastIndexOf("/");
	if (slash < 0) return { dir: "", name: path };
	return {
		dir: trimmed.slice(0, slash + 1),
		name: `${trimmed.slice(slash + 1)}${dirSuffix}`,
	};
}

/** T3 Code 风格的紧凑统计数：万以内写全，上万缩成 `12.3k` 避免把行尾撑歪。 */
export function formatStatCount(value: number): string {
	if (value < 10_000) return String(value);
	if (value < 999_500) {
		const k = value / 1000;
		return `${k < 100 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
	}
	const m = value / 1_000_000;
	return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
}

export interface CompactTreeNode {
	name: string;
	path: string;
	isFile: boolean;
	file?: DiffFile;
	added: number;
	removed: number;
	fileCount: number;
	children: CompactTreeNode[];
}

interface RawNode {
	name: string;
	path: string;
	isFile: boolean;
	file?: DiffFile;
	children: Map<string, RawNode>;
}

/**
 * 构造紧凑目录树：单子目录链折成一层（`packages/builtin/git`），目录排在文件前，每个目录汇总子文件的增删行数。
 */
export function buildCompactTree(files: readonly DiffFile[]): CompactTreeNode {
	const root: RawNode = { name: "", path: "", isFile: false, children: new Map() };
	for (const file of files) {
		const dirOnly = file.path.endsWith("/");
		const segments = file.path.split("/").filter(Boolean);
		let current = root;
		let currentPath = "";
		segments.forEach((segment, index) => {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			if (index === segments.length - 1) {
				const leafName = dirOnly ? `${segment}/` : segment;
				current.children.set(`file:${leafName}`, {
					name: leafName,
					path: file.path,
					isFile: true,
					file,
					children: new Map(),
				});
				return;
			}
			const key = `dir:${segment}`;
			let child = current.children.get(key);
			if (!child) {
				child = { name: segment, path: currentPath, isFile: false, children: new Map() };
				current.children.set(key, child);
			}
			current = child;
		});
	}

	function compact(raw: RawNode, isRoot: boolean): CompactTreeNode {
		if (raw.isFile) {
			return {
				name: raw.name,
				path: raw.path,
				isFile: true,
				file: raw.file,
				added: raw.file?.added ?? 0,
				removed: raw.file?.removed ?? 0,
				fileCount: 1,
				children: [],
			};
		}

		// 压缩单子目录链（根节点本身不参与压缩）。
		let node = raw;
		let label = raw.name;
		if (!isRoot) {
			while (node.children.size === 1) {
				const only = node.children.values().next().value;
				if (!only || only.isFile) break;
				label = `${label}/${only.name}`;
				node = only;
			}
		}

		const children = [...node.children.values()]
			.map((child) => compact(child, false))
			.sort((a, b) => (a.isFile !== b.isFile ? (a.isFile ? 1 : -1) : a.name.localeCompare(b.name)));

		let added = 0;
		let removed = 0;
		let fileCount = 0;
		for (const child of children) {
			added += child.added;
			removed += child.removed;
			fileCount += child.fileCount;
		}

		return {
			name: label,
			path: node.path,
			isFile: false,
			added,
			removed,
			fileCount,
			children,
		};
	}

	return compact(root, true);
}
