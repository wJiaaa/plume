/**
 * 上一轮停在了没做完的地方没有，以及「继续」该说哪句话。
 */

import type { Message, SessionSummary, SessionView } from "@plume/contract";

/**
 * 停在半路的三种样子，读起来不一样：`user` 是人按了停，活没坏只是没在动；`interrupt` 是没被要求就停了
 * （退出应用、崩溃、步数用满）；`error` 是请求失败。`null` 是这一轮做完了。
 * 跟人说「上次执行被中断」而那其实是他自己一秒前按的停，等于把他的点击说成了一次事故。
 */
export type TurnStop = "user" | "interrupt" | "error" | null;

/**
 * 「继续」发的那几句。不翻译：它们是发给模型的话，不随界面语言变。第三句和 todo 插件卡片上「继续」发的是同一句。
 */
// i18n-exempt：发给模型的文本。
export const CARRY_ON_PROMPTS = ["继续，从暂停的地方接着做。", "继续，从中断的地方接着做。", "继续，把清单里没做完的做完。"] as const;

export function howItStopped(summary: SessionSummary, messages: readonly Message[]): TurnStop {
	const reason = summary.stop?.reason;
	if (reason === "aborted") return "user";
	// 被安全策略拦下的是真的结束了：接着做只会被同样地拦一次。
	const last = messages.findLast((message) => message.role === "assistant");
	if (last?.role === "assistant" && last.stopReason === "error" && last.failure?.hint === "blocked") return null;
	if (reason === "error") return "error";
	if (reason === "interrupted" || reason === "max_turns" || reason === "stalled") return "interrupt";
	if (reason === "done") return null;
	// 没有记录：进程在这一轮当中没了，只能看转录停在了哪。
	return wasCutShort(beforePlanTick(messages)) ? "interrupt" : null;
}

/**
 * 去掉回答之后补勾清单的那一段：[回答] [替人追问清单（todo 插件的清单收尾）] [只调 todo_write] [它的结果]。
 *
 * 这一轮停在工具结果上，却不是没说完：回答在它前面已经说完了，补勾之后有意不再要一段正文。
 * 只认这一种形状：同样停在 todo_write 结果上、前面却没有那句替人说的话，仍是真被打断（比如勾完清单
 * 正要写回答时退了应用），回答确实没来。
 */
export function beforePlanTick(messages: readonly Message[]): readonly Message[] {
	let at = messages.length - 1;
	while (ticked(messages[at])) at--;
	if (at === messages.length - 1 || !isPlanTick(messages, at)) return messages;
	return messages.slice(0, at - 1);
}

const ticked = (message: Message | undefined) => message?.role === "toolResult" && message.toolName === "todo_write";

/**
 * `messages[at]` 是不是回答之后补勾清单的那条回复，形状见 `beforePlanTick`。
 *
 * 转录分组也用它：补勾不该在回答下面再画一行，读起来像回答完又动手干了点什么。所以它不只在末尾成立：
 * 补勾之后人又说了话也算；补勾之后模型接着干了活就不算，那是在回答追问里的「真是漏做了，就接着做完」，
 * 这次 todo_write 是新一段工作的开头。
 */
export function isPlanTick(messages: readonly Message[], at: number): boolean {
	const tick = messages[at];
	if (tick?.role !== "assistant" || !tick.content.some((part) => part.type === "toolCall")) return false;
	if (!tick.content.every((part) => (part.type === "toolCall" ? part.name === "todo_write" : part.type !== "text" || !part.text.trim()))) return false;
	const asked = messages[at - 1];
	const answer = messages[at - 2];
	if (asked?.role !== "user" || !asked.synthetic) return false;
	if (answer?.role !== "assistant" || answer.content.some((part) => part.type === "toolCall")) return false;
	let next = at + 1;
	while (ticked(messages[next])) next++;
	return messages[next]?.role !== "assistant";
}

/** 转录停在半路：最后是工具结果（答案没来），或者最后那条回复要的工具还没有结果。 */
function wasCutShort(messages: readonly Message[]): boolean {
	if (messages.at(-1)?.role === "toolResult") return true;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const calls = message.content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) return false;
		const answered = new Set(messages.slice(i + 1).flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])));
		return calls.some((call) => call.type === "toolCall" && !answered.has(call.id));
	}
	return false;
}

/**
 * 最新那份清单里还没勾完的项数。清单是 todo 插件的，本体按工具名和结果 `details` 的形状（`{ kind: "todo", todos }`）认，
 * 和转录里「更新清单 3/5」那一行一样；`todo_write` 每次发整张清单，只有最新一条成功的结果算数。没有清单就是 0。
 */
export function unfinishedTodos(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;
		const details = message.details as { kind?: unknown; todos?: unknown } | undefined;
		if (details?.kind !== "todo" || !Array.isArray(details.todos)) continue;
		return details.todos.filter((todo: { status?: unknown } | null) => todo?.status !== "completed").length;
	}
	return 0;
}

/**
 * 这样停下以后「继续」说哪句；`null` 是没有可接着做的。
 * 最后一种最安静：什么都没出错，模型自己收了尾，清单却还有没勾的。没人提，那份计划就一直停在那里。
 */
export function carryOnPrompt(stop: TurnStop, unfinished: number): (typeof CARRY_ON_PROMPTS)[number] | null {
	if (stop === "user") return CARRY_ON_PROMPTS[0];
	if (stop === "error" || stop === "interrupt") return CARRY_ON_PROMPTS[1];
	return unfinished > 0 ? CARRY_ON_PROMPTS[2] : null;
}

export type Resume = { stop: TurnStop; unfinished: number; prompt: (typeof CARRY_ON_PROMPTS)[number] };

/**
 * 转录末尾那一行「已暂停 · 继续」：怎么停的、还剩几项、「继续」说哪句；不出这一行是 `null`。
 * 运行行也读它：有这一行接着它的位置，运行行就当帧收起，两行同一帧一出一进（见 `RunningRow`）。
 */
export function resumeOf(view: SessionView): Resume | null {
	// 派出去的后台运行还没回来，活就没停：它们回来，主会话接着干。先判这条，跑着时每一拍都不用扫整份转录。
	if (view.summary.running || view.summary.background || view.messages.length === 0) return null;
	const stop = howItStopped(view.summary, view.messages);
	const unfinished = unfinishedTodos(view.messages);
	const prompt = carryOnPrompt(stop, unfinished);
	if (!prompt) return null;
	// 失败那件事，上面的连接记录已经讲完了，还带着它自己的「继续」，这里不再讲一遍。
	if (stop === "error" && view.hiccups.some((hiccup) => hiccup.outcome === "gave_up")) return null;
	return { stop, unfinished, prompt };
}
