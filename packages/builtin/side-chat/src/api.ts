/** 逻辑入口经 `ctx.serve` 开给界面入口的接口。 */

import type { SessionMessage, ThinkingLevel } from "@plume/contract";

/** 卡片上给新会话选的模型（`SessionModel.id`）、思考档位：没动过的不给，用默认的。 */
export interface LaunchChoice {
	model?: string;
	thinking?: ThinkingLevel;
	/** 卡上「做完送回」开着：新会话每做完一轮，本体把结果交回这段侧边聊天，并叫醒它。 */
	reportBack: boolean;
}

/** 这段侧边聊天的卡开过的一个会话：卡上「交给它接着做」那一行。 */
export interface OpenedSession {
	id: string;
	title: string;
}

export interface SideChatEntry {
	id: string;
	/** 第一问的开头；还没问过是空字符串。 */
	title: string;
	createdAt: number;
}

/** 侧边聊天里一句还没被模型读到的话，回执条上一行。 */
export interface WaitingEntry {
	id: string;
	/** 气泡上的字，空白压成一个空格。 */
	preview: string;
	/** 已经插进这一轮、等模型读到；不是的就是排在这一轮之后。 */
	steered: boolean;
	/** 带着附件或会话引用：收回时只放得回字，这样的不给收回。 */
	attachments: boolean;
}

export interface SideChatApi {
	/** 按稳定标签恢复绑定；首次打开只认领未绑定的最新一段，没有则保持空白。 */
	bind(tab: string, parentId: string): Promise<string | undefined>;
	/**
	 * 接回这个标签的侧边聊天，没有才新建；绑定落盘后返回，重复调用不会多建。面板一打开就调它：侧边聊天和主会话一样，
	 * 打开时会话就在了，第一句之前的命令（`/plan`）、模型菜单都按这段会话来。
	 */
	open(tab: string, parentId: string): Promise<string>;
	/**
	 * 在侧边聊天里问一句，这一轮开跑就返回（不等它答完）。正在跑、或者前面还有排着的，就排到后面（见 waiting.ts）。
	 * 排队条上拿过来的那条带着附件，整条照发。
	 */
	ask(sideId: string, message: string | SessionMessage): Promise<void>;
	/** 插进正在跑的这一轮，模型做完手上这一步读到；已经不在跑了就同 `ask`。 */
	steer(sideId: string, message: string | SessionMessage): Promise<void>;
	/** 排到这一轮之后；没在跑就同 `ask`。 */
	queue(sideId: string, message: string | SessionMessage): Promise<void>;
	/** 还没被模型读到的话：插进去的在前，排着的按先后。 */
	waiting(sideId: string): Promise<WaitingEntry[]>;
	/** 排着的那条拿掉，返回它的字（收回时放回输入框）；已经发出去、是插进去的时是 undefined。 */
	unqueue(sideId: string, id: string): Promise<string | undefined>;
	/** 会话闲着时，排着的那条现在就发。 */
	sendNow(sideId: string, id: string): Promise<void>;
	/** 这个会话旁边最早开的那段侧边聊天接在哪个标签上；没有标签接着时是 undefined。 */
	firstTab(parentId: string): Promise<string | undefined>;
	stop(sideId: string): void;
	/** 关闭标签，删除绑定和对应子会话；卸载界面不能调用这里。 */
	close(tab: string): Promise<void>;
	/**
	 * 交出去的卡片上点了「开新会话」：在主会话的项目（不在项目里时是它的目录）里开一个新会话，第一句是卡上那条指令，
	 * 记着从这次调用开出来（`spawnedFrom`），用卡上选的模型和思考档位（`choice`，没选就是默认的），按卡上的开关决定做完送不送回这里。
	 * 同一张卡开过就不再开，返回开出来的会话 id。
	 */
	launch(sideId: string, callId: string, choice: LaunchChoice): Promise<string>;
	/** 这段侧边聊天的卡开过、还没归档的会话，新开的在前。 */
	opened(sideId: string): Promise<OpenedSession[]>;
	/** 这张卡开过的会话；没开过是 undefined。 */
	started(sideId: string, callId: string): Promise<string | undefined>;
}

/** 设置（`ctx.settings`），设置分区和面板经 `ui.useSettings` 读、改。 */
export interface SideChatSettings {
	/** 新的侧边聊天用的模型（`SessionModel.id`）；没选时是 undefined，跟随主会话。 */
	model: string | undefined;
}

export function normalizeSettings(saved: Record<string, unknown>): SideChatSettings {
	return { model: typeof saved.model === "string" && saved.model ? saved.model : undefined };
}
