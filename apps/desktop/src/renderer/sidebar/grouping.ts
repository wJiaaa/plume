/**
 * 把会话分成侧栏的三段：置顶、登记过的项目各自一组，其余的是「聊天」；置顶上面的「进行中」是镜像，见 `activeSessions`。
 *
 * 只看会话记下的项目 id，不看目录：同一个文件夹可以登记成几个项目，从文件夹认不出是哪一个；
 * 项目移除以后，它的会话记的 id 找不到项目，自然落到「聊天」。归档的会话不在侧栏，在设置 › 已归档的聊天。
 *
 * 空着的项目分两种，答案正好相反：一条会话都没有过的多半是刚建好的，要有地方点开第一段对话，始终占一行；
 * 会话全都归档了的是告一段落，打开「归档后收起项目」（hideEmptied）时跟着收起。默认不收：
 * 一个登记过的项目突然从侧栏消失，比多留一行更让人找不着北。
 */

import type { ProjectEntry, SessionSummary } from "@plume/contract";

import { orderedSessions, projectSort } from "./order.ts";
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
	return sessions.filter((session) => session.project === projectId && session.title && session.kind === "top" && !session.archived);
}

export function groupSessions(
	sessions: readonly SessionSummary[],
	projects: readonly ProjectEntry[],
	hideEmptied = false,
	sort: SessionSort = "createdAt",
	/** 拖过、单独切成手动排序的项目。 */
	dragged: readonly string[] = [],
): Grouped {
	const byId = new Map<string, Group>(projects.map((project) => [project.id, { ...project, sessions: [] }]));
	const loose: SessionSummary[] = [];
	const pinned: SessionSummary[] = [];
	const activeIn = new Set<string>();
	/** 有归档会话的项目；其中一条没归档的都不剩的，就是「会话全归档了」。 */
	const archivedIn = new Set<string>();
	for (const session of sessions) {
		// 子会话（侧边聊天、子 Agent）画在它父会话的面板和卡片里，插件的独立会话画在插件自己的页面里，都不单独成行。
		if (!session.title || session.kind !== "top") continue;
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
	for (const group of byId.values()) group.sessions = orderedSessions(group.sessions, projectSort(group.id, sort, dragged), group.sessionOrder);
	const listed = [...byId.values()].filter((group) => !(hideEmptied && !activeIn.has(group.id) && archivedIn.has(group.id)));
	return { pinned: pinned.sort((a, b) => b.updatedAt - a.updatedAt), projects: listed, loose: loose.sort((a, b) => b.updatedAt - a.updatedAt) };
}

/**
 * 置顶上面的「进行中」：有事的会话（在跑、等人、人没看着时跑完或出错，由 `engaged` 判断）在这里多列一份，原来的分组里照样有它。
 * 是镜像不是挪过去：状态几秒就变一次，挪来挪去的话正要点的那一行会从指针底下跑掉，也看不出它属于哪个项目。
 *
 * `previous` 是上一次的结果。已经在列的保持原来的先后，新来的接在最后（同时来的按最后活动先后），不按活动重排：
 * 在跑的会话一直在更新，按活动排的话这一段自己就在跳。事办完了、但人正开着它（`lit`）的先留着：
 * 刚点开一条跑完的，打开就算看过、记号随即清掉，它不该在点下去的那一刻消失；切走以后再撤。
 */
export function activeSessions(
	previous: readonly string[],
	sessions: readonly SessionSummary[],
	engaged: (session: SessionSummary) => boolean,
	lit: ReadonlySet<string>,
): SessionSummary[] {
	// 和分组一样只认侧栏上单独成行的会话；子会话在跑、在等都已经算在父会话上。
	const listed = new Map(sessions.filter((session) => session.title && session.kind === "top" && !session.archived).map((session) => [session.id, session]));
	const kept = previous.flatMap((id) => {
		const session = listed.get(id);
		return session && (engaged(session) || lit.has(id)) ? [session] : [];
	});
	const keptIds = new Set(kept.map((session) => session.id));
	const joined = [...listed.values()].filter((session) => !keptIds.has(session.id) && engaged(session)).sort((a, b) => a.updatedAt - b.updatedAt);
	return [...kept, ...joined];
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
