/** 逻辑入口经 `ctx.serve` 开给界面入口的接口。 */

import type { ThinkingLevel } from "@plume/contract";

/** 一条开始了的建议：从哪次调用开出了哪个会话。 */
export interface StartedSuggestion {
	callId: string;
	sessionId: string;
	/** 第一轮跑完以后把回复交回来。 */
	reportBack: boolean;
	/** 第一轮还在跑：交不交还能改。应用重启前开的不算（那时第一轮早停了）。 */
	firstTurn: boolean;
}

/** 卡片上「开始」那一排选的：两个开关，和新会话的模型、思考档位。 */
interface StartChoice {
	/** 第一轮跑完以后把回复交回来。 */
	reportBack: boolean;
	/** 在它自己的工作树里跑（这里开得出时）。 */
	worktree: boolean;
	/** 新会话的模型（`SessionModel.id`）；不给是默认模型。 */
	model?: string;
	/** 新会话的思考档位；不给是默认推理强度。 */
	thinking?: ThinkingLevel;
}

export interface SpawnSessionApi {
	/** `parentId` 这个对话里开始了的建议。 */
	started(parentId: string): Promise<StartedSuggestion[]>;
	/**
	 * 卡片上点了「开始」：在提建议的对话所在的项目里（不在项目里时是它的目录）开一个新会话，第一句是建议里的提示词，记着从这次调用
	 * 开出来（`spawnedFrom`），用卡片上选的模型和思考档位（没选就是默认的）。`choice.worktree` 是卡片上的工作树开关：开着、这里又开得出工作树
	 * （见 `offersWorktree`，这边自己再问一次），就让它在自己的工作树里跑。同一条建议开过就不再开，返回开出来的会话 id。
	 */
	start(parentId: string, callId: string, choice: StartChoice): Promise<string>;
	/** 卡片上给不给工作树开关：提建议的对话在项目里、那里是 git 仓库。 */
	offersWorktree(parentId: string): Promise<boolean>;
	/** 开始以后改主意：第一轮还在跑时打开、关上交回。第一轮已经结束（改了也不会再交）时返回 false。 */
	setReportBack(sessionId: string, on: boolean): Promise<boolean>;
}
