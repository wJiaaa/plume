import type { SessionSummary } from "@plume/contract";

/** 逻辑入口经 `ctx.serve` 开给界面入口的接口：界面入口拿不到会话列表，子会话一节和子会话列表面板从这里读。 */
export interface EnvironmentApi {
	/** 这个会话下面的子会话（`parentId` 是它的）；会话不在了时报错。 */
	children(sessionId: string): Promise<SessionSummary[]>;
}
