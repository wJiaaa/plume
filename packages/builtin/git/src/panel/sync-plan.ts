/**
 * 同步那一行和空状态说什么，按检出所处的情形查表。
 *
 * 写成数据而不是 JSX：要紧的是这张表——八种情形，两颗按钮和一句话各有各的答案，其中几种（停在半路的变基、
 * 远端不叫 origin、远端从没见过的分支）在应用里很难走到，写在这里一眼看清。组件照它画，自己不做判断。
 *
 * 一条规则贯穿：只有按下去正是下一步时，按钮才加重；其余要么平常（能按、不急），要么禁用并说明原因。
 */

import type { GitOperation, GitStatus, RemoteState } from "../api.ts";
import type { MessageKey } from "../messages.ts";
import type { Translate } from "./i18n.ts";

const OPERATION: Record<GitOperation, MessageKey> = {
	rebase: "sync.rebase",
	merge: "sync.merge",
	"cherry-pick": "sync.cherryPick",
	revert: "sync.revert",
	bisect: "sync.bisect",
};

export interface SyncButton {
	disabled: boolean;
	/** 悬停提示，也是无障碍名。禁用时说明为什么。 */
	tip: string;
	/** 现在值得按的那一个，满色。 */
	emphasis: boolean;
	/** 角上的数。没有有意义的数时为空，不是 0。 */
	count: number | null;
}

export interface SyncPlan {
	/** 分支名；不在分支上时是一个替代的说法。 */
	branch: string;
	/** 跟在后面的：上游，或者为什么没有。 */
	detail: string | null;
	pull: SyncButton;
	push: SyncButton;
	/** 「工作区干净」下面那句话。 */
	empty: { body: string };
}

/** git 什么都不会做的情形：两颗都关掉。 */
function blocked(reason: string): { pull: SyncButton; push: SyncButton } {
	return {
		pull: { disabled: true, tip: reason, emphasis: false, count: null },
		push: { disabled: true, tip: reason, emphasis: false, count: null },
	};
}

export function syncPlan(status: GitStatus | null, t: Translate): SyncPlan {
	const branch = status?.branch ?? "—";
	const state: RemoteState = status?.remoteState ?? "none";
	const clean = t("sync.clean");

	if (!status) return { branch, detail: null, ...blocked(t("sync.noRepo")), empty: { body: clean } };

	if (state === "in-progress") {
		const what = t(OPERATION[status.operation ?? "merge"]);
		return { branch, detail: t("sync.inProgress", { what }), ...blocked(t("sync.finishFirst")), empty: { body: t("sync.finishFirstOf", { what }) } };
	}

	if (state === "detached") {
		// 只说「游离 HEAD」等于说迷路了却不说在哪；短 sha 是回去要用的东西。
		return { branch: t("sync.detached"), detail: status.head, ...blocked(t("sync.notOnBranch")), empty: { body: t("sync.notOnBranchDot") } };
	}

	if (state === "no-commits") return { branch, detail: null, ...blocked(t("sync.noCommits")), empty: { body: t("sync.noCommitsDot") } };

	// 只在本地用的仓库很正常，这里不提发布。
	if (state === "none") return { branch, detail: t("sync.noRemote"), ...blocked(t("sync.noRemoteDetail")), empty: { body: clean } };

	if (state === "no-upstream") {
		// 拉取要有上游；没有时 git 会以 "no tracking information" 拒绝，不如一颗说明原因的禁用按钮。
		const noUpstream: SyncButton = { disabled: true, tip: t("sync.noUpstream"), emphasis: false, count: null };
		if (!status.remote) {
			return {
				branch,
				detail: t("sync.untracked"),
				pull: noUpstream,
				push: { disabled: true, tip: t("sync.manyRemotes"), emphasis: false, count: null },
				empty: { body: t("sync.manyRemotesDot") },
			};
		}
		// 有数：远端有同名分支可以比。为空：远端从没见过这个分支，「发布过没有」是一个是非题。
		const never = status.unpushed === null;
		const count = status.unpushed ?? 0;
		return {
			branch,
			detail: t("sync.untracked"),
			pull: noUpstream,
			push: {
				disabled: false,
				tip: never ? t("sync.publishTo", { remote: status.remote }) : t("sync.pushTo", { remote: status.remote, branch }),
				emphasis: true,
				count: never ? null : count,
			},
			empty: { body: never ? t("sync.notPublished", { remote: status.remote }) : t("sync.unpushedTo", { n: count, remote: status.remote, branch }) },
		};
	}

	// 有上游：分支和上游的四种差别。
	const upstream = status.upstream ?? "";
	const ahead = status.unpushed ?? status.ahead;
	const behind = status.behind;
	const pull: SyncButton = {
		disabled: false,
		tip: behind > 0 ? t("sync.pullFf", { n: behind }) : t("sync.upToDate", { upstream }),
		emphasis: behind > 0,
		count: behind > 0 ? behind : null,
	};
	const push: SyncButton = {
		disabled: false,
		tip: ahead > 0 ? t("sync.pushToUpstream", { upstream }) : t("sync.upToDate", { upstream }),
		emphasis: ahead > 0,
		count: ahead > 0 ? ahead : null,
	};
	const body =
		ahead > 0 && behind > 0
			? t("sync.diverged", { ahead, behind })
			: ahead > 0
				? t("sync.unpushed", { n: ahead, upstream })
				: behind > 0
					? t("sync.behindBy", { n: behind })
					: clean;
	return { branch, detail: upstream || null, pull, push, empty: { body } };
}
