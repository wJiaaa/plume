/**
 * 环境卡片 Git 两行的纯逻辑：快捷主动作、下拉菜单项、禁用原因、默认分支确认、新建分支名规范化。
 *
 * 与组件拆开以便单测覆盖所有分支与远端状态，交互语义对齐 t3code 的 GitActionsControl / BranchToolbar。
 */

import type { GitStatus } from "../api.ts";
import type { Translate } from "./i18n.ts";

export type EnvActionKind = "commit" | "commit_push" | "push" | "publish" | "pull";

export interface EnvQuickAction {
	label: string;
	icon: "commit" | "upload" | "download" | "info";
	disabled: boolean;
	action: EnvActionKind | null;
	tip: string;
}

export interface EnvMenuItem {
	id: "commit" | "push" | "pull";
	label: string;
	icon: "commit" | "upload" | "download";
	disabled: boolean;
	disabledReason: string | null;
	action: EnvActionKind;
}

/**
 * 清理用户输入的新分支名：连续空白替换为连字符，去掉首尾空白与非法前缀/后缀字符。
 */
export function sanitizeNewBranchName(raw: string): string {
	return raw
		.trim()
		.replace(/\s+/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/^[-./]+|[-./]+$/g, "");
}

function hasWorkingChanges(status: GitStatus): boolean {
	return status.staged.length > 0 || status.unstaged.length > 0;
}

function canPushWithRemote(status: GitStatus): boolean {
	if (status.remoteState === "tracking") return true;
	if (status.remoteState === "no-upstream") return status.remote !== null;
	return false;
}

/**
 * 计算环境卡片第二行左侧主按钮的快捷动作：
 * - 有未提交改动：有远端且未落后时「提交并推送」，否则「提交」；
 * - 无未提交改动：分叉禁用、落后时「拉取」、领先或未发布时「推送 / 发布分支」、否则禁用「提交」。
 */
export function resolveEnvQuickAction(status: GitStatus | null, busy: boolean, t: Translate): EnvQuickAction {
	if (busy) {
		return {
			label: t("commit.commit"),
			icon: "commit",
			disabled: true,
			action: null,
			tip: t("env.actionInProgress"),
		};
	}

	if (!status) {
		return {
			label: t("commit.commit"),
			icon: "commit",
			disabled: true,
			action: null,
			tip: t("sync.noRepo"),
		};
	}

	if (status.remoteState === "in-progress") {
		return {
			label: t("commit.commit"),
			icon: "commit",
			disabled: true,
			action: null,
			tip: t("sync.finishFirst"),
		};
	}

	const hasChanges = hasWorkingChanges(status);
	const hasBranch = status.branch !== null;
	const isBehind = status.behind > 0;
	const isAhead = (status.unpushed ?? status.ahead) > 0;
	const hasRemote = canPushWithRemote(status);
	const neverPublished = status.remoteState === "no-upstream" && status.remote !== null && status.unpushed === null;

	if (!hasBranch) {
		if (hasChanges) {
			return {
				label: t("commit.commit"),
				icon: "commit",
				disabled: false,
				action: "commit",
				tip: t("commit.commit"),
			};
		}
		return {
			label: t("commit.commit"),
			icon: "commit",
			disabled: true,
			action: null,
			tip: t("env.detachedNotice"),
		};
	}

	if (hasChanges) {
		if (isBehind || !hasRemote) {
			return {
				label: t("commit.commit"),
				icon: "commit",
				disabled: false,
				action: "commit",
				tip: t("commit.commit"),
			};
		}
		return {
			label: t("commit.commitAndPush"),
			icon: "upload",
			disabled: false,
			action: "commit_push",
			tip: t("commit.commitAndPush"),
		};
	}

	if (status.remoteState === "no-commits") {
		return {
			label: t("commit.commit"),
			icon: "commit",
			disabled: true,
			action: null,
			tip: t("sync.noCommits"),
		};
	}

	if (status.remoteState === "none") {
		return {
			label: t("commit.commit"),
			icon: "commit",
			disabled: true,
			action: null,
			tip: t("env.cleanReason"),
		};
	}

	if (status.remoteState === "no-upstream") {
		if (!status.remote) {
			return {
				label: t("common.push"),
				icon: "upload",
				disabled: true,
				action: null,
				tip: t("sync.manyRemotes"),
			};
		}
		if (neverPublished) {
			return {
				label: t("sync.publishBranch"),
				icon: "upload",
				disabled: false,
				action: "publish",
				tip: t("sync.publishTo", { remote: status.remote }),
			};
		}
		if (isAhead) {
			return {
				label: t("common.push"),
				icon: "upload",
				disabled: false,
				action: "push",
				tip: t("sync.pushTo", { remote: status.remote, branch: status.branch ?? "" }),
			};
		}
		return {
			label: t("common.push"),
			icon: "upload",
			disabled: true,
			action: null,
			tip: t("env.noLocalCommits"),
		};
	}

	// tracking
	if (isAhead && isBehind) {
		return {
			label: t("env.syncBranch"),
			icon: "info",
			disabled: true,
			action: null,
			tip: t("env.divergedReason"),
		};
	}
	if (isBehind) {
		return {
			label: t("common.pull"),
			icon: "download",
			disabled: false,
			action: "pull",
			tip: t("sync.pullFf", { n: status.behind }),
		};
	}
	if (isAhead) {
		return {
			label: t("common.push"),
			icon: "upload",
			disabled: false,
			action: "push",
			tip: t("sync.pushToUpstream", { upstream: status.upstream ?? "" }),
		};
	}

	return {
		label: t("commit.commit"),
		icon: "commit",
		disabled: true,
		action: null,
		tip: t("env.upToDateReason"),
	};
}

/**
 * 第二行右侧下拉菜单项：提交（打开弹窗）、推送/发布分支、拉取（跟踪上游时提供），禁用项保留并附带原因提示。
 */
export function buildEnvMenuItems(status: GitStatus | null, busy: boolean, t: Translate): EnvMenuItem[] {
	if (!status) return [];
	const hasChanges = hasWorkingChanges(status);
	const hasBranch = status.branch !== null;
	const inProgress = status.remoteState === "in-progress";
	const isBehind = status.behind > 0;
	const isAhead = (status.unpushed ?? status.ahead) > 0;
	const neverPublished = status.remoteState === "no-upstream" && status.remote !== null && status.unpushed === null;

	const canCommit = !busy && !inProgress && hasChanges;
	const commitReason = canCommit ? null : busy ? t("env.actionInProgress") : inProgress ? t("sync.finishFirst") : t("env.cleanReason");

	const items: EnvMenuItem[] = [
		{
			id: "commit",
			label: t("commit.commit"),
			icon: "commit",
			disabled: !canCommit,
			disabledReason: commitReason,
			action: "commit",
		},
	];

	if (status.remoteState !== "none" && status.remoteState !== "no-commits") {
		const canPush = !busy && !inProgress && hasBranch && !isBehind && canPushWithRemote(status) && (isAhead || neverPublished);
		const pushReason = canPush
			? null
			: busy
				? t("env.actionInProgress")
				: inProgress
					? t("sync.finishFirst")
					: !hasBranch
						? t("env.detachedNotice")
						: isBehind
							? t("env.behindNotice")
							: !canPushWithRemote(status)
								? t("sync.manyRemotes")
								: t("env.noLocalCommits");

		items.push({
			id: "push",
			label: neverPublished ? t("sync.publishBranch") : t("common.push"),
			icon: "upload",
			disabled: !canPush,
			disabledReason: pushReason,
			action: neverPublished ? "publish" : "push",
		});
	}

	if (status.remoteState === "tracking") {
		const canPull = !busy && !inProgress;
		items.push({
			id: "pull",
			label: t("common.pull"),
			icon: "download",
			disabled: !canPull,
			disabledReason: canPull ? null : busy ? t("env.actionInProgress") : t("sync.finishFirst"),
			action: "pull",
		});
	}

	return items;
}

/** 菜单里至少有一项可点或有一条状态提醒时才允许展开，和 t3code 的 `hasUsableGitMenuContent` 一致。 */
export function hasEnvMenuContent(status: GitStatus | null, items: readonly EnvMenuItem[]): boolean {
	if (!status) return false;
	const hasNotice =
		status.remoteState === "detached" || status.remoteState === "in-progress" || (!hasWorkingChanges(status) && status.behind > 0 && status.ahead === 0);
	return hasNotice || items.some((item) => !item.disabled);
}

/** 推向默认分支（`commit_push` / `push` / `publish`）前确认一次；纯本地 `commit` 和 `pull` 不弹确认。 */
export function requiresDefaultBranchConfirm(action: EnvActionKind | null, isDefaultBranch: boolean): action is "commit_push" | "push" | "publish" {
	if (!isDefaultBranch || !action) return false;
	return action === "commit_push" || action === "push" || action === "publish";
}
