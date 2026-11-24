import { Caret, DiffFileItem, DiffStat, Text } from "@plume/ui";
import { Folder, FolderOpen } from "@plume/ui/icons";
import { useMemo, useState } from "react";
import type { DiffFile } from "../api.ts";
import type { DiffLayout } from "./DiffView.tsx";
import { buildCompactTree, type CompactTreeNode } from "./diff-layout.ts";
import { FileDiffBody } from "./FileDiffList.tsx";

/** 改动按目录排成紧凑树（单子目录链自动折成一层）；行和展开的样子和列表视图一致。 */
export function FileDiffTree({
	files,
	cwd = null,
	actions,
	openPaths,
	onTogglePath,
	diffLayout = "unified",
	wrapLines = false,
}: {
	files: DiffFile[];
	cwd?: string | null;
	actions?: (file: DiffFile) => React.ReactNode;
	openPaths?: ReadonlySet<string>;
	onTogglePath?: (path: string) => void;
	diffLayout?: DiffLayout;
	wrapLines?: boolean;
}) {
	const tree = useMemo(() => buildCompactTree(files), [files]);
	// 记的是手动折起来的目录：新出现的目录默认展开，不用在文件列表刷新时重建整套状态。
	const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
	const [localOpen, setLocalOpen] = useState<Set<string>>(() => new Set());
	const openFiles = openPaths ?? localOpen;

	const toggleFolder = (path: string) =>
		setCollapsedFolders((current) => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});

	const toggleFile = (path: string) => {
		if (onTogglePath) {
			onTogglePath(path);
			return;
		}
		setLocalOpen((current) => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	};

	function renderNode(node: CompactTreeNode, depth = 0): React.ReactNode {
		const indent = 12 + depth * 14;
		if (!node.isFile) {
			const isExpanded = !collapsedFolders.has(node.path);
			return (
				<div key={node.path || "root"} className="git-tree-group">
					{node.path && (
						<button
							type="button"
							onClick={() => toggleFolder(node.path)}
							aria-expanded={isExpanded}
							style={{ paddingLeft: `${indent}px` }}
							className="git-tree-folder"
						>
							<Caret open={isExpanded} from="right" size={11} strokeWidth={2} className="git-faint" />
							{isExpanded ? (
								<FolderOpen size={13} strokeWidth={1.75} className="git-folder-open" />
							) : (
								<Folder size={13} strokeWidth={1.75} className="git-folder" />
							)}
							<Text size="detail" tone="muted" weight="medium" className="git-tree-folder-name">
								{node.name}
							</Text>
							<div className="git-tree-folder-meta">
								<DiffStat added={node.added} removed={node.removed} />
								<span className="git-status-spacer" aria-hidden />
							</div>
						</button>
					)}
					{(isExpanded || !node.path) && (
						<div className={node.path ? "git-tree-children" : undefined}>{node.children.map((child) => renderNode(child, node.path ? depth + 1 : depth))}</div>
					)}
				</div>
			);
		}

		const file = node.file as DiffFile;
		const isExpanded = openFiles.has(file.path);
		return (
			<DiffFileItem
				key={file.path}
				file={file}
				open={isExpanded}
				onToggle={() => toggleFile(file.path)}
				actions={actions?.(file)}
				indent={indent}
				showDir={false}
			>
				{isExpanded && <FileDiffBody file={file} cwd={cwd} loadingContent={false} layout={diffLayout} wrap={wrapLines} />}
			</DiffFileItem>
		);
	}

	return <div className="git-tree">{tree.children.map((child) => renderNode(child, 0))}</div>;
}
