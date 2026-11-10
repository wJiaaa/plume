/**
 * 删除会话前问的那句话，已归档的页和会话菜单（打开着的已归档会话的标题栏）共用一份。
 *
 * 说出删掉的有多少条消息；从它分叉、由它开出来的后续会话不跟着删，各自留下成独立的会话，这一点说出来，
 * 第二个按钮是连它们一起删。插件管的东西（工作树）由插件经删除提示各补一行，人确认前就知道会留下什么。
 */

import type { Locale, SessionSummary } from "@plume/contract";
import { type ConfirmOptions, translate } from "@plume/ui";
import { deleteNotes } from "../plugins.tsx";
import { nestSpawned, withSpawned } from "./grouping.ts";

/**
 * 从它的后续会话，以及后续会话的后续会话，归不归档都算。
 *
 * 不只是侧栏此刻画在它下面的：能删的只有已归档的，已归档的来源不在列表里，它的后续会话在侧栏上早已各自独立。
 * 删掉它改变的是这些会话再也回不到它下面。谁算谁的后续，规则和侧栏的嵌套一样，只是放在一张平铺的列表上。
 */
function nestedUnder(session: SessionSummary, sessions: readonly SessionSummary[]): SessionSummary[] {
	const { spawned } = nestSpawned({ pinned: [], projects: [], loose: sessions.filter((each) => !each.parentId && !each.owner) });
	return withSpawned([session], spawned).slice(1);
}

export async function deleteSessionQuestion(
	session: SessionSummary,
	sessions: readonly SessionSummary[],
	locale: Locale,
	remove: (sessionIds: string[]) => void,
): Promise<ConfirmOptions> {
	const title = session.title || translate("sessionOps.newSession");
	const nested = nestedUnder(session, sessions);
	const notes = await deleteNotes(session.id, locale);
	const note = "mt-1.5 block break-words";
	return {
		title: translate("sidebarList.deleteConfirm"),
		detail: (
			<>
				{translate("sidebarList.deleteDetail", { title, n: session.messageCount ?? 0 })}
				{nested.length > 0 && (
					<span data-plume-delete-nested="" className={note}>
						{translate("sidebarList.deleteNested", { n: nested.length })}
					</span>
				)}
				{notes.map((text) => (
					<span key={text} className={note}>
						{text}
					</span>
				))}
			</>
		),
		confirmLabel: nested.length ? translate("sidebarList.deleteOnlyThis") : translate("common.delete"),
		// 后续会话先删：先删来源的话，它们会在删掉之前那一下浮到顶层。
		alternate: nested.length
			? { label: translate("sidebarList.deleteWithNested", { n: nested.length + 1 }), onConfirm: () => remove([...nested.map((each) => each.id), session.id]) }
			: undefined,
		onConfirm: () => remove([session.id]),
	};
}
