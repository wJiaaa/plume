import type { CallContext } from "@plume/contract";
import type { PlanReply } from "./plan.ts";

/** 哪些会话开着计划模式；`draft` 是还没发第一句话的新对话上的开关，第一句话发出去时交给它建出来的会话。 */
export interface PlanState {
	sessions: string[];
	draft: boolean;
}

export interface PlanApi {
	/** `sessionId` 为 null 时拨的是新对话的开关。 */
	set(sessionId: string | null, on: boolean): void;
	/** 审批卡回答之前交来的附言（注意事项、修改意见），这个会话这次 `submit_plan` 从 `run.ask` 返回后取走。 */
	reply(sessionId: string, reply: PlanReply): void;
	watch(call: CallContext): AsyncGenerator<PlanState, void>;
	/** 可用的模型，审批卡上「用 X 在新会话里执行」写名字用。 */
	models(): Promise<{ id: string; name: string }[]>;
}
