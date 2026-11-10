import { iconColour, lookFor, ScrollText, SkeletonBar, Text } from "@plume/ui";
import { ChevronRight } from "@plume/ui/icons";
import { useState } from "react";
import type { DiffFile } from "../api.ts";
import { BinaryDiff } from "./BinaryDiff.tsx";
import { DiffView } from "./DiffView.tsx";
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
}: {
	files: DiffFile[];
	/** 文件在这台机器上的哪个仓库；为空时二进制文件只写名字和大小，画不出图。 */
	cwd?: string | null;
	actions?: (file: DiffFile) => React.ReactNode;
	emptyLabel?: string;
	initiallyOpen?: boolean;
	/** 行是真的，diff 还在读：展开的文件没有 hunk 时画占位，而不是说「没有可以按行比的内容」。 */
	loadingContent?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState<Set<string>>(() => (initiallyOpen ? new Set(files.map((file) => file.path)) : new Set()));

	function toggle(path: string) {
		setOpen((current) => {
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
		<>
			{files.map((file) => {
				const expanded = open.has(file.path);
				const look = lookFor(baseName(file.path), isDirectory(file.path));
				return (
					<div key={file.path} className="git-file">
						{/*
						 * 滚进这个文件的 diff 时文件名钉在顶上：读到三百行深处，问题变成「我在哪个文件里」。
						 * 每个头只在自己的文件里钉，下一个经过时把它推走。不透明的底放在方的外层，圆角压在滚动的 diff 上会露出角。
						 */}
						<div className="git-file-pin">
							<div className="plume-scroll git-file-head">
								<button type="button" data-plume-tip={file.path} onClick={() => toggle(file.path)} aria-expanded={expanded} className="git-file-toggle">
									<ChevronRight size={11} strokeWidth={2.2} className="git-chevron" style={expanded ? { transform: "rotate(90deg)" } : undefined} />
									<look.Icon size={12.5} strokeWidth={1.75} className="git-icon" style={{ color: iconColour(look) }} />
									{/* 目录是分辨两个 `index.ts` 的东西，留着。 */}
									<Text size="detail" tone="muted" className="git-file-path">
										<ScrollText text={file.path} className="git-diff-fill" />
									</Text>
									{/*
									 * 按钮出现时，数字让出行尾，两样错开淡入淡出，见 diff.css 的 `.git-file-stat`。
									 */}
									<Text size="caption" mono numeric className="git-file-stat">
										{file.added > 0 && <span className="git-add">+{file.added}</span>}
										{file.added > 0 && file.removed > 0 && " "}
										{file.removed > 0 && <span className="git-remove">−{file.removed}</span>}
									</Text>
								</button>
								{actions && (
									/* 盖在数字上而不占位置，见 diff.css 的 `.git-file-actions`。 */
									<div className="git-file-actions">{actions(file)}</div>
								)}
							</div>
						</div>

						{/* 不套卡片：每行自己有底色，名字在不透明的条上，再加一圈边是在分开两样本来就分得开的东西。 */}
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
									<DiffView hunks={file.hunks} path={file.path} />
								)}
							</div>
						)}
					</div>
				);
			})}
		</>
	);
}
