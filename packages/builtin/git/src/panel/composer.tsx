/**
 * 输入框上方那一排里属于 git 的两样：项目旁边的分支签（点开切分支），右边没提交的改动有多少（点开 Git 面板）。
 *
 * 发送前看的是项目和分支，发送后看的是改了多少，问的是同一件事的两个时刻，所以和项目签挤在同一行。
 */

import type { ComposerChipProps } from "@plume/contract/ui";
import {
	CountUp,
	IconButton,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSearch,
	Popover,
	ScrollText,
	Text,
	useLiveRefresh,
	usePopover,
	useRolled,
} from "@plume/ui";
import { Check, ChevronDown, GitBranch, GitCommitVertical } from "@plume/ui/icons";
import { useCallback, useEffect, useState } from "react";
import type { BranchList, WorkspaceStat } from "../api.ts";
import { noteBranch, readCheckout, setSwitching, useCheckout } from "./checkout.ts";
import { notify, openGitPanel } from "./host.ts";
import { useT } from "./i18n.ts";
import { git, settle } from "./remote.ts";
import { SESSION_BRANCH_PREFIX } from "../worktree/api.ts";
import { useUpstreamDistance } from "./upstream-distance.ts";

/** `↑3 ↓1`：这边有、那边没有的提交数，和反过来的。没什么可说时什么都不画。 */
function DistanceMarks({ ahead, behind }: { ahead: number; behind: number }) {
	if (!ahead && !behind) return null;
	return (
		<Text size="caption" tone="faint" numeric className="git-chip-marks">
			{ahead > 0 && <span>↑{ahead}</span>}
			{behind > 0 && <span>↓{behind}</span>}
		</Text>
	);
}

/**
 * 分支签。切换期间名字不动，图标闪着说「在切」。
 *
 * 提前把目标分支名写上去读着顺，直到 git 拒绝：签上说了一件没发生的事再收回去。切换常被拒，原因也平常
 * （没提交的改动挡着、远端分支不能按那个名字检出），留着旧名字闪动对两种结果都是真话，也当场回应了点击。
 */
export function BranchChip({ cwd, running }: ComposerChipProps) {
	const t = useT();
	const checkout = useCheckout(cwd ?? null);
	const menu = usePopover();
	const branch = checkout?.repo ? checkout.branch : null;
	const upstream = useUpstreamDistance(branch && cwd ? cwd : null, branch, running);
	const label = branch ?? "";
	const rolls = useRolled(label);
	/*
	 * 给对话开的工作树（`worktree/`）：分支就是这个对话本身，由工作树签来说（对着基分支领先落后），
	 * 这里不画，也不给切——在里面检出别的分支，对话的活就落到它看不见的地方。
	 */
	if (!cwd || !branch || branch.startsWith(SESSION_BRANCH_PREFIX)) return null;
	const busy = checkout?.switching ?? false;
	// 对着上游，按上次获取时的样子：推送会送出去什么，拉取会带回来什么。
	const tip = !upstream
		? branch
		: upstream.ahead || upstream.behind
			? t("composer.branchUpstream", { branch, upstream: upstream.upstream, ahead: upstream.ahead, behind: upstream.behind })
			: t("composer.branchLevel", { branch, upstream: upstream.upstream });
	return (
		<>
			{/* 字号挂在外面这一层：签本身是按钮，`Text` 渲染不成按钮。 */}
			<Text size="label" className="git-chip-slot">
				<button
					type="button"
					data-plume-tip={busy ? t("composer.switchingBranch") : tip}
					aria-haspopup="menu"
					aria-expanded={menu.open}
					aria-busy={busy || undefined}
					onClick={menu.toggle}
					className="plume-composer-control plume-scroll git-chip"
				>
					<span className="git-chip-icon">
						<GitBranch size={16} strokeWidth={1.8} className={busy ? "git-pulse" : undefined} />
					</span>
					{/* 按名字重挂：换了分支，新名字滚进来。 */}
					<ScrollText key={label} text={label} className={`git-chip-name ${rolls ? "plume-roll" : ""}`} />
					{upstream && <DistanceMarks ahead={upstream.ahead} behind={upstream.behind} />}
					<ChevronDown size={14} className="git-chip-icon" aria-hidden />
				</button>
			</Text>
			{menu.open && <BranchMenu cwd={cwd} current={branch} anchor={menu.anchor} onClose={menu.close} />}
		</>
	);
}

/**
 * 上次看到的列表，再打开菜单时不用从空的开始。不存盘：分支会变，读到新的就换掉。
 */
const lastSeen = new Map<string, BranchList>();

type Anchor = ReturnType<typeof usePopover>["anchor"];

/**
 * 分支签的切换菜单。
 *
 * 会弄丢工作区的检出由 git 拒绝而不是强制，git 自己的话说清了是哪些文件挡着，原样报出来。
 */
function BranchMenu({ cwd, current, anchor, onClose }: { cwd: string; current: string; anchor: Anchor; onClose: () => void }) {
	const t = useT();
	const [branches, setBranches] = useState<BranchList | null>(() => lastSeen.get(cwd) ?? null);
	const [query, setQuery] = useState("");

	useEffect(() => {
		let live = true;
		void git()
			.branches(cwd)
			.then(
				(list) => {
					lastSeen.set(cwd, list);
					if (live) setBranches(list);
				},
				() => {},
			);
		return () => {
			live = false;
		};
	}, [cwd]);

	const needle = query.trim().toLowerCase();
	const match = (name: string) => !needle || name.toLowerCase().includes(needle);
	const local = (branches?.local ?? []).filter(match);
	const remote = (branches?.remote ?? []).filter(match);

	/*
	 * 先关菜单再切，而且从不显示 git 还没确认的名字。
	 *
	 * 远端分支原样交过去（带着 `origin/`）：要不要 `--track` 由逻辑入口按本地有没有同名分支决定，它要的正是远端的写法。
	 */
	async function switchTo(target: string) {
		onClose();
		setSwitching(cwd, true);
		try {
			const result = await settle(git().switchBranch(cwd, target));
			if (!result.ok) {
				notify(result.error ?? t("branchMenu.switchFailed"), "error");
				return;
			}
			await readCheckout(cwd);
		} finally {
			setSwitching(cwd, false);
		}
	}

	return (
		<Popover
			anchor={anchor}
			onClose={onClose}
			placement="top"
			align="start"
			width="wide"
			maxHeight={MENU_MAX_HEIGHT}
			label={t("branchMenu.title")}
			header={<MenuSearch value={query} onChange={setQuery} placeholder={t("branchMenu.search")} />}
		>
			<MenuBody>
				{/* 占住要来的行的形状：一行「读取分支…」换成十行，菜单会先停一下再猛地撑开。 */}
				{!branches &&
					[0, 1, 2, 3, 4].map((i) => (
						<div key={i} className="git-chip-skeleton">
							<span className="git-pulse git-chip-skeleton-icon" />
							<span className="git-pulse git-chip-skeleton-bar" style={{ width: `${58 - i * 7}%` }} />
						</div>
					))}
				{branches && local.length === 0 && remote.length === 0 && (
					<Text as="p" size="detail" tone="faint" className="git-chip-menu-empty">
						{t(branches.local.length === 0 ? "branchMenu.notARepo" : "branchMenu.noMatch")}
					</Text>
				)}
				{local.map((name) => (
					// 勾打在签上显示的分支上，不是菜单打开时读到的那份：切过去之后它当场就对。
					<BranchItem key={name} name={name} current={name === current} onSelect={() => void switchTo(name)} />
				))}
				{remote.length > 0 && (
					<>
						<MenuLabel>{t("common.remote")}</MenuLabel>
						{remote.map((name) => (
							<BranchItem key={name} name={name} onSelect={() => void switchTo(name)} />
						))}
					</>
				)}
			</MenuBody>
		</Popover>
	);
}

function BranchItem({ name, current, onSelect }: { name: string; current?: boolean; onSelect: () => void }) {
	return (
		<MenuItem
			icon={<GitBranch size={13} strokeWidth={1.8} />}
			title={name}
			selected={current}
			trailing={current ? <Check size={13} strokeWidth={2.2} /> : undefined}
			onClick={onSelect}
		>
			<Text size="detail" mono className="git-chip-menu-name">
				<ScrollText text={name} />
			</Text>
		</MenuItem>
	);
}

/**
 * 有多少没提交，一直在眼前。
 *
 * agent 改文件时最该盯着、也最容易忘掉的，是积了多少还没看过。要开面板才知道就成了要去问的事，摆在这里是会注意到的事。
 * 两样都打开 Git 面板而不是在这里动手：看和提交是一个动作，应该在同一个能把两样都摆出来的地方。
 */
export function ChangeBar({ cwd, running }: ComposerChipProps) {
	const t = useT();
	const checkout = useCheckout(cwd ?? null);
	const repo = checkout?.repo ?? false;
	const [stat, setStat] = useState<WorkspaceStat | null>(null);

	const refresh = useCallback(async () => {
		if (!cwd || !repo) {
			setStat(null);
			// 还不是仓库的目录也跟着问：终端里、agent、面板上的 `git init` 之后，分支签和这里才会出现。
			if (cwd) void readCheckout(cwd);
			return;
		}
		let next: WorkspaceStat;
		try {
			next = await git().stat(cwd);
		} catch {
			return;
		}
		setStat(next);
		// 分支签对菜单以外的检出（agent 的 `git switch -c`、终端里的切换）只能从这里听说：每次读数都顺带回答了。
		noteBranch(cwd, next.branch);
	}, [cwd, repo]);

	useLiveRefresh(refresh, running);

	if (!stat || stat.files === 0) return null;
	return (
		<>
			<Text size="detail" mono className="git-changes-slot">
				<button
					type="button"
					data-plume-tip={t("changeBar.uncommitted", { n: stat.files })}
					onClick={openGitPanel}
					className="plume-composer-control plume-scroll git-changes"
				>
					{/* 走过去，不是跳过去：一次跳三十的数读起来像故障，走动才读得出是在数。 */}
					<CountUp value={stat.added} className="git-changes-added" format={(shown) => `+${Math.round(shown).toLocaleString()}`} />
					<CountUp value={stat.removed} className="git-changes-removed" format={(shown) => `−${Math.round(shown).toLocaleString()}`} />
				</button>
			</Text>
			<IconButton label={t("changeBar.openGit")} onClick={openGitPanel} icon={<GitCommitVertical size={13} strokeWidth={1.8} className="git-changes-icon" />} />
		</>
	);
}
