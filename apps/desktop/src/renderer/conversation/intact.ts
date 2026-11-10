/**
 * 把一条坏记录挡在渲染之外：挡住，而不是指望它不出现。
 *
 * 转录里一个空位或一条没有 `content` 的记录，会在分行、分块的某一处报 `Cannot read properties of undefined`，整个窗口白掉。
 * 坏记录从哪来是另一个问题，一条坏记录不该让人失去整个窗口。位置必须保住，所以是替换不是过滤：连接记录、压缩分隔都是
 * 指进这个数组的下标，抽掉一条它们就整体错位一格。`Array.from` 而不是 `map`：稀疏数组的空洞会被 `map` 跳过、原样留下。
 */

import type { Message } from "@plume/contract";
import { translate } from "@plume/ui";

export function intact(messages: readonly Message[]): readonly Message[] {
	// 没坏就原样交回同一个引用：转录处处靠引用相等决定要不要重算，每次交出新数组等于每次渲染全部重算。
	let damaged = 0;
	for (let index = 0; index < messages.length; index++) if (!whole(messages[index])) damaged++;
	if (damaged === 0) return messages;
	report(messages, damaged);
	return Array.from({ length: messages.length }, (_, index) => {
		const message = messages[index];
		return whole(message) ? message : damagedRow();
	});
}

function whole(message: Message | undefined): message is Message {
	return Boolean(message && typeof message === "object" && typeof message.role === "string" && Array.isArray(message.content));
}

/**
 * 用 `assistant` 而不是造一个新门类：这一条要穿过分行、分块和每一种行，它们全都认得这个形状。画成一次什么都没产出的失败，
 * 说明写在出错的那一句里：只有这一行，不多出一个页脚。
 */
function damagedRow(): Message {
	return { role: "assistant", content: [], timestamp: 0, stopReason: "error", errorMessage: translate("transcript.damagedRecord") } as unknown as Message;
}

/**
 * 留下痕迹：第几条、前后是什么、是空洞还是别的。控制台而不是弹窗，读它的人是在翻日志找来源，不是在用这个应用，
 * 所以也是英文、不走 i18n。
 */
function report(messages: readonly Message[], damaged: number): void {
	const spots: string[] = [];
	for (let index = 0; index < messages.length && spots.length < 5; index++) {
		const message = messages[index];
		if (whole(message)) continue;
		const hole = !(index in messages);
		const before = messages[index - 1];
		const after = messages[index + 1];
		spots.push(
			`#${index}${hole ? " (array hole)" : ` (${message === null ? "null" : typeof message})`} prev=${before && typeof before === "object" ? before.role : "-"} next=${after && typeof after === "object" ? after.role : "-"}`,
		);
	}
	console.error(
		`[transcript] ${damaged} of ${messages.length} records were unreadable and have been replaced in place, so the view stays up:\n  ${spots.join("\n  ")}`,
	);
}
