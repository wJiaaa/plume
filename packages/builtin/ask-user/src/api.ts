/** 逻辑入口经 `ctx.serve` 开给提问卡的接口。 */

import type { QuestionReply } from "./question.ts";

export interface AskUserApi {
	/** 交回人在卡上的回答，卡片随后再 `respond`。问题已经不等了、回答和问题对不上时报错（给人看的话）。 */
	answer(id: string, reply: QuestionReply): Promise<void>;
}
