/**
 * 派出去的子代理还没回来时，别让父会话抢先交结论。
 *
 * `task` 当场交回「已派出」，模型接着做手上的事；接着读上六到八次请求，它就把那句话忘了，把写最终回答也算成
 * 「不依赖它们的事」，交完结论子代理才回来，又整段重写一遍。结论要等派出去的都回来、合并之后才写，所以这里做三件事：
 *
 * - 隔几次带工具的请求把「还在等谁」再说一遍（`AWAIT_EVERY`），话跟着下一次请求走，不单独占请求；
 * - 收尾不追问清单：经 `StepEnd.awaiting` 告诉里层，清单插件见到它就不问——那一项没勾是因为在等子代理；
 * - 空回复的催促换一种说法（`StepEnd.awaiting.nudge`）：要的是一句「在等谁」，不是「请给出回答」。
 *
 * 只对父会话说：子代理手里没有 `task`。
 */

import type { TaskRecord } from "./types.ts";

type Awaited = Pick<TaskRecord, "id" | "agent" | "description">;

/**
 * 多少次带工具的请求没听到「还在等谁」就说一遍。抢先交结论的多在派出或送达后的第 6 到 8 次请求，
 * 第 4 次之后说，下一次请求就带上它，最早的那种也赶得上；每句几十个 token。
 */
const AWAIT_EVERY = 4;

// i18n-exempt：发给模型的话。
function awaitingNote(pending: readonly Awaited[]): string {
	return (
		`（自动提示）派出去的子代理还有 ${pending.length} 个没回来：${names(pending)}。` +
		"在它们回来之前不要给用户写结论或总结：你手上的只是一部分，最终回答等它们都送到、合并之后再写。" +
		"手上还有不依赖它们的事就接着做；做完了就用一两句话告诉用户还在等谁，结束这一轮——它们回来时会自动送到。"
	);
}

// i18n-exempt：发给模型的话。
export function awaitingEmptyNudge(pending: readonly Awaited[]): string {
	return (
		`（自动继续）上一条回复没有正文。派出去的子代理还有 ${pending.length} 个没回来：${names(pending)}。` +
		"用一两句话告诉用户现在在等谁，然后结束这一轮；不要写结论，它们回来时会自动送到。"
	);
}

// i18n-exempt：拼进发给模型的话里，跟着上面的提示词用中文标点。
function names(pending: readonly Awaited[]): string {
	return pending.map((one) => `${one.agent}（${one.description}）`).join("、");
}

/** 一轮一只。名单变了（派了新的、回来了一个）模型当场就看到了，从那儿重新数。 */
export class AwaitWatch {
	private seen = "";
	private since = 0;

	/**
	 * 一次带工具的请求跑完了：该不该把「还在等谁」再说一遍。
	 *
	 * 名单变了不说：派出的那一步工具结果里就是「已派出」，回来的那一份送达里点了名还在等谁。
	 */
	afterTools(pending: readonly Awaited[]): string | undefined {
		const key = pending.map((one) => one.id).join("\n");
		if (key !== this.seen) {
			this.seen = key;
			this.since = 0;
			return undefined;
		}
		if (pending.length === 0) return undefined;
		this.since += 1;
		if (this.since < AWAIT_EVERY) return undefined;
		this.since = 0;
		return awaitingNote(pending);
	}
}
