/** 循环里交给界面的文字，语言由 agent 的 `setLocale` 同步。发给模型的文字不随界面语言变。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	"loop.argumentsLost": "模型服务连续 3 轮丢失了工具调用的参数，请更换模型或服务商后重试。",
	"loop.truncatedCalls": "回复连续多次在工具参数写到一半时达到输出长度上限，已停下。可以让它把内容拆小，或换一个输出上限更大的模型。",
	"loop.requestRejected": "模型服务拒收了这次请求。已把其中过大的工具输出压成一行，正在重试。",
	"loop.contextOverflow": "上下文超出了模型的上限，正在压缩历史后重试。",
	"loop.outputLimit": "回复连续多次达到输出长度上限，已停下。最后一段回答可能不完整。",
	"loop.emptyReplies": "模型连续返回空回复，请重试或更换模型。",
	"loop.stalled": "同一个调用反复得到相同结果，已停下。告诉它换个方向，或直接说明你想怎么处理。",
	"loop.badStepVerdict": "step.end 返回的结论不认得，已按默认方式接着走。",
	"session.callEnded": "这次工具调用已经结束，它拿到的 {what} 不能再用",
} as const;

type TextKey = keyof typeof zhCN;

const en: Record<TextKey, string> = {
	"loop.argumentsLost": "The model provider lost tool arguments for 3 consecutive rounds. Try a different model or provider.",
	"loop.truncatedCalls":
		"The reply kept hitting the output limit halfway through a tool call, so the run stopped. Ask it to split the work into smaller pieces, or switch to a model with a larger output limit.",
	"loop.requestRejected": "The provider refused this request. Oversized tool output was cut to one line each, and it is being sent again.",
	"loop.contextOverflow": "The conversation no longer fits in the model's context window. Compacting the history, then retrying.",
	"loop.outputLimit": "Stopped after several replies in a row ran into the output length limit. The last answer may be cut off.",
	"loop.emptyReplies": "The model kept returning empty replies. Try again or switch models.",
	"loop.stalled": "Stopped: the same call kept coming back with the same result. Point it somewhere else, or say how you want this handled.",
	"loop.badStepVerdict": "step.end returned a verdict it could not use; carried on as usual.",
	"session.callEnded": "This tool call has ended; the {what} it was given can no longer be used",
};

const CATALOGS: Record<Locale, Record<TextKey, string>> = { "zh-CN": zhCN, en };

let active: Locale = "zh-CN";

export function setLocale(locale: Locale): void {
	if (locale in CATALOGS) active = locale;
}

/** 一句给人看的话，默认用界面语言；导出可固定本次的语言，不改进程状态。 */
export function text(key: TextKey, variables?: Readonly<Record<string, string | number>>, locale: Locale = active): string {
	const template = CATALOGS[locale][key];
	if (!variables) return template;
	return template.replace(/\{([^}]+)\}/g, (match, name: string) => {
		const value = variables[name];
		return value === undefined ? match : String(value);
	});
}
