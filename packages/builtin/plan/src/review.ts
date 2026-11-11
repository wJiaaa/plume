/**
 * 每个会话正在审的那份计划，和人在计划面板里留下的评论；界面入口里审批卡和面板共用的一份内存状态。
 *
 * 审批卡管回答，面板管读和划线评论，是同一次审阅的两面。只放内存：评论只对一次进行中的审批有意义，
 * 重启后审批本身也不在了，留着评论没有可交给谁的。
 */

import { useSyncExternalStore } from "react";

export interface PlanComment {
	id: string;
	/** 划下的那段字，原样。交给模型的就是它，不是位置。 */
	quote: string;
	/** 在面板正文里的字符位置，只用来把那段重新标出来。 */
	start: number;
	end: number;
	text: string;
}

export interface PlanReview {
	/** 哪一次 `submit_plan`（调用 id）。模型改完再交是新的一次，评论跟着清空。 */
	requestId: string;
	text: string;
	comments: PlanComment[];
}

interface State {
	reviews: Readonly<Record<string, PlanReview>>;
	/** 不在审批时，面板摊开的是哪一份批准过的计划（`approvedAt`）；没挑过就是最后交上来的那份。 */
	viewing: Readonly<Record<string, number>>;
}

let state: State = { reviews: {}, viewing: {} };
const listeners = new Set<() => void>();

function update(next: State): void {
	state = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useReview(sessionId: string | undefined): PlanReview | undefined {
	return useSyncExternalStore(subscribe, () => (sessionId ? state.reviews[sessionId] : undefined));
}

export function useViewing(sessionId: string | undefined): number | undefined {
	return useSyncExternalStore(subscribe, () => (sessionId ? state.viewing[sessionId] : undefined));
}

/** 记下这次审批的计划；是新的一次返回 true——只有这时才替人打开面板，人关掉以后不再追着开。 */
export function showPlan(sessionId: string, requestId: string, text: string): boolean {
	if (state.reviews[sessionId]?.requestId === requestId) return false;
	// 又交了一份：先前挑着看的那份让位，审批完面板停在新的这份上。
	const { [sessionId]: _picked, ...viewing } = state.viewing;
	update({ reviews: { ...state.reviews, [sessionId]: { requestId, text, comments: [] } }, viewing });
	return true;
}

export function viewPlan(sessionId: string, approvedAt: number): void {
	update({ ...state, viewing: { ...state.viewing, [sessionId]: approvedAt } });
}

export function addComment(sessionId: string, comment: Omit<PlanComment, "id">): void {
	const review = state.reviews[sessionId];
	if (!review) return;
	// 按在正文里的先后排：交出去的意见和计划同一个顺序读。
	const comments = [...review.comments, { ...comment, id: crypto.randomUUID() }].sort((a, b) => a.start - b.start);
	update({ ...state, reviews: { ...state.reviews, [sessionId]: { ...review, comments } } });
}

export function removeComment(sessionId: string, id: string): void {
	const review = state.reviews[sessionId];
	if (!review) return;
	update({ ...state, reviews: { ...state.reviews, [sessionId]: { ...review, comments: review.comments.filter((comment) => comment.id !== id) } } });
}
