/**
 * `ModelContext` 里的 `systemPrompt` 是 `sections` 拼出来的：洋葱的每一层交接时重拼一次，哪一层读到的都和段落对得上。
 * 系统提示词只按段改；直接改 `systemPrompt` 的不作数，下一次交接就被段落拼出来的盖掉。
 */

import type { ModelContext, PromptSection } from "@plume/contract";

/** 段与段之间空一行。 */
function joinSections(sections: readonly PromptSection[]): string {
	return sections
		.map((section) => section.text)
		.filter((text) => text !== "")
		.join("\n\n");
}

/** 插件交回来的段落表像不像样：不像样的整个上下文按「不完整」处理。 */
export function validSections(sections: unknown): sections is PromptSection[] {
	return Array.isArray(sections) && sections.every((section) => typeof section?.id === "string" && typeof section?.text === "string");
}

/** 按段落重拼 `systemPrompt`。形状不对的原样交回，由调用方按「上下文不完整」处理。 */
export function settlePrompt<T extends ModelContext>(context: T): T {
	if (!validSections(context?.sections)) return context;
	const systemPrompt = joinSections(context.sections);
	return systemPrompt === context.systemPrompt ? context : { ...context, systemPrompt };
}
