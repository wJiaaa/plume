import type { OutgoingMessage } from "@plume/contract";
import { stewardMessage, type SessionQueues, type Source } from "../queue.ts";
import { text } from "../i18n.ts";
import type { Session } from "./session.ts";

export interface StewardDeps {
	sessions: Map<string, Session>;
	find(sessionId: string): Session;
	governs(plugin: string, summary: Session["summary"]): boolean;
	enqueue(session: Session, message: OutgoingMessage, preview: string, source?: Source): { id: string };
	queues: Pick<SessionQueues, "list">;
}

export interface Steward {
	stewarded(plugin: string, sessionId: unknown): Session;
	answerable(plugin: string, sessionId: unknown): Session;
	postToSession(plugin: string, sessionId: unknown, message: unknown): boolean;
	settleAsSteward(plugin: string, sessionId: unknown, toolCallId: unknown, outcome: { decision: unknown } | { value: unknown }): boolean;
}

export function createSteward(deps: StewardDeps): Steward {
	const { sessions, find, governs, enqueue, queues } = deps;

	/**
	 * 插件动它代管的会话（转话、替人答卡）：要是顶层会话、`steward` 还是它。人停止了代管、会话删了以后再调都在这里抛错，
	 * 说清是哪个会话、哪个插件。别的会话一律不行：插件不能借这条路往人已有的会话、别的插件代管的会话里说话或答卡。
	 */
	function stewarded(plugin: string, sessionId: unknown): Session {
		const session = find(String(sessionId));
		if (!governs(plugin, session.summary)) throw new Error(text("session.notStewarded", { id: session.summary.id, plugin }));
		return session;
	}

	/**
	 * 代管插件能答哪个会话弹着的卡：它代管的顶层会话（`stewarded`），和挂在这个会话下面的子会话（模型派的子智能体、人开的侧边聊天，
	 * 子会话的 `owner` 是哪个插件都行）。看的是父会话此刻的代管关系：人停止代管以后，子会话里的卡也跟着答不了。
	 */
	function answerable(plugin: string, sessionId: unknown): Session {
		const session = find(String(sessionId));
		if (session.summary.kind !== "child") return stewarded(plugin, session.summary.id);
		const parent = session.summary.parentId ? sessions.get(session.summary.parentId) : undefined;
		if (!parent || !governs(plugin, parent.summary))
			throw new Error(text("session.stewardChildParent", { id: session.summary.id, parent: String(session.summary.parentId), plugin }));
		return session;
	}

	/**
	 * 代管插件转进来一句话（`SessionAccess.post`）：排进队尾，和人排的同一条队、同一套规矩（闲着当场开跑，忙着排着，停下过的也由这一下推起来），
	 * 不插进正在跑的那一轮。返回排上那一刻它是不是就开始了。只往代管的顶层会话里转：子会话里的一轮归建它的插件发起。
	 */
	function postToSession(plugin: string, sessionId: unknown, message: unknown): boolean {
		const target = find(String(sessionId));
		if (target.summary.kind === "child") throw new Error(text("session.stewardPostChild", { id: target.summary.id }));
		const session = stewarded(plugin, sessionId);
		if (session.summary.archived) throw new Error(text("session.stewardArchived", { id: session.summary.id }));
		const words = typeof message === "string" ? message.trim() : "";
		if (!words) throw new Error(text("session.emptyMessage"));
		const entry = enqueue(session, stewardMessage(words), words, { origin: "plugin", fromPlugin: plugin });
		return !queues.list(session.summary.id).some((queued) => queued.id === entry.id);
	}

	/**
	 * 代管插件替人答这个会话（或它下面的子会话，见 `answerable`）弹着的那张卡（`SessionAccess.respond`、`answer`）：和人点卡同一条路，
	 * 先到的算，另一边的卡跟着收起。只认弹着的那一张（人也只看得见这一张）；它已经不在、不是这一张时返回 false。
	 * 「以后不再问」不给插件：它改的是人的设置，不只是这一张卡。
	 */
	function settleAsSteward(plugin: string, sessionId: unknown, toolCallId: unknown, outcome: { decision: unknown } | { value: unknown }): boolean {
		const session = answerable(plugin, sessionId);
		const pending = session.approvals?.[0];
		if (!pending || pending.request.toolCallId !== toolCallId) return false;
		if ("value" in outcome) {
			if (pending.request.type !== "request") return false;
			pending.settle({ value: outcome.value, by: plugin });
			return true;
		}
		if (outcome.decision !== "once" && outcome.decision !== "reject")
			throw new Error(text("session.badStewardDecision", { decision: String(outcome.decision) }));
		// 等人给数据的卡上「允许」没有意思：只能交数据（`answer`）或不答。
		if (pending.request.type === "request" && outcome.decision !== "reject") return false;
		pending.settle({ decision: outcome.decision, by: plugin });
		return true;
	}

	return { stewarded, answerable, postToSession, settleAsSteward };
}
