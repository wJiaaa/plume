/**
 * 提交与推送弹窗：使用产品统一的 `Dialog` + `DialogAction` 外框与右对齐按钮栏。
 *
 * - **留空就生成**：提交时空着就先让模型写一句，写回输入框——人看得见自己提交的是什么。
 * - **提交到哪个分支**也在这里选：选了新分支不当场创建，名字先记着，真提交那一刻才 `git switch -c`，
 *   中途改主意仓库里不会留下空分支。
 * - 写了什么、哪一步在跑，不存在这里（见 `commit-work.ts`）：关掉弹窗只是收起样子，事还在跑。
 */

import {
	ActionSpinner,
	Button,
	ChoiceMark,
	Dialog,
	DialogAction,
	IconButton,
	Input,
	MenuBody,
	MenuItem,
	MenuLabel,
	OverlayScrollbar,
	Popover,
	Text,
	Textarea,
	useFieldFade,
	usePopover,
} from "@plume/ui";
import { Check, ChevronDown, GitBranch, GitCommitHorizontal, Languages, Plus, X } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import { COMMIT_LANGUAGES, commitLanguageLabel, resolveCommitLanguage } from "./commit-language.ts";
import type { CommitWork } from "./commit-work.ts";
import { notify } from "./host.ts";
import { useT } from "./i18n.ts";
import { git, settle } from "./remote.ts";

/** `Dialog` 交给动作和内容的关闭函数：播完退场再调 `after`。 */
type Dismiss = (after?: () => void) => void;

export interface CommitPushDialogProps {
	cwd: string;
	branch: string;
	stagedCount: number;
	unstagedCount: number;
	addedCount: number;
	removedCount: number;
	busy: boolean;
	running: boolean;
	/** 这一次提交的现场，归调用方持有，见 `commit-work.ts`。 */
	work: CommitWork;
	/** 还没推上去的提交数：没有可推的就禁用推送按钮。 */
	unpushed: number;
	/** 远端从没见过这个分支：推送即为发布。 */
	publish: boolean;
	/** 同步计划写好的那句话：几个提交没推，或者已经同步。 */
	pushTip: string;
	/** 当前是否具备推送条件（无远端或游离 HEAD 时隐藏「提交并推送」）。默认 true。 */
	canPush?: boolean;
	onClose: () => void;
	onCommit: (message: string) => Promise<boolean>;
	onCommitAndPush: (message: string, includeUnstaged: boolean) => Promise<boolean>;
	onPush: () => Promise<void>;
	/** 分支换了，外面那份状态要重读。 */
	onBranchChanged?: () => void;
}

export function CommitPushDialog({
	cwd,
	branch,
	stagedCount,
	unstagedCount,
	addedCount,
	removedCount,
	busy,
	running,
	work,
	unpushed,
	publish,
	pushTip,
	canPush = true,
	onClose,
	onCommit,
	onCommitAndPush,
	onPush,
	onBranchChanged,
}: CommitPushDialogProps) {
	const t = useT();
	const { message, setMessage, generating, setGenerating, target, setTarget } = work;
	const workingAction = work.action;
	const setWorkingAction = work.setAction;
	const [includeUnstaged, setIncludeUnstaged] = useState(stagedCount === 0 && unstagedCount > 0);
	const [locals, setLocals] = useState<string[]>([]);
	const [language, setLanguageState] = useState<string | null>(null);
	const newBranchField = useRef<HTMLInputElement>(null);
	const messageField = useRef<HTMLTextAreaElement>(null);
	const messageScroller = useRef<HTMLDivElement>(null);
	useFieldFade(messageField, messageScroller);

	const languageMenu = usePopover();
	const branchMenu = usePopover();
	const resolvedLanguage = resolveCommitLanguage(language);

	useEffect(() => {
		if (stagedCount === 0 && unstagedCount > 0) setIncludeUnstaged(true);
	}, [stagedCount, unstagedCount]);

	// 本地分支和提交说明的语言，开弹窗时读一次。分支读不到就只剩「当前分支」和「新分支」两项，仍然能用。
	useEffect(() => {
		let live = true;
		git()
			.branches(cwd)
			.then((list) => live && setLocals(list.local))
			.catch(() => {});
		git()
			.commitLanguage()
			.then((id) => live && setLanguageState(id))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [cwd]);

	// 选了「新分支」就把光标送过去。
	useEffect(() => {
		if (target.kind === "new") newBranchField.current?.focus();
	}, [target.kind]);

	function setLanguage(id: string) {
		setLanguageState(id);
		void git()
			.setCommitLanguage(id)
			.catch(() => {});
		languageMenu.close();
	}

	/** 人写的那句话，没写就现生成一句并写回输入框；返回 null 是这一次别往下走了（失败已经报过）。 */
	async function withMessage(): Promise<string | null> {
		const trimmed = message.trim();
		if (trimmed) return trimmed;
		setGenerating(true);
		try {
			const result = await settle(git().generateCommitMessage(cwd));
			const written = "message" in result ? result.message : undefined;
			if (!result.ok || !written) {
				notify(result.error ?? t("commit.generateFailed"), "error");
				return null;
			}
			setMessage(written);
			return written;
		} finally {
			setGenerating(false);
		}
	}

	/** 要提交到别处，先把分支换过去；换失败这次提交就不往下走，否则提交到了人没选的分支上。 */
	async function moveToTarget(): Promise<boolean> {
		if (target.kind === "current") return true;
		const name = target.name.trim();
		if (!name) {
			notify(t("commit.branchNameEmpty"), "error");
			return false;
		}
		const result = await settle(git().createBranch(cwd, name, null));
		if (!result.ok) {
			notify(result.error ?? t("commit.branchCreateFailed"), "error");
			return false;
		}
		setTarget({ kind: "current" });
		onBranchChanged?.();
		return true;
	}

	async function switchTo(name: string) {
		branchMenu.close();
		if (name === branch) {
			setTarget({ kind: "current" });
			return;
		}
		const result = await settle(git().switchBranch(cwd, name));
		if (!result.ok) {
			notify(result.error ?? t("commit.branchSwitchFailed"), "error");
			return;
		}
		setTarget({ kind: "current" });
		onBranchChanged?.();
	}

	async function stageIfAsked(): Promise<void> {
		if (!includeUnstaged || unstagedCount === 0) return;
		const status = await git().status(cwd);
		const paths = status.unstaged.map((file) => file.path);
		if (paths.length > 0) await git().stage(cwd, paths);
	}

	async function handleCommit(dismiss: Dismiss) {
		if (!hasChanges) return;
		setWorkingAction("commit");
		try {
			if (!(await moveToTarget())) return;
			await stageIfAsked();
			const finalMessage = await withMessage();
			if (!finalMessage) return;
			if (await onCommit(finalMessage)) {
				setMessage("");
				dismiss();
			}
		} finally {
			setWorkingAction(null);
		}
	}

	async function handleCommitAndPush(dismiss: Dismiss) {
		if (!hasChanges) return;
		setWorkingAction("commitAndPush");
		try {
			if (!(await moveToTarget())) return;
			// 暂存交给 `onCommitAndPush`：推送前要先看一眼暂存区，两件事在同一处才对得上。
			const finalMessage = await withMessage();
			if (!finalMessage) return;
			if (await onCommitAndPush(finalMessage, includeUnstaged)) {
				setMessage("");
				dismiss();
			}
		} finally {
			setWorkingAction(null);
		}
	}

	async function handlePush(dismiss: Dismiss) {
		setWorkingAction("push");
		try {
			await onPush();
			dismiss();
		} finally {
			setWorkingAction(null);
		}
	}

	const hasChanges = stagedCount > 0 || (includeUnstaged && unstagedCount > 0);
	const disabled = busy || running || workingAction !== null || generating;
	const languageTip = t("commit.languageIs", { language: commitLanguageLabel(resolvedLanguage) });
	const pushLabel = publish ? t("sync.publishBranch") : unpushed > 0 ? `${t("common.push")} (${unpushed})` : t("common.push");

	return (
		<Dialog
			onClose={onClose}
			width={480}
			icon={<GitCommitHorizontal size={16} strokeWidth={1.9} className="git-dialog-icon-muted" />}
			title={hasChanges ? t("commit.commit") : pushLabel}
			label={t("commit.commit")}
			actions={(dismiss) => (
				<>
					<DialogAction disabled={disabled} onClick={() => dismiss()}>
						{t("common.cancel")}
					</DialogAction>
					{hasChanges ? (
						<>
							{canPush && (
								<DialogAction disabled={disabled} onClick={() => void handleCommitAndPush(dismiss)}>
									{workingAction === "commitAndPush" && <ActionSpinner size={12} />}
									{t("commit.commitAndPush")}
								</DialogAction>
							)}
							<DialogAction tone="primary" disabled={disabled} onClick={() => void handleCommit(dismiss)}>
								{workingAction === "commit" && <ActionSpinner size={12} />}
								{t("commit.commit")}
							</DialogAction>
						</>
					) : (
						<DialogAction tone="primary" label={pushTip} disabled={disabled || (unpushed === 0 && !publish)} onClick={() => void handlePush(dismiss)}>
							{workingAction === "push" && <ActionSpinner size={12} />}
							{pushLabel}
						</DialogAction>
					)}
				</>
			)}
		>
			{(dismiss) => (
				<Text as="div" size="detail" className="git-dialog">
					{/* 提交到哪儿。这一行能点：展开是本地分支，末尾一项是新建。 */}
					<div className="git-dialog-target">
						<Text size="detail" tone="muted" className="git-shrink-0">
							{t("commit.commitTo")}
						</Text>
						{target.kind === "new" ? (
							<Text as="div" size="label" weight="semibold" className="git-dialog-new-branch">
								<GitBranch size={13} strokeWidth={2} className="git-dialog-icon-faint" />
								<Input
									ref={newBranchField}
									value={target.name}
									onChange={(e) => setTarget({ kind: "new", name: e.target.value })}
									placeholder={t("commit.newBranchPlaceholder")}
									disabled={disabled}
									className="git-dialog-branch-input"
									onKeyDown={(e) => {
										// Esc 收回这一步、回到当前分支，不连弹窗一起关。
										if (e.key === "Escape") {
											e.preventDefault();
											e.stopPropagation();
											setTarget({ kind: "current" });
										}
									}}
								/>
								<IconButton size="sm" label={t("common.cancel")} onClick={() => setTarget({ kind: "current" })} icon={<X size={12} strokeWidth={2} />} />
							</Text>
						) : (
							<Button
								variant="subtle"
								size="sm"
								disabled={disabled}
								menu={branchMenu.open}
								onClick={branchMenu.toggle}
								icon={<GitBranch size={13} strokeWidth={2} className="git-dialog-icon-faint" />}
								className="git-dialog-branch-button"
							>
								<span className="git-dialog-truncate">{branch}</span>
								<ChevronDown size={12} strokeWidth={2} className="git-dialog-icon-muted" />
							</Button>
						)}
					</div>

					{branchMenu.open && (
						<Popover anchor={branchMenu.anchor} onClose={branchMenu.close} placement="bottom" align="start" width="compact" label={t("commit.commitTo")}>
							<MenuBody insetIcons>
								<MenuLabel>{t("commit.commitTo")}</MenuLabel>
								{(locals.length > 0 ? locals : [branch]).map((name) => (
									<MenuItem
										key={name}
										icon={<GitBranch size={12} strokeWidth={1.8} />}
										selected={name === branch}
										trailing={name === branch ? <Check size={13} strokeWidth={2.2} /> : undefined}
										onClick={() => void switchTo(name)}
									>
										{name}
									</MenuItem>
								))}
								<MenuItem
									icon={<Plus size={12} strokeWidth={2} />}
									onClick={() => {
										branchMenu.close();
										setTarget({ kind: "new", name: "" });
									}}
								>
									{t("commit.newBranch")}
								</MenuItem>
							</MenuBody>
						</Popover>
					)}

					<div className="plume-textarea-shell">
						<div ref={messageScroller} className="plume-scroll-host git-dialog-message-body">
							<Textarea
								ref={messageField}
								value={message}
								onChange={(e) => setMessage(e.target.value)}
								placeholder={generating ? t("commit.generating") : t("commit.autoPlaceholder")}
								disabled={disabled}
								rows={3}
								className="plume-textarea plume-field-fade"
								onKeyDown={(e) => {
									if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
										e.preventDefault();
										void handleCommit(dismiss);
									}
								}}
							/>
							{generating && (
								<span className="git-dialog-spinner">
									<ActionSpinner size={12} />
								</span>
							)}
							<OverlayScrollbar viewport={messageField} orientation="vertical" />
						</div>

						<div className="git-dialog-language">
							<Button
								variant="subtle"
								size="xs"
								label={languageTip}
								ariaLabel={languageTip}
								menu={languageMenu.open}
								disabled={disabled}
								onClick={languageMenu.toggle}
								icon={<Languages size={11} strokeWidth={1.8} />}
								className="git-dialog-language-button"
							>
								<span>{commitLanguageLabel(resolvedLanguage)}</span>
								<ChevronDown size={9} strokeWidth={2} />
							</Button>
						</div>
					</div>

					{languageMenu.open && (
						<Popover anchor={languageMenu.anchor} onClose={languageMenu.close} placement="bottom" align="end" width="compact" label={t("commit.language")}>
							<MenuBody>
								{COMMIT_LANGUAGES.map((entry) => (
									<MenuItem
										key={entry.id}
										selected={entry.id === resolvedLanguage}
										trailing={entry.id === resolvedLanguage ? <Check size={13} strokeWidth={2.2} /> : undefined}
										onClick={() => setLanguage(entry.id)}
									>
										{entry.native}
									</MenuItem>
								))}
							</MenuBody>
						</Popover>
					)}

					{/* 带不带未暂存的：只有真有未暂存的改动时才问。 */}
					{unstagedCount > 0 && (
						<label className="git-dialog-include">
							<span className="git-dialog-include-main">
								<ChoiceMark checked={includeUnstaged} kind="checkbox" />
								<input
									type="checkbox"
									checked={includeUnstaged}
									onChange={(e) => setIncludeUnstaged(e.target.checked)}
									disabled={disabled}
									className="git-dialog-sr-only"
								/>
								<Text size="label" className="git-dialog-truncate">
									{t("commit.includeUnstaged")}
								</Text>
							</span>
							<Text size="caption" mono numeric className="git-dialog-counts">
								{addedCount > 0 && <span className="git-dialog-added">+{addedCount}</span>}
								{addedCount > 0 && removedCount > 0 && " "}
								{removedCount > 0 && <span className="git-dialog-removed">−{removedCount}</span>}
							</Text>
						</label>
					)}
				</Text>
			)}
		</Dialog>
	);
}
