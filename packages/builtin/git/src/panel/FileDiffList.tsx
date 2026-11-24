import { Caret, iconColour, lookFor, SkeletonBar, Text } from "@plume/ui";
import { useState } from "react";
import type { DiffFile } from "../api.ts";
import { BinaryDiff } from "./BinaryDiff.tsx";
import { DiffView, type DiffLayout } from "./DiffView.tsx";
import { splitPath } from "./diff-layout.ts";
import { CopyPathButton, DiffStat, FileStatusBadge } from "./file-row.tsx";
import { useT } from "./i18n.ts";
import { baseName } from "./remote.ts";

/** 整个目录都没跟踪时，git 给的是带 `/` 结尾的那一条。 */
function isDirectory(path: string): boolean {
	return path.endsWith("/");
}

/**
 * 改动的文件，一个个展开成自己的 diff。
 *
 * 手风琴而不是列表加查看器：读改动是从上往下读过去，能把两个文件同时开着比按名字跳过去更值；也不要第二栏，
 * 窄面板里照样能用。三个视图共用，只有行尾的按钮不同（`actions`）。
 */
export function FileDiffList({
	files,
	actions,
	emptyLabel,
	initiallyOpen,
	cwd = null,
	loadingContent = false,
	openPaths,
	onTogglePath,
	diffLayout = "unified",
	wrapLines = false,
}: {
	files: DiffFile[];
	/** 文件在这台机器上的哪个仓库；为空时二进制文件只写名字和大小，画不出图。 */
	cwd?: string | null;
	actions?: (file: DiffFile) => React.ReactNode;
	emptyLabel?: string;
	initiallyOpen?: boolean;
	/** 行是真的，diff 还在读：展开的文件没有 hunk 时画占位，而不是说「没有可以按行比的内容」。 */
	loadingContent?: boolean;
	/** 外部受控展开集合；省略时由列表自己记。 */
	openPaths?: ReadonlySet<string>;
	onTogglePath?: (path: string) => void;
	diffLayout?: DiffLayout;
	wrapLines?: boolean;
}) {
	const t = useT();
	const [localOpen, setLocalOpen] = useState<Set<string>>(() => (initiallyOpen ? new Set(files.map((file) => file.path)) : new Set()));
	const open = openPaths ?? localOpen;

	function toggle(path: string) {
		if (onTogglePath) {
			onTogglePath(path);
			return;
		}
		setLocalOpen((current) => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	}

	if (files.length === 0) {
		return (
			<Text as="p" size="label" tone="faint" className="git-files-empty">
				{emptyLabel ?? t("diffList.noMatch")}
			</Text>
		);
	}

	return (
		<div className="git-file-list">
			{files.map((file) => {
				const expanded = open.has(file.path);
				const look = lookFor(baseName(file.path), isDirectory(file.path));
				const { dir, name } = splitPath(file.path);
				return (
					<div key={file.path} className="git-file" data-expanded={expanded ? "true" : undefined}>
						{/*
						 * 滚进这个文件的 diff 时文件名钉在顶上：读到三百行深处，问题变成「我在哪个文件里」。
						 * 每个头只在自己的文件里钉，下一个经过时把它推走。不透明的底放在方的外层，圆角压在滚动的 diff 上会露出角。
						 */}
						<div className="git-file-pin">
							<div className="git-file-head">
								<button type="button" data-plume-tip={file.path} onClick={() => toggle(file.path)} aria-expanded={expanded} className="git-file-toggle">
									<Caret open={expanded} from="right" size={12} strokeWidth={2} className="git-chevron" />
									<look.Icon size={13} strokeWidth={1.75} className="git-icon" style={{ color: iconColour(look) }} />
									{/* 文件名排在前面且满色加微重，目录淡一档跟在后面并先缩：宽窄面板下文件名都对齐同一条左缘。 */}
									<span className="git-file-path">
										<Text
											size="detail"
											tone={file.status === "deleted" ? "muted" : "default"}
											weight="medium"
											className={`git-file-base${file.status === "deleted" ? " git-file-deleted" : ""}`}
										>
											{name}
										</Text>
										{dir && (
											<Text size="caption" tone="faint" className="git-file-dir">
												{dir.endsWith("/") ? dir.slice(0, -1) : dir}
											</Text>
										)}
									</span>
								</button>

								{/* 行内悬停动作放在路径和统计之间：不再用一层半透明灰块把行尾的增删数糊住。 */}
								<div className="git-file-actions">
									<CopyPathButton path={file.path} />
									{actions?.(file)}
								</div>

								<div className="git-file-meta">
									<DiffStat added={file.added} removed={file.removed} />
									<FileStatusBadge status={file.status} />
								</div>
							</div>
						</div>

						{expanded && (
							<div className="git-enter git-file-body">
								{isDirectory(file.path) ? (
									<Text as="p" size="detail" tone="faint" className="git-file-note">
										{t("diffList.untracked")}
									</Text>
								) : file.binary ? (
									<BinaryDiff cwd={cwd} file={file} />
								) : file.hunks.length === 0 && loadingContent ? (
									<div className="git-file-skeleton" aria-hidden>
										<SkeletonBar width="88%" height={10} />
										<SkeletonBar width="64%" height={10} />
										<SkeletonBar width="76%" height={10} />
									</div>
								) : file.hunks.length === 0 ? (
									<Text as="p" size="detail" tone="faint" className="git-file-note">
										{t("diffList.noLineDiff")}
									</Text>
								) : (
									<DiffView hunks={file.hunks} path={file.path} layout={diffLayout} wrap={wrapLines} />
								)}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
