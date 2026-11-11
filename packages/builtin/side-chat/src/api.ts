/** 逻辑入口经 `ctx.serve` 开给界面入口的接口。 */

import type { SessionMessage } from "@plume/contract";
import type { SessionChoice } from "@plume/contract/ui";

export interface SideChatEntry {
	id: string;
	/** 第一问的开头；还没问过是空字符串。 */
	title: string;
	createdAt: number;
}

export interface SideChatApi {
	/** 按稳定标签恢复绑定；首次打开只认领未绑定的最新一段，没有则保持空白。 */
	bind(tab: string, parentId: string): Promise<string | undefined>;
	/** 接回这个标签的侧边聊天，没有才新建（按人在第一句之前选的 `choice` 建）；绑定落盘后返回，重复调用不会多建。 */
	open(tab: string, parentId: string, choice?: SessionChoice): Promise<string>;
	/** 在侧边聊天里问一句，等它答完。排队条上拿过来的那条带着附件，整条照发。 */
	ask(sideId: string, message: string | SessionMessage): Promise<void>;
	/** 这个会话旁边最早开的那段侧边聊天接在哪个标签上；没有标签接着时是 undefined。 */
	firstTab(parentId: string): Promise<string | undefined>;
	stop(sideId: string): void;
	/** 关闭标签，删除绑定和对应子会话；卸载界面不能调用这里。 */
	close(tab: string): Promise<void>;
	/** 新的侧边聊天用的模型（`SessionModel.id`）；没选时是 undefined，跟随主会话。 */
	model(): Promise<string | undefined>;
	setModel(model: string | undefined): Promise<void>;
	/**
	 * 交出去的卡片上点了「开新会话」：在主会话的项目（不在项目里时是它的目录）里开一个新会话，第一句是卡上那条指令，
	 * 记着从这次调用开出来（`spawnedFrom`）。同一张卡开过就不再开，返回开出来的会话 id。
	 */
	launch(sideId: string, callId: string): Promise<string>;
	/** 这张卡开过的会话；没开过是 undefined。 */
	started(sideId: string, callId: string): Promise<string | undefined>;
}
