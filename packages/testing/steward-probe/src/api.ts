/** 逻辑入口经 `ctx.serve` 开给面板的接口，两个入口共用。 */

import type { CallContext, PendingRequest } from "@plume/contract";

export const NAME = "example.steward-probe";

/** 面板看的一个会话：是不是本插件代管着、弹着哪张卡、模型回了什么（都是逻辑入口经 `ctx.sessions.observe` 收到的）。 */
export interface ProbeView {
	stewarded: boolean;
	/** 弹着的卡和弹它的会话：代管会话自己，或挂在它下面的子会话（答卡时传这个 id）。 */
	pending?: { sessionId: string; request: PendingRequest };
	replies: string[];
}

export interface ProbeApi {
	/** 开一个由本插件代管的会话，返回它的 id。 */
	open(message: string, cwd: string | undefined): Promise<string>;
	post(sessionId: string, message: string): Promise<boolean>;
	respond(sessionId: string, toolCallId: string, decision: "once" | "reject"): Promise<boolean>;
	answer(sessionId: string, toolCallId: string, value: unknown): Promise<boolean>;
	watch(sessionId: string, call: CallContext): AsyncGenerator<ProbeView, void>;
}
