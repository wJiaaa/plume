/** 逻辑入口经 `ctx.serve` 开给界面入口的接口。 */

import type { ThinkingLevel } from "@plume/contract";

/** 一条开始了的建议或 offer：从哪次调用开出了哪个会话。 */
export interface StartedSuggestion {
	callId: string;
	sessionId: string;
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
	/** `parentId` 这个对话里开始了的建议和 offer。 */
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
	/** 人提了新的事时先弹卡问要不要另开（设置 › 常规里的开关；offer 卡上的「以后不再问」把它关掉）。 */
	offers(): Promise<boolean>;
	setOffers(on: boolean): Promise<void>;
}
