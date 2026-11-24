/** 逻辑入口经 `ctx.serve` 开给界面入口的接口。 */

import type { StopReason, ThinkingLevel } from "@plume/contract";

/**
 * 从当前对话派生出来的关联会话（建议新会话、直接开、offer、移交、计划交给新会话、侧边聊天开新会话、分叉）。
 * 不管在跑、已停止、已完成还是已归档都保留，直到会话被删除。
 */
export interface StartedSuggestion {
	/** 对应的工具调用 id；手动分叉或没带 `toolCallId` 开出的为 undefined。 */
	callId?: string;
	sessionId: string;
	title: string;
	createdAt: number;
	running: boolean;
	background?: true;
	stopReason?: StopReason;
	archived?: true;
}

/** 建议卡上「开始」那一排选的：工作树开关，和新会话的模型、思考档位。 */
interface StartChoice {
	/** 在它自己的工作树里跑（这里开得出时）。 */
	worktree: boolean;
	/** 新会话的模型（`SessionModel.id`）；不给是默认模型。 */
	model?: string;
	/** 新会话的思考档位；不给是默认推理强度。 */
	thinking?: ThinkingLevel;
}

export interface SpawnSessionApi {
	/** `parentId` 这个对话派生出来的全部顶层关联会话，按创建时间从早到晚。 */
	started(parentId: string): Promise<StartedSuggestion[]>;
	/**
	 * 建议卡上点了「开始」：在提建议的对话所在的项目里（不在项目里时是它的目录）开一个新会话，第一句是建议里的那段话，记着从这次调用
	 * 开出来（`spawnedFrom`），用卡片上选的模型和思考档位（没选就是默认的）。`choice.worktree` 是卡片上的工作树开关：开着、这里又开得出工作树
	 * （见 `offersWorktree`，这边自己再问一次），就让它在自己的工作树里跑。同一条建议开过就不再开，返回开出来的会话 id。
	 * 过期了、被模型撤回了的抛错。
	 */
	start(parentId: string, callId: string, choice: StartChoice): Promise<string>;
	/** 卡片上给不给工作树开关：提建议的对话在项目里、那里是 git 仓库。 */
	offersWorktree(parentId: string): Promise<boolean>;
}

/** 设置（`ctx.settings`），设置分区经 `ui.useSettings` 读、改。 */
export interface SpawnSettings {
	/** 人提了新的事时先弹卡问要不要另开（设置 › 常规里的开关；offer 卡上的「以后不再问」把它关掉）；缺省开着。 */
	offers: boolean;
}

export function normalizeSettings(saved: Record<string, unknown>): SpawnSettings {
	return { offers: saved.offers !== false };
}
