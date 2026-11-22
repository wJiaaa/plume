/**
 * 删除会话前问的那句话，已归档的页和会话菜单（侧栏行、标题栏）共用一份。
 *
 * 说出删掉的有多少条消息；从它分叉、由它开出来的后续会话不跟着删，各自留下成独立的会话，这一点说出来，
 * 第二个按钮是连它们一起删。插件管的东西（工作树）由插件经删除提示各补一行，人确认前就知道会留下什么。
 */

import type { Locale, SessionSummary } from "@plume/contract";
import { type ConfirmOptions, translate } from "@plume/ui";
import { createContext } from "react";
import { deleteNotes } from "../plugins.tsx";
import { nestSpawned, withSpawned } from "./grouping.ts";

/**
 * 侧栏的会话行要问「删不删」时找的那一位：确认框挂在列表上，一张列表一个，不是每行一个；算后续会话要整张会话列表，
 * 也只有列表手里有，放进行的属性里，会话一变每一行都得重画。没有提供方的地方，菜单不列「删除」。
 */
export const RequestDeleteContext = createContext<((session: SessionSummary) => void) | null>(null);

/**
 * 从它的后续会话，以及后续会话的后续会话，归不归档都算。
 *
 * 不只是侧栏此刻画在它下面的：已归档的来源不在侧栏里，它的后续会话在侧栏上早已各自独立；
 * 删掉它改变的是这些会话再也回不到它下面。谁算谁的后续，规则和侧栏的嵌套一样，只是放在一张平铺的列表上。
 */
function nestedUnder(session: SessionSummary, sessions: readonly SessionSummary[]): SessionSummary[] {
	const { spawned } = nestSpawned({ pinned: [], projects: [], loose: sessions.filter((each) => each.kind === "top") });
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
