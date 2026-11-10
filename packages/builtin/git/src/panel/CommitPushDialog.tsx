/**
 * 提交与推送，一个居中的弹窗。
 *
 * 提交是少数几件按下去就改了磁盘的事，值得占住屏幕中间、压暗背后。
 *
 * - **留空就生成**：提交时空着就先让模型写一句，写回输入框——人看得见自己提交的是什么。
 * - **提交到哪个分支**也在这里选：选了新分支不当场创建，名字先记着，真提交那一刻才 `git switch -c`，
 *   中途改主意仓库里不会留下空分支。
 * - 写了什么、哪一步在跑，不存在这里（见 `commit-work.ts`）：关掉弹窗只是收起样子，事还在跑。
 */

import {
	ActionSpinner,
	Button,
	IconButton,
	MenuBody,
	MenuItem,
	MenuLabel,
	Overlay,
	OverlayScrollbar,
	Popover,
	shortcutLabel,
	Text,
	useFieldFade,
	usePopover,
} from "@plume/ui";
import { Check, ChevronDown, CloudUpload, GitBranch, GitCommitHorizontal, Languages, Plus, Upload, X } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import { COMMIT_LANGUAGES, commitLanguageLabel, resolveCommitLanguage } from "./commit-language.ts";
import type { CommitWork } from "./commit-work.ts";
import { notify } from "./host.ts";
import { useT } from "./i18n.ts";
import { git, settle } from "./remote.ts";

/** `Overlay` 交给内容的那个关闭函数：播完退场再调 `after`。 */
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
	/** 这一次提交的现场，归面板持有，见 `commit-work.ts`。 */
	work: CommitWork;
	/** 还没推上去的提交数：没有可推的就真的禁用那一行。 */
	unpushed: number;
	/** 远端从没见过这个分支：推送那一行就是发布（这时没有数可报，整条分支都还没离开这台机器）。 */
	publish: boolean;
	/** 同步计划写好的那句话：几个提交没推，或者已经同步。 */
	pushTip: string;
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

	return (
		<Overlay onClose={onClose} width={460} label={t("commit.commit")}>
			{(dismiss) => (
				<Text as="div" size="detail" className="git-dialog">
					{/* 提交到哪儿。这一行能点：展开是本地分支，末尾一项是新建。 */}
					<div className="git-dialog-target">
						{target.kind === "new" ? (
							<Text as="div" size="label" weight="semibold" className="git-dialog-new-branch">
								<GitBranch size={13} strokeWidth={2} className="git-dialog-icon-faint" />
								<input
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
							<button type="button" disabled={disabled} onClick={branchMenu.toggle} className="git-dialog-branch-button">
								<GitBranch size={13} strokeWidth={2} className="git-dialog-icon-faint" />
								<Text size="label" weight="semibold" className="git-dialog-truncate">
									{branch}
								</Text>
								<ChevronDown size={12} strokeWidth={2} className="git-dialog-icon-muted" />
							</button>
						)}
					</div>

					{branchMenu.open && (
						<Popover anchor={branchMenu.anchor} onClose={branchMenu.close} placement="bottom" align="start" width="compact" label={t("commit.commitTo")}>
							<MenuBody>
								<MenuLabel>{t("commit.commitTo")}</MenuLabel>
								{(locals.length > 0 ? locals : [branch]).map((name) => (
									<MenuItem
										key={name}
										selected={name === branch}
										trailing={name === branch ? <Check size={13} strokeWidth={2.2} /> : undefined}
										onClick={() => void switchTo(name)}
									>
										<span className="git-dialog-menu-row">
											<GitBranch size={12} strokeWidth={1.8} className="git-dialog-icon-faint" />
											<span className="git-dialog-truncate">{name}</span>
										</span>
									</MenuItem>
								))}
								<MenuItem
									onClick={() => {
										branchMenu.close();
										setTarget({ kind: "new", name: "" });
									}}
								>
									<span className="git-dialog-menu-row">
										<Plus size={12} strokeWidth={2} className="git-dialog-icon-faint" />
										<span>{t("commit.newBranch")}</span>
									</span>
								</MenuItem>
							</MenuBody>
						</Popover>
					)}

					{/*
					 * 写什么：和主输入框同一副圆角和描边，但不带它的阴影——这个框长在已经浮起来的弹窗里，再加一层阴影就从卡片里鼓出来了。
					 * 内衬用主输入框的那两个变量，它的呼吸感调了，这里跟着动。
					 */}
					<Text as="div" size="label" className="git-dialog-message">
						<div ref={messageScroller} className="plume-scroll-host git-dialog-message-body">
							<textarea
								ref={messageField}
								value={message}
								onChange={(e) => setMessage(e.target.value)}
								placeholder={generating ? t("commit.generating") : t("commit.autoPlaceholder")}
								disabled={disabled}
								rows={3}
								className="plume-field-fade git-dialog-textarea"
								onKeyDown={(e) => {
									if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
										e.preventDefault();
										void handleCommit(dismiss);
									}
								}}
							/>
							{/* 生成中由输入框自己交代：此刻发生的是模型在写字，放在字会出现的地方。 */}
							{generating && (
								<span className="git-dialog-spinner">
									<ActionSpinner size={12} />
								</span>
							)}
							<OverlayScrollbar viewport={messageField} orientation="vertical" />
						</div>

						{/* 用什么语言生成，一直在：打第一个字时整行消失、框矮一截，人正打着字脚下的东西动了。 */}
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
					</Text>

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
								{/* 自己画的方框：原生 checkbox 两个平台长得不一样。真正的 input 只对读屏可见，键盘和读屏走它。 */}
								<span aria-hidden data-checked={includeUnstaged || undefined} className="git-dialog-check">
									<Check size={11} strokeWidth={3} />
								</span>
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

					{/* 做哪一个。上面的框已经画出了下沿，不再补分隔线。 */}
					<div className="git-dialog-actions">
						<ActionRow
							icon={<GitCommitHorizontal size={15} strokeWidth={1.9} />}
							label={t("commit.commit")}
							trailing={
								<kbd className="git-dialog-kbd">
									<Text size="caption" tone="faint" mono>
										{shortcutLabel("⌘↩")}
									</Text>
								</kbd>
							}
							working={workingAction === "commit"}
							disabled={disabled || !hasChanges}
							onClick={() => void handleCommit(dismiss)}
						/>
						<ActionRow
							icon={<CloudUpload size={15} strokeWidth={1.9} />}
							label={t("commit.commitAndPush")}
							working={workingAction === "commitAndPush"}
							disabled={disabled || !hasChanges}
							onClick={() => void handleCommitAndPush(dismiss)}
						/>
						<ActionRow
							icon={<Upload size={15} strokeWidth={1.9} />}
							label={publish ? t("sync.publishBranch") : t("common.push")}
							tip={pushTip}
							trailing={
								unpushed > 0 ? (
									<Text size="caption" tone="faint" mono numeric>
										{unpushed}
									</Text>
								) : undefined
							}
							working={workingAction === "push"}
							disabled={disabled || (unpushed === 0 && !publish)}
							onClick={() => void handlePush(dismiss)}
						/>
					</div>
				</Text>
			)}
		</Overlay>
	);
}

/** 弹窗底部那三行，一个样子：分开写的话高度、圆角、转圈的尺寸三处都对不齐。 */
function ActionRow({
	icon,
	label,
	tip,
	trailing,
	working,
	disabled,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	tip?: string;
	trailing?: React.ReactNode;
	working: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button type="button" disabled={disabled} onClick={onClick} {...(tip ? { "data-plume-tip": tip } : {})} className="git-dialog-action">
			<span className="git-dialog-action-main">
				{/* 转圈的那一枚和图标一样大：换了尺寸，按下去那一下整行的字会横着挪。 */}
				<span className="git-dialog-action-icon">{working ? <ActionSpinner size={14} /> : icon}</span>
				<Text size="label" className="git-dialog-truncate">
					{label}
				</Text>
			</span>
			{trailing}
		</button>
	);
}
