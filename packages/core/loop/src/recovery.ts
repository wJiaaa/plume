/**
 * 一条回复本该收场，却其实没说完：撞上输出上限的接着写，一个字没写的催一句。
 *
 * 这是 `step.end` 最里层的自然结论，只在本来要结束的那一步说话（有工具结果时循环反正接着做）。
 * 外面的插件层不调 `next` 就整个换掉它。两件事各有上限：接着写三次还撞上限就停下提示一句；
 * 催三次还是空的就以出错结束，再催只是在烧钱。一轮一份，每一轮从头数。
 */

import type { AssistantMessage, NoticeLevel, StepVerdict } from "@plume/contract";
import { text } from "./i18n.ts";

/** 连着几次撞上输出上限还让它接着写。 */
const MAX_CONTINUES = 3;
/** 一轮里最多催几次空回复。 */
const MAX_NUDGES = 3;
const PROGRESS_EVERY = 20;

// i18n-exempt：发给模型的话，不随界面语言变。
const CONTINUE_AFTER_LENGTH = "（自动继续）上一条回复达到了输出长度上限，在中途被截断。请从断开的地方直接接着写，不要重复已经写出的内容。";
// i18n-exempt：发给模型的话，不随界面语言变。
const EMPTY_REPLY_NUDGE = "（自动继续）上一条回复没有正文。请给出回答；如果需要用户补充信息，请直接提问并等待回复。";
// i18n-exempt：发给模型的话，不随界面语言变。
const PROGRESS_NOTE =
	`（自动提示）你已经连续 ${PROGRESS_EVERY} 次请求没有对用户说过话了。这次回复里先用一两句话说明现在在做什么、下一步做什么；` +
	"不要给阶段性结论，没核实的发现别说成定论。然后在同一次回复里接着调用下一步的工具，不要停下来等回复。不需要为此新建任务清单。";

export class Recovery {
	/** 连着撞上输出上限的回复数，带不带工具都算；一条没撞上的就清零。 */
	private truncated = 0;
	private nudges = 0;
	private unreported = 0;

	/** 每一步都要看：不管这一步之后谁来下结论，连着截断的计数都得接着数。 */
	observe(reply: AssistantMessage): number {
		this.truncated = reply.stopReason === "length" ? this.truncated + 1 : 0;
		return this.truncated;
	}

	/** 调工具的每一步都算；插件可以把「汇报」换成更新清单，但次数和提醒间隔仍由循环维护。 */
	progress(reply: AssistantMessage, progress?: { reported: boolean; reminder: string }): string | undefined {
		const reported = progress?.reported ?? !saidNothing(reply);
		this.unreported = reported ? 0 : this.unreported + 1;
		if (this.unreported < PROGRESS_EVERY) return undefined;
		this.unreported = 0;
		return progress?.reminder ?? PROGRESS_NOTE;
	}

	/**
	 * 没有工具结果、本来要结束的那一步怎么走。`awaiting` 是插件给的「还在等后台」时的催促（`StepEnd.awaiting`）：
	 * 这时「请给出回答」是在要结论，逼出来的是一句还没等到结果的定论，所以换成它那句。
	 */
	verdict(reply: AssistantMessage, notice: (text: string, level?: NoticeLevel) => void, awaiting?: string): StepVerdict {
		if (reply.stopReason === "length") {
			// 步数用完也照说：循环会以「用满步数」收场，人点「继续」时模型读到的也是这句，而不是半截回复。
			if (this.truncated <= MAX_CONTINUES) return { continue: true, say: CONTINUE_AFTER_LENGTH };
			notice(text("loop.outputLimit"), "warn");
			// 说了「已停下」就真停，不再把只有思考的那种截断当空回复去催。
			return { continue: false };
		}
		if (!saidNothing(reply)) return { continue: false };
		if (this.nudges >= MAX_NUDGES) return { continue: false, reason: "error", error: text("loop.emptyReplies") };
		this.nudges += 1;
		return { continue: true, say: awaiting || EMPTY_REPLY_NUDGE };
	}
}

function saidNothing(reply: AssistantMessage): boolean {
	return reply.content.every((part) => part.type !== "text" || !part.text.trim());
}
