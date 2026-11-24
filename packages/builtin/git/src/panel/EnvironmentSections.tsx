/**
 * 环境卡片里的版本控制两行（分支切换、Git 快捷操作），直接使用 `@plume/ui` 的 `EnvironmentRow` / `EnvironmentSplitRow`：
 * 1. 分支行：显示当前分支，点开后可搜索、切本地/远端分支、按输入直接创建并切换新分支；
 * 2. Git 操作行：分体按钮，左半一键执行当前推荐操作（提交并推送 / 提交 / 推送 / 发布分支 / 拉取），右半下拉打开提交弹窗、推送、拉取；
 *    非 Git 仓库的项目目录显示「初始化 Git」。
 */

import type { EnvironmentSectionProps } from "@plume/contract/ui";
import {
	ActionSpinner,
	Confirm,
	EnvironmentRow,
	EnvironmentSplitRow,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSearch,
	Popover,
	SkeletonBar,
	Text,
	usePopover,
} from "@plume/ui";
import { Check, CloudDownload, CloudUpload, GitBranch, GitBranchPlus, GitCommitHorizontal, GitFork, Info, Plus } from "@plume/ui/icons";
import { useEffect, useMemo, useState } from "react";
import type { BranchList } from "../api.ts";
import { SESSION_BRANCH_PREFIX } from "../worktree/api.ts";
import { setSwitching, useCheckout } from "./checkout.ts";
import { CommitPushDialog } from "./CommitPushDialog.tsx";
import { useCommitWork } from "./commit-work.ts";
import {
	buildEnvMenuItems,
	hasEnvMenuContent,
	requiresDefaultBranchConfirm,
	resolveEnvQuickAction,
	sanitizeNewBranchName,
	type EnvActionKind,
	type EnvMenuItem,
	type EnvQuickAction,
} from "./env-logic.ts";
import { refreshEnvGit, useSharedRepoStatus } from "./env-state.ts";
import { notify } from "./host.ts";
import { useT } from "./i18n.ts";
import { git, settle } from "./remote.ts";
import { syncPlan } from "./sync-plan.ts";

/** 分支列表按目录留一份最近读到的结果，再次展开时不必先看骨架屏。 */
const lastBranches = new Map<string, BranchList>();

/** 行内成功反馈显示时长（毫秒），之后自动恢复为常态动作行。 */
const INLINE_SUCCESS_MS = 6_000;

function ActionIcon({ kind }: { kind: EnvQuickAction["icon"] | EnvMenuItem["icon"] }) {
	if (kind === "upload") return <CloudUpload size={15} strokeWidth={1.8} />;
	if (kind === "download") return <CloudDownload size={15} strokeWidth={1.8} />;
	if (kind === "info") return <Info size={15} strokeWidth={1.8} />;
	return <GitCommitHorizontal size={15} strokeWidth={1.8} />;
}

function MenuActionIcon({ kind }: { kind: EnvMenuItem["icon"] }) {
	if (kind === "upload") return <CloudUpload size={14} strokeWidth={1.8} />;
	if (kind === "download") return <CloudDownload size={14} strokeWidth={1.8} />;
	return <GitCommitHorizontal size={14} strokeWidth={1.8} />;
}

function anchorWidth(anchor: ReturnType<typeof usePopover>["anchor"]): number | "default" {
	return anchor instanceof HTMLElement && anchor.offsetWidth > 0 ? anchor.offsetWidth : "default";
}

/* ── 1. 分支行 ─────────────────────────────────────────────────── */

export function EnvBranchSection({ session }: EnvironmentSectionProps) {
	const t = useT();
	const cwd = session.summary.cwd || null;
	const checkout = useCheckout(cwd);
	const repo = Boolean(checkout?.repo && !checkout.problem);
	const status = useSharedRepoStatus(cwd, repo, session.summary.running);
	const menu = usePopover();

	if (!cwd || !repo) return null;

	const branch = status?.branch ?? checkout?.branch ?? null;
	const isWorktreeBranch = Boolean(branch && branch.startsWith(SESSION_BRANCH_PREFIX));
	const busy = checkout?.switching ?? false;

	if (isWorktreeBranch && branch) {
		return <EnvironmentRow icon={<GitFork size={15} strokeWidth={1.8} />} title={branch} tip={t("env.worktreeBranchTip", { branch })} data-git-env-branch="" />;
	}

	const displayLabel = branch ?? (status?.head ? `HEAD (${status.head})` : t("sync.detached"));
	const tip =
		branch && status?.upstream
			? status.ahead || status.behind
				? t("composer.branchUpstream", { branch, upstream: status.upstream, ahead: status.ahead, behind: status.behind })
				: t("composer.branchLevel", { branch, upstream: status.upstream })
			: displayLabel;

	return (
		<>
			<EnvironmentSplitRow
				icon={<GitBranch size={15} strokeWidth={1.8} className={busy ? "git-pulse" : undefined} />}
				title={displayLabel}
				tip={busy ? t("composer.switchingBranch") : tip}
				ariaLabel={t("env.branchLabel", { branch: displayLabel })}
				busy={busy}
				disabled={busy}
				open={menu.open}
				onMenuClick={(anchor) => {
					if (menu.open) menu.close();
					else menu.openAt(anchor);
				}}
				data-git-env-branch=""
			/>
			{menu.open && <EnvBranchMenu cwd={cwd} current={branch} anchor={menu.anchor} width={anchorWidth(menu.anchor)} onClose={menu.close} />}
		</>
	);
}

function EnvBranchMenu({
	cwd,
	current,
	anchor,
	width,
	onClose,
}: {
	cwd: string;
	current: string | null;
	anchor: ReturnType<typeof usePopover>["anchor"];
	width: number | "default";
	onClose: () => void;
}) {
	const t = useT();
	const [branches, setBranches] = useState<BranchList | null>(() => lastBranches.get(cwd) ?? null);
	const [query, setQuery] = useState("");

	useEffect(() => {
		let live = true;
		void git()
			.branches(cwd)
			.then(
				(list) => {
					lastBranches.set(cwd, list);
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
	const sanitizedNew = sanitizeNewBranchName(query);
	const exactMatch = sanitizedNew.length > 0 && Boolean(branches && (branches.local.includes(sanitizedNew) || branches.remote.includes(sanitizedNew)));
	const canCreate = sanitizedNew.length > 0 && !exactMatch;

	async function switchTo(target: string) {
		onClose();
		setSwitching(cwd, true);
		try {
			const result = await settle(git().switchBranch(cwd, target));
			if (!result.ok) {
				notify(result.error ?? t("branchMenu.switchFailed"), "error");
				return;
			}
			await refreshEnvGit(cwd);
		} finally {
			setSwitching(cwd, false);
		}
	}

	async function createAndSwitch(name: string) {
		onClose();
		setSwitching(cwd, true);
		try {
			const result = await settle(git().createBranch(cwd, name, null));
			if (!result.ok) {
				notify(result.error ?? t("commit.branchCreateFailed"), "error");
				return;
			}
			await refreshEnvGit(cwd);
		} finally {
			setSwitching(cwd, false);
		}
	}

	return (
		<Popover
			anchor={anchor}
			onClose={onClose}
			placement="bottom"
			align="start"
			width={width}
			maxHeight={MENU_MAX_HEIGHT}
			label={t("branchMenu.title")}
			header={<MenuSearch value={query} onChange={setQuery} placeholder={t("branchMenu.search")} />}
		>
			<MenuBody>
				{!branches &&
					[0, 1, 2, 3].map((index) => (
						<div key={index} className="git-env-skeleton" aria-hidden>
							<SkeletonBar width={`${60 - index * 8}%`} height={11} />
						</div>
					))}
				{branches && local.length === 0 && remote.length === 0 && !canCreate && (
					<Text as="p" size="detail" tone="faint" className="git-chip-menu-empty">
						{t(branches.local.length === 0 ? "branchMenu.notARepo" : "branchMenu.noMatch")}
					</Text>
				)}
				{local.map((name) => {
					const isCurrent = name === current;
					return (
						<MenuItem key={name} title={name} selected={isCurrent} hint={isCurrent ? t("branchRow.current") : undefined} onClick={() => void switchTo(name)}>
							{name}
						</MenuItem>
					);
				})}
				{remote.length > 0 && (
					<>
						{local.length > 0 && <MenuLabel>{t("common.remote")}</MenuLabel>}
						{remote.map((name) => (
							<MenuItem key={name} title={name} hint={t("common.remote")} onClick={() => void switchTo(name)}>
								{name}
							</MenuItem>
						))}
					</>
				)}
				{canCreate && (
					<MenuItem icon={<Plus size={14} strokeWidth={1.9} />} onClick={() => void createAndSwitch(sanitizedNew)}>
						{t("env.createBranch", { name: sanitizedNew })}
					</MenuItem>
				)}
			</MenuBody>
		</Popover>
	);
}

/* ── 2. Git 操作行 ─────────────────────────────────────────────── */

interface PendingDefaultConfirm {
	action: "commit_push" | "push" | "publish";
	branch: string;
	includesCommit: boolean;
}

export function EnvGitActionsSection({ session }: EnvironmentSectionProps) {
	const t = useT();
	const projectId = session.summary.project;
	const cwd = session.summary.cwd || null;
	const checkout = useCheckout(cwd);
	const repo = Boolean(checkout?.repo && !checkout.problem);
	const status = useSharedRepoStatus(cwd, repo, session.summary.running);
	const menu = usePopover();

	const [initializing, setInitializing] = useState(false);
	const [progressLabel, setProgressLabel] = useState<string | null>(null);
	const [inlineSuccess, setInlineSuccess] = useState<string | null>(null);
	const [commitDialogOpen, setCommitDialogOpen] = useState(false);
	const [confirmDefault, setConfirmDefault] = useState<PendingDefaultConfirm | null>(null);
	const commitWork = useCommitWork(cwd);

	// 换目录时清掉上一个仓库的短暂反馈与确认态。
	useEffect(() => {
		setInlineSuccess(null);
		setConfirmDefault(null);
		setCommitDialogOpen(false);
	}, [cwd]);

	useEffect(() => {
		if (!inlineSuccess) return;
		const timer = setTimeout(() => setInlineSuccess(null), INLINE_SUCCESS_MS);
		return () => clearTimeout(timer);
	}, [inlineSuccess]);

	const busy = progressLabel !== null || commitWork.active;
	const quick = useMemo(() => resolveEnvQuickAction(status, busy, t), [status, busy, t]);
	const menuItems = useMemo(() => buildEnvMenuItems(status, busy, t), [status, busy, t]);
	const hasMenu = useMemo(() => hasEnvMenuContent(status, menuItems), [status, menuItems]);
	const plan = useMemo(() => syncPlan(status, t), [status, t]);

	if (!cwd || !checkout || checkout.problem) return null;

	// 非 Git 仓库的项目目录：仅在属于项目时提供一键初始化 Git，避免在无项目草稿目录提议初始化。
	if (!checkout.repo) {
		if (!projectId) return null;
		const initRepo = () => {
			setInitializing(true);
			void settle(git().init(cwd))
				.then(async (result) => {
					if (!result.ok) {
						notify(result.error ?? t("common.actionFailed"), "error");
						return;
					}
					await refreshEnvGit(cwd);
				})
				.finally(() => setInitializing(false));
		};
		return (
			<EnvironmentRow
				icon={initializing ? <ActionSpinner size={14} /> : <GitBranchPlus size={15} strokeWidth={1.8} />}
				title={initializing ? t("env.initializing") : t("env.initGit")}
				onClick={initializing ? undefined : initRepo}
				data-git-env-init=""
			/>
		);
	}

	const executeAction = async (action: EnvActionKind) => {
		if (busy) return;
		setInlineSuccess(null);

		if (action === "pull") {
			setProgressLabel(t("env.pulling"));
			try {
				const result = await settle(git().pull(cwd));
				if (!result.ok) {
					if (!("cancelled" in result && result.cancelled)) notify(result.error ?? t("common.actionFailed"), "error");
					return;
				}
				await refreshEnvGit(cwd);
				setInlineSuccess(t("env.pulled"));
			} finally {
				setProgressLabel(null);
			}
			return;
		}

		if (action === "push" || action === "publish") {
			setProgressLabel(action === "publish" ? t("env.publishing") : t("env.pushing"));
			try {
				const result = await settle(git().push(cwd));
				if (!result.ok) {
					if (!("cancelled" in result && result.cancelled)) notify(result.error ?? t("common.actionFailed"), "error");
					return;
				}
				await refreshEnvGit(cwd);
				setInlineSuccess(action === "publish" ? t("env.published") : t("env.pushed"));
			} finally {
				setProgressLabel(null);
			}
			return;
		}

		// commit / commit_push：自动暂存未暂存改动 → 生成提交说明 → 提交 →（可选）推送。
		try {
			const current = await git().status(cwd);
			if (current.unstaged.length > 0) {
				const stageResult = await settle(
					git().stage(
						cwd,
						current.unstaged.map((file) => file.path),
					),
				);
				if (!stageResult.ok) {
					notify(stageResult.error ?? t("common.actionFailed"), "error");
					return;
				}
			}
			setProgressLabel(t("commit.generating"));
			const generated = await settle(git().generateCommitMessage(cwd));
			const message = "message" in generated ? generated.message : undefined;
			if (!generated.ok || !message) {
				notify(generated.error ?? t("commit.generateFailed"), "error");
				// 模型没配好或生成失败时打开提交弹窗，让人手写提交说明完成操作。
				setCommitDialogOpen(true);
				return;
			}
			setProgressLabel(t("commit.committing"));
			const commitResult = await settle(git().commitStaged(cwd, message));
			if (!commitResult.ok) {
				notify(commitResult.error ?? t("common.actionFailed"), "error");
				await refreshEnvGit(cwd);
				return;
			}
			if (action === "commit_push") {
				setProgressLabel(t("env.pushing"));
				const pushResult = await settle(git().push(cwd));
				if (!pushResult.ok) {
					if (!("cancelled" in pushResult && pushResult.cancelled)) notify(pushResult.error ?? t("common.actionFailed"), "error");
					await refreshEnvGit(cwd);
					return;
				}
			}
			await refreshEnvGit(cwd);
			setInlineSuccess(action === "commit_push" ? t("env.committedAndPushed") : t("env.committed"));
		} finally {
			setProgressLabel(null);
		}
	};

	const triggerAction = (action: EnvActionKind) => {
		if (requiresDefaultBranchConfirm(action, Boolean(status?.isDefaultBranch)) && status?.branch) {
			setConfirmDefault({
				action,
				branch: status.branch,
				includesCommit: action === "commit_push",
			});
			return;
		}
		void executeAction(action);
	};

	const handleMenuItem = (item: EnvMenuItem) => {
		if (item.disabled) return;
		menu.close();
		if (item.id === "commit") {
			setCommitDialogOpen(true);
			return;
		}
		triggerAction(item.action);
	};

	const toggleMenu = (anchor: HTMLElement) => {
		if (menu.open) {
			menu.close();
			return;
		}
		void refreshEnvGit(cwd);
		menu.openAt(anchor);
	};

	const isDetached = status?.remoteState === "detached";
	const isCleanAndBehind = status !== null && status.staged.length === 0 && status.unstaged.length === 0 && status.behind > 0 && status.ahead === 0;
	const neverPublished = status?.remoteState === "no-upstream" && status.remote !== null && status.unpushed === null;

	return (
		<>
			<EnvironmentSplitRow
				icon={
					progressLabel ? (
						<ActionSpinner size={14} />
					) : inlineSuccess ? (
						<Check size={15} strokeWidth={2} className="git-ok" />
					) : (
						<ActionIcon kind={quick.icon} />
					)
				}
				title={progressLabel ?? inlineSuccess ?? quick.label}
				tip={progressLabel || inlineSuccess ? undefined : quick.tip}
				ariaLabel={t("env.sectionActions")}
				disabled={!progressLabel && !inlineSuccess && quick.disabled}
				working={Boolean(progressLabel)}
				feedback={Boolean(inlineSuccess)}
				open={menu.open}
				onClick={() => {
					if (quick.disabled || !quick.action) return;
					triggerAction(quick.action);
				}}
				onMenuClick={toggleMenu}
				menuLabel={t("env.gitActionOptions")}
				menuDisabled={busy || !hasMenu}
				hideMenu={Boolean(progressLabel)}
				onPointerEnter={hasMenu ? undefined : () => void refreshEnvGit(cwd)}
				data-git-env-actions=""
			/>

			{menu.open && (
				<Popover
					anchor={menu.anchor}
					onClose={menu.close}
					placement="bottom"
					align="end"
					width={anchorWidth(menu.anchor)}
					maxHeight={MENU_MAX_HEIGHT}
					label={t("env.gitActionOptions")}
				>
					<MenuBody insetIcons>
						{menuItems.map((item) => (
							<MenuItem
								key={item.id}
								icon={<MenuActionIcon kind={item.icon} />}
								disabled={item.disabled}
								title={item.disabledReason ?? undefined}
								onClick={() => handleMenuItem(item)}
							>
								{item.label}
							</MenuItem>
						))}
						{isDetached && (
							<Text as="p" size="caption" className="git-env-menu-notice">
								{t("env.detachedNotice")}
							</Text>
						)}
						{isCleanAndBehind && (
							<Text as="p" size="caption" className="git-env-menu-notice">
								{t("env.behindNotice")}
							</Text>
						)}
					</MenuBody>
				</Popover>
			)}

			{confirmDefault && (
				<Confirm
					tone="normal"
					title={confirmDefault.includesCommit ? t("env.confirmCommitPushTitle") : t("env.confirmPushTitle")}
					detail={
						confirmDefault.includesCommit
							? t("env.confirmCommitPushDesc", { branch: confirmDefault.branch })
							: t("env.confirmPushDesc", { branch: confirmDefault.branch })
					}
					confirmLabel={confirmDefault.includesCommit ? t("env.confirmCommitPushRun") : t("env.confirmPushRun", { branch: confirmDefault.branch })}
					cancelLabel={t("common.cancel")}
					alternate={
						confirmDefault.includesCommit
							? {
									label: t("env.commitOnNewBranch"),
									onConfirm: () => {
										setConfirmDefault(null);
										commitWork.setTarget({ kind: "new", name: "" });
										setCommitDialogOpen(true);
									},
								}
							: undefined
					}
					onCancel={() => setConfirmDefault(null)}
					onConfirm={() => {
						const pending = confirmDefault.action;
						setConfirmDefault(null);
						void executeAction(pending);
					}}
				/>
			)}

			{commitDialogOpen && (
				<CommitPushDialog
					cwd={cwd}
					branch={status?.branch ?? plan.branch}
					stagedCount={status?.staged.length ?? 0}
					unstagedCount={status?.unstaged.length ?? 0}
					addedCount={status?.unstaged.reduce((sum, file) => sum + file.added, 0) ?? 0}
					removedCount={status?.unstaged.reduce((sum, file) => sum + file.removed, 0) ?? 0}
					busy={progressLabel !== null}
					running={progressLabel !== null}
					work={commitWork}
					unpushed={plan.push.count ?? 0}
					publish={neverPublished && !plan.push.disabled}
					pushTip={plan.push.tip}
					canPush={status?.remoteState !== "none" && status?.remoteState !== "detached" && status?.remoteState !== "in-progress"}
					onClose={() => setCommitDialogOpen(false)}
					onBranchChanged={() => void refreshEnvGit(cwd)}
					onCommit={async (message) => {
						const result = await settle(git().commitStaged(cwd, message));
						if (!result.ok) {
							notify(result.error ?? t("common.actionFailed"), "error");
							return false;
						}
						await refreshEnvGit(cwd);
						setInlineSuccess(t("env.committed"));
						return true;
					}}
					onCommitAndPush={async (message, includeUnstaged) => {
						if (includeUnstaged) {
							const current = await git().status(cwd);
							const paths = current.unstaged.map((file) => file.path);
							if (paths.length > 0) await git().stage(cwd, paths);
						}
						const committed = await settle(git().commitStaged(cwd, message));
						if (!committed.ok) {
							notify(committed.error ?? t("common.actionFailed"), "error");
							return false;
						}
						setProgressLabel(t("env.pushing"));
						try {
							const pushed = await settle(git().push(cwd));
							if (!pushed.ok && !("cancelled" in pushed && pushed.cancelled)) {
								notify(pushed.error ?? t("common.actionFailed"), "error");
								await refreshEnvGit(cwd);
								return true;
							}
							await refreshEnvGit(cwd);
							setInlineSuccess(t("env.committedAndPushed"));
							return true;
						} finally {
							setProgressLabel(null);
						}
					}}
					onPush={async () => {
						await executeAction(neverPublished ? "publish" : "push");
					}}
				/>
			)}
		</>
	);
}
