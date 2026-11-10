import { Caret, iconColour, lookFor, Text } from "@plume/ui";
import { ChevronRight, Folder, FolderOpen } from "@plume/ui/icons";
import { useMemo, useState } from "react";
import type { DiffFile } from "../api.ts";
import { BinaryDiff } from "./BinaryDiff.tsx";
import { DiffView } from "./DiffView.tsx";
import { useT } from "./i18n.ts";

interface TreeNode {
	name: string;
	path: string;
	isFile: boolean;
	file?: DiffFile;
	children: Record<string, TreeNode>;
}

function buildTree(files: DiffFile[]): TreeNode {
	const root: TreeNode = { name: "", path: "", isFile: false, children: {} };
	for (const file of files) {
		const segments = file.path.split("/").filter(Boolean);
		let current = root;
		let currentPath = "";
		segments.forEach((segment, i) => {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			if (i === segments.length - 1) {
				current.children[segment] = { name: segment, path: file.path, isFile: true, file, children: {} };
				return;
			}
			current.children[segment] ??= { name: segment, path: currentPath, isFile: false, children: {} };
			current = current.children[segment];
		});
	}
	return root;
}

/** 改动按目录排成树；行和展开的样子和列表视图一样。 */
export function FileDiffTree({ files, cwd = null, actions }: { files: DiffFile[]; cwd?: string | null; actions?: (file: DiffFile) => React.ReactNode }) {
	const t = useT();
	const tree = useMemo(() => buildTree(files), [files]);
	// 默认每一层目录都展开。
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
		const set = new Set<string>();
		const collect = (node: TreeNode) => {
			if (!node.isFile && node.path) set.add(node.path);
			for (const child of Object.values(node.children)) collect(child);
		};
		collect(tree);
		return set;
	});
	const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());

	const flip = (set: (update: (current: Set<string>) => Set<string>) => void, path: string) =>
		set((current) => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});

	function renderNode(node: TreeNode, depth = 0): React.ReactNode {
		if (!node.isFile) {
			const isExpanded = expandedFolders.has(node.path);
			// 目录在前，文件在后。
			const childNodes = Object.values(node.children).sort((a, b) => (a.isFile !== b.isFile ? (a.isFile ? 1 : -1) : a.name.localeCompare(b.name)));
			return (
				<div key={node.path || "root"}>
					{node.path && (
						<button
							type="button"
							onClick={() => flip(setExpandedFolders, node.path)}
							style={{ paddingLeft: `${Math.max(4, depth * 14)}px` }}
							className="git-tree-folder"
						>
							<Caret open={isExpanded} from="right" size={11} strokeWidth={2} className="git-faint" />
							{isExpanded ? (
								<FolderOpen size={13} strokeWidth={1.8} className="git-folder-open" />
							) : (
								<Folder size={13} strokeWidth={1.8} className="git-folder" />
							)}
							<Text size="detail" tone="muted" weight="medium" className="git-tree-folder-name">
								{node.name}
							</Text>
						</button>
					)}
					{(isExpanded || !node.path) && <div>{childNodes.map((child) => renderNode(child, node.path ? depth + 1 : depth))}</div>}
				</div>
			);
		}

		const file = node.file as DiffFile;
		const isExpanded = openFiles.has(file.path);
		const look = lookFor(node.name, false);
		return (
			<div key={file.path} className="git-file">
				<div style={{ paddingLeft: `${Math.max(4, depth * 14)}px` }} className="git-file-head">
					<button type="button" onClick={() => flip(setOpenFiles, file.path)} className="git-tree-toggle">
						<ChevronRight size={11} strokeWidth={2.2} className="git-chevron" style={isExpanded ? { transform: "rotate(90deg)" } : undefined} />
						<look.Icon size={12.5} strokeWidth={1.75} className="git-icon" style={{ color: iconColour(look) }} />
						<Text size="detail" className="git-tree-file-name">
							{node.name}
						</Text>
						{/* 让位的时序和列表视图一样，见 `FileDiffList`。 */}
						<Text size="caption" mono numeric className="git-file-stat">
							{file.added > 0 && <span className="git-add">+{file.added}</span>}
							{file.added > 0 && file.removed > 0 && " "}
							{file.removed > 0 && <span className="git-remove">−{file.removed}</span>}
						</Text>
					</button>
					{actions && <div className="git-file-actions">{actions(file)}</div>}
				</div>

				{isExpanded && (
					<div className="git-enter git-file-body">
						{file.binary ? (
							<BinaryDiff cwd={cwd} file={file} />
						) : file.hunks.length === 0 ? (
							<Text as="p" size="detail" tone="faint" className="git-file-note">
								{t("diffList.noLineDiff")}
							</Text>
						) : (
							<DiffView hunks={file.hunks} path={file.path} />
						)}
					</div>
				)}
			</div>
		);
	}

	return <div className="git-tree">{Object.values(tree.children).map((child) => renderNode(child, 0))}</div>;
}
