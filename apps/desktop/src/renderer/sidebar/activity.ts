/**
 * 侧栏行首要说的、会话摘要里没有的那几件事：停下来等人批准了，或者在人没看着的时候跑完、出错了。
 *
 * 只从事件里推，不存盘：事件已经说清了一切，再存一份就多一个会说错的地方；重开应用后都算看过了。
 * 在跑不在这里，摘要的 `running` 就是它。在看着的那个会话跑完不留记号：结果就在眼前。
 */

import type { PendingRequest, SessionSummary, StopReason } from "@plume/contract";
import type { SessionActivity } from "@plume/contract/ui";
import { useSyncExternalStore } from "react";

export type { SessionActivity };

const marks = new Map<string, SessionActivity>();
/** 在等的那张卡说的是什么，见 `waitOf`。 */
interface Wait {
	userOnly: boolean;
	waiting?: string;
}
const waits = new Map<string, Wait>();
/** 子会话 id → 父会话 id：子会话（侧边聊天、子 Agent）在等批准时，侧栏里看得见的是父会话那一行。 */
const parents = new Map<string, string>();
const listeners = new Set<() => void>();

let version = 0;

function changed(): void {
	version++;
	for (const listener of listeners) listener();
}

function set(sessionId: string, next: SessionActivity | undefined): void {
	if (marks.get(sessionId) === next) return;
	if (next) marks.set(sessionId, next);
	else marks.delete(sessionId);
	changed();
}

/** 一轮怎么收的尾：人自己按停的、应用退出打断的不用提醒，人知道它是怎么结束的。 */
export function outcome(reason: StopReason | undefined): SessionActivity | undefined {
	if (reason === "done") return "done";
	if (reason === "error" || reason === "max_turns" || reason === "stalled") return "failed";
	return undefined;
}

/**
 * 摘要变了以后这个会话的记号。新一轮开始时清掉上一轮的结果；跑着时等批准的记号留着，等审批事件撤；
 * 一轮刚停下：等批准的撤掉，人没看着的话记下结果。
 */
export function settle(
	previous: SessionSummary | undefined,
	next: SessionSummary,
	current: SessionActivity | undefined,
	watching: boolean,
): SessionActivity | undefined {
	if (next.running) return current === "waiting" ? current : undefined;
	if (previous?.running) return watching ? undefined : outcome(next.stop?.reason);
	return current === "waiting" ? undefined : current;
}

export function sessionsChanged(previous: readonly SessionSummary[], next: readonly SessionSummary[], currentId: string | undefined): void {
	const before = new Map(previous.map((session) => [session.id, session]));
	for (const session of next) set(session.id, settle(before.get(session.id), session, marks.get(session.id), session.id === currentId));
	for (const id of [...marks.keys()]) if (!next.some((session) => session.id === id)) set(id, undefined);
	for (const id of [...waits.keys()]) if (!next.some((session) => session.id === id)) waits.delete(id);
	const linked = next.flatMap((session) => (session.parentId ? [[session.id, session.parentId] as const] : []));
	if (linked.length === parents.size && linked.every(([id, parentId]) => parents.get(id) === parentId)) return;
	parents.clear();
	for (const [id, parentId] of linked) parents.set(id, parentId);
	changed();
}

/** 等人的卡来了或撤了。记下它是不是只能由人答（`run.request` 的都是）、插件给的那句状态（`waiting`），说「在等什么」用。 */
export function approvalChanged(sessionId: string, approval: PendingRequest | undefined): void {
	if (approval) {
		const userOnly = approval.type === "request" || approval.userOnly === true;
		const wait: Wait = { userOnly, ...(approval.waiting ? { waiting: approval.waiting } : {}) };
		const before = waits.get(sessionId);
		waits.set(sessionId, wait);
		if (marks.get(sessionId) === "waiting" && (before?.userOnly !== wait.userOnly || before?.waiting !== wait.waiting)) changed();
		set(sessionId, "waiting");
		return;
	}
	waits.delete(sessionId);
	if (marks.get(sessionId) === "waiting") set(sessionId, undefined);
}

/** 这个会话在等什么：它自己的那张卡，它自己没在等时是在等的子会话的。 */
export function waitOf(sessionId: string): Wait | undefined {
	if (marks.get(sessionId) === "waiting") return waits.get(sessionId);
	for (const [id, parentId] of parents) if (parentId === sessionId && marks.get(id) === "waiting") return waits.get(id);
	return undefined;
}

/** 「在等什么」那句话：插件给了就用它，不然按是不是只能由人答说「等待你的回答」或「等待你的批准」。 */
export function waitingWords(wait: Wait | undefined, t: (key: "running.waitingForAnswer" | "sessionStatus.waiting") => string): string {
	return wait?.waiting ?? t(wait?.userOnly ? "running.waitingForAnswer" : "sessionStatus.waiting");
}

/** 人打开了这个会话：结果看到了；等批准的不清，那是还没办的事。 */
export function sessionRead(sessionId: string): void {
	const current = marks.get(sessionId);
	if (current === "done" || current === "failed") set(sessionId, undefined);
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** 这个会话自己的记号；它自己没在等、某个子会话在等批准时也算等批准。 */
export function activityOf(sessionId: string): SessionActivity | undefined {
	const own = marks.get(sessionId);
	if (own === "waiting") return own;
	for (const [id, parentId] of parents) if (parentId === sessionId && marks.get(id) === "waiting") return "waiting";
	return own;
}

export function useSessionActivity(sessionId: string): SessionActivity | undefined {
	return useSyncExternalStore(subscribe, () => activityOf(sessionId));
}

/** 通知菜单订阅整份状态；快照用版本号，避免每次读取都新建对象。 */
export function useActivityVersion(): number {
	return useSyncExternalStore(subscribe, () => version);
}

const NOTICE_ORDER: readonly SessionActivity[] = ["waiting", "failed", "done"];

/** 铃铛里的条目和圆点颜色共用一个顺序：先等批准、再失败、最后完成，同类里新的在前；没有时间的（页面的提醒）排在同类最后。 */
export function sortNotices<T extends { state: SessionActivity; updatedAt?: number }>(notices: readonly T[]): T[] {
	return [...notices].sort((a, b) => NOTICE_ORDER.indexOf(a.state) - NOTICE_ORDER.indexOf(b.state) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
