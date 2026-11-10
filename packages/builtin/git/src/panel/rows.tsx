/**
 * 分支页和改动页的几种行：分组标题、一个检出（仓库或工作树）、一个分支。
 */

import { hoverSlot, HoverRow, HoverRowMark, HoverRowReveal, IconButton, ScrollText, Text } from "@plume/ui";
import { ArrowRightLeft, FolderGit2, GitBranch, GitBranchPlus, GitCompare, GitPullRequestArrow, Trash2 } from "@plume/ui/icons";
import type { RepoRef } from "../api.ts";
import { useT } from "./i18n.ts";

/** 两组行之间带名字的分隔。 */
export function GroupHeader({ label, count, actions }: { label: string; count: number; actions?: React.ReactNode }) {
	return (
		<div className="git-group-header">
			<Text size="caption" tone="faint" weight="medium" className="git-fixed">
				{label}
			</Text>
			<Text size="caption" tone="faint" numeric className="git-fixed">
				{count}
			</Text>
			{actions && <div className="git-group-actions">{actions}</div>}
		</div>
	);
}

/** 分支列表里的一个仓库或工作树：图标框和分支行一样宽，分支名跟在文件夹后面。 */
export function CheckoutRow({ entry, cwd, onSelect }: { entry: RepoRef; cwd: string; onSelect: (path: string) => void }) {
	const t = useT();
	const here = entry.path === cwd;
	return (
		<button
			type="button"
			data-plume-tip={entry.path}
			aria-current={here ? "location" : undefined}
			onClick={() => onSelect(entry.path)}
			className="plume-scroll git-checkout-row"
		>
			<HoverRowMark className="git-checkout-mark">
				{entry.worktree ? <GitBranchPlus size={12} strokeWidth={1.8} /> : <FolderGit2 size={12} strokeWidth={1.8} />}
			</HoverRowMark>
			<Text size="label" tone={here ? "accent" : "muted"} className="git-grow">
				<ScrollText text={entry.label} className="plume-fade-tail" />
			</Text>
			<Text size="caption" tone={here ? "accent" : "faint"} className="git-checkout-branch">
				{entry.branch ?? t("sync.detached")}
			</Text>
		</button>
	);
}

/** 一个分支。名字占满整行，按钮盖在上面，悬停时名字的尾巴让出按钮的宽度。 */
export function BranchRow({
	name,
	current,
	busy,
	remote,
	onSwitch,
	onCompare,
	onDelete,
}: {
	name: string;
	current: boolean;
	busy: boolean;
	remote?: boolean;
	onSwitch: () => void;
	onCompare?: () => void;
	onDelete?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const t = useT();
	const actions = current ? 0 : 1 + (onCompare ? 1 : 0) + (onDelete ? 1 : 0);
	// 没有按钮就不让位：当前那一行的「当前」在行内，名字本来就止于它前面。
	const controls = actions === 0 ? "0px" : hoverSlot(actions as 1 | 2 | 3);
	return (
		<HoverRow controls={controls} className="git-branch-row">
			<div className="git-branch-line">
				<HoverRowMark className={current ? "git-mark-accent" : "git-mark-faint"}>
					<GitBranch size={12} strokeWidth={1.8} />
				</HoverRowMark>
				<Text size="label" tone={current ? "default" : "muted"} className="git-grow">
					<ScrollText text={name} className="plume-fade-tail" />
				</Text>
				{current && (
					<Text size="caption" tone="faint" className="git-branch-current">
						{t("branchRow.current")}
					</Text>
				)}
			</div>
			{!current && (
				<HoverRowReveal className="git-gap-2">
					{onCompare && (
						<IconButton
							icon={<GitCompare size={12} strokeWidth={1.9} />}
							label={t("branchRow.compare")}
							size="sm"
							className="git-pointer"
							onClick={onCompare}
						/>
					)}
					{onDelete && (
						<IconButton
							icon={<Trash2 size={12} strokeWidth={1.9} />}
							label={t("branchRow.delete")}
							size="sm"
							tone="danger"
							className="git-pointer"
							onClick={onDelete}
						/>
					)}
					<IconButton
						size="sm"
						icon={remote ? <GitPullRequestArrow size={13} strokeWidth={1.9} /> : <ArrowRightLeft size={13} strokeWidth={1.9} />}
						label={t(remote ? "branchRow.checkoutRemote" : "branchRow.switchTo")}
						disabled={busy}
						className="git-pointer"
						onClick={onSwitch}
					/>
				</HoverRowReveal>
			)}
		</HoverRow>
	);
}
