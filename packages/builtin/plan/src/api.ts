import type { CallContext } from "@plume/contract";

/** 哪些会话开着计划模式；`draft` 是还没发第一句话的新对话上的开关，第一句话发出去时交给它建出来的会话。 */
export interface PlanState {
	sessions: string[];
	draft: boolean;
}

export interface PlanApi {
	/** `sessionId` 为 null 时拨的是新对话的开关。 */
	set(sessionId: string | null, on: boolean): void;
	watch(call: CallContext): AsyncGenerator<PlanState, void>;
	/** 可用的模型，计划卡上「用 X 在新会话里执行」写名字用。 */
	models(): Promise<{ id: string; name: string }[]>;
}
