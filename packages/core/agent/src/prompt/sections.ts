/**
 * `ModelContext` 里系统提示词的两种写法——整段 `systemPrompt` 和分段 `sections`——在洋葱的每一层交接时对齐。
 *
 * 两种写法都留着：往末尾接一句的插件直接拼字符串最顺手，要换掉某一段的插件按段改才不用在一整段字里找位置。
 * 只在交接时对齐、不在最里层一次算：外层往字符串后面接了一句，里层按段改时要看得到它，否则拼回去时那句就丢了。
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

/**
 * 一层把 `before` 改成了 `after`：只改了段落就重新拼字符串；只改了字符串，接在后面的那截成为末尾的 `extension` 段，
 * 整个换掉的则只剩一段 `extension`；两个都改了以段落为准（段落是结构化的，字符串可能只是没跟上）。
 * 形状不对的原样交回，由调用方按「上下文不完整」处理。
 */
export function settlePrompt<T extends ModelContext>(before: ModelContext, after: T): T {
	if (typeof after?.systemPrompt !== "string" || !validSections(after.sections)) return after;
	const sectionsChanged = !validSections(before.sections) || !sameSections(before.sections, after.sections);
	if (sectionsChanged) {
		const systemPrompt = joinSections(after.sections);
		return systemPrompt === after.systemPrompt ? after : { ...after, systemPrompt };
	}
	if (after.systemPrompt === before.systemPrompt) return after;
	const appended = after.systemPrompt.startsWith(before.systemPrompt) ? after.systemPrompt.slice(before.systemPrompt.length).trim() : undefined;
	const sections =
		appended === undefined
			? [{ id: "extension", text: after.systemPrompt }]
			: appended === ""
				? after.sections
				: [...after.sections, { id: "extension", text: appended }];
	// 字符串也按段重拼：接上的那截前面换成一个空行，之后里层再按段改，拼出来的还是同一个样子。
	return { ...after, sections, systemPrompt: joinSections(sections) };
}

function sameSections(a: readonly PromptSection[], b: readonly PromptSection[]): boolean {
	return a === b || (a.length === b.length && a.every((section, index) => section.id === b[index]?.id && section.text === b[index]?.text));
}
