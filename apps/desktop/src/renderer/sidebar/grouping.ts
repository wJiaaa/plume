/**
 * 把会话分成侧栏的三段：置顶、登记过的项目各自一组，其余的是「聊天」。
 *
 * 只看会话记下的项目 id，不看目录：同一个文件夹可以登记成几个项目，从文件夹认不出是哪一个；
 * 项目移除以后，它的会话记的 id 找不到项目，自然落到「聊天」。归档的会话不在侧栏，在设置 › 已归档的聊天。
 *
 * 空着的项目分两种，答案正好相反：一条会话都没有过的多半是刚建好的，要有地方点开第一段对话，始终占一行；
 * 会话全都归档了的是告一段落，打开「归档后收起项目」（hideEmptied）时跟着收起。默认不收：
 * 一个登记过的项目突然从侧栏消失，比多留一行更让人找不着北。
 */

import type { ProjectEntry, SessionSummary } from "@plume/contract";

import { orderedSessions } from "./order.ts";
import type { SessionSort } from "./order.ts";
export type { SessionSort } from "./order.ts";

export interface Group extends ProjectEntry {
	sessions: SessionSummary[];
}

export interface Grouped {
	/** 未归档的置顶会话，最近活动的在前，不再出现在项目和聊天中。 */
	pinned: SessionSummary[];
	/** 按保存的项目顺序；还没有会话的项目也占一行，会话全归档了的项目看 hideEmptied。 */
	projects: Group[];
	/** 不属于任何项目的会话，最近活动的在前。 */
	loose: SessionSummary[];
}

/** 一个项目里还列在侧栏上的会话（含置顶的）：项目菜单的「归档聊天」数的、归档的都是它们。 */
export function projectSessions(sessions: readonly SessionSummary[], projectId: string): SessionSummary[] {
	return sessions.filter((session) => session.project === projectId && session.title && !session.parentId && !session.owner && !session.archived);
}

export function groupSessions(
	sessions: readonly SessionSummary[],
	projects: readonly ProjectEntry[],
	hideEmptied = false,
	sort: SessionSort = "createdAt",
): Grouped {
	const byId = new Map<string, Group>(projects.map((project) => [project.id, { ...project, sessions: [] }]));
	const loose: SessionSummary[] = [];
	const pinned: SessionSummary[] = [];
	const activeIn = new Set<string>();
	/** 有归档会话的项目；其中一条没归档的都不剩的，就是「会话全归档了」。 */
	const archivedIn = new Set<string>();
	for (const session of sessions) {
		// 子会话（侧边聊天、子 Agent）画在它父会话的面板和卡片里，插件的独立会话画在插件自己的页面里，都不单独成行。
		if (!session.title || session.parentId || session.owner) continue;
		if (session.archived) {
			if (session.project) archivedIn.add(session.project);
			continue;
		}
		if (session.project) activeIn.add(session.project);
		if (session.pinned) {
			pinned.push(session);
			continue;
		}
		const group = session.project ? byId.get(session.project) : undefined;
		if (group) group.sessions.push(session);
		else loose.push(session);
	}
	// 默认按新建的先后排：一组只露前几条，排序跟着活动跳的话，点开一条、发一句，它就挪了位置。想按活动排的在列表设置里换。
	for (const group of byId.values()) group.sessions = orderedSessions(group.sessions, sort, group.sessionOrder);
	const listed = [...byId.values()].filter((group) => !(hideEmptied && !activeIn.has(group.id) && archivedIn.has(group.id)));
	return { pinned: pinned.sort((a, b) => b.updatedAt - a.updatedAt), projects: listed, loose: loose.sort((a, b) => b.updatedAt - a.updatedAt) };
}

/** 来自同一分组的后续会话才嵌套；严格早于后续会话的来源保证不会形成环。 */
export function nestSpawned(grouped: Grouped): Grouped & { spawned: Record<string, SessionSummary[]> } {
	const spawned: Record<string, SessionSummary[]> = {};
	const nest = (list: SessionSummary[]) => {
		const ids = new Map(list.map((session) => [session.id, session]));
		return list.filter((session) => {
			const source = session.spawnedFrom?.sessionId ?? session.forkedFrom?.sessionId;
			const parent = source ? ids.get(source) : undefined;
			if (!parent || parent.createdAt >= session.createdAt) return true;
			(spawned[parent.id] ??= []).push(session);
			return false;
		});
	};
	const result = {
		pinned: nest(grouped.pinned),
		projects: grouped.projects.map((group) => ({ ...group, sessions: nest(group.sessions) })),
		loose: nest(grouped.loose),
		spawned,
	};
	for (const children of Object.values(spawned)) children.sort((a, b) => a.createdAt - b.createdAt);
	return result;
}

export function withSpawned(list: readonly SessionSummary[], spawned: Record<string, SessionSummary[]>): SessionSummary[] {
	return list.flatMap((session) => [session, ...withSpawned(spawned[session.id] ?? [], spawned)]);
}
