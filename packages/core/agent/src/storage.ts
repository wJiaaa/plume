/**
 * 会话记录占了多少地方，以及按时间段删掉哪些。
 *
 * 删的单位是一整条会话（连同它的子会话），不是某几条消息：按天把一条会话中间几段剜掉，留下的是一份读不通的对话。所以时间段筛的是
 * 最后活动的那一天，一条八月建、昨天还在写的会话属于昨天。花销另记在会话库的 `spend` 表里，删会话收回的只有空间，
 * 账不跟着少。
 */

import type { ClearRange, SessionSummary, StorageDay, StorageUse } from "@plume/contract";

/** 本地日期键，和使用统计、日期选择器是同一个口径，不是 UTC。 */
function dayKey(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** 最后活动日落在这一段里吗。两头都含当天，空的那头不设限。 */
export function withinRange(summary: Pick<SessionSummary, "updatedAt">, range: ClearRange): boolean {
	const day = dayKey(summary.updatedAt);
	if (range.from && day < range.from) return false;
	if (range.to && day > range.to) return false;
	return true;
}

/**
 * 统计和清理的单位：顶层会话，连同挂在它下面的子会话（侧边聊天、子 Agent）。子会话的大小算在它头上，跟着它删，
 * 不按自己的最后活动日单独挑：子 Agent 一个月前跑完、父会话昨天还在用，单独删掉它，父会话里那个任务就只剩个空壳，
 * 侧边聊天的标签也成了空的。父会话已经不在的子会话自己算一棵。
 */
export function sessionTrees(summaries: readonly SessionSummary[], sizes: ReadonlyMap<string, number>): { summary: SessionSummary; bytes: number }[] {
	const ids = new Set(summaries.map((summary) => summary.id));
	const rootOf = (summary: SessionSummary) => (summary.parentId && ids.has(summary.parentId) ? summary.parentId : summary.id);
	const bytes = new Map<string, number>();
	for (const summary of summaries) bytes.set(rootOf(summary), (bytes.get(rootOf(summary)) ?? 0) + (sizes.get(summary.id) ?? 0));
	return summaries.filter((summary) => rootOf(summary) === summary.id).map((summary) => ({ summary, bytes: bytes.get(summary.id) ?? 0 }));
}

/**
 * 会话记录一共占多少，按顶层会话的最后活动日摊开（见 `sessionTrees`）。数的是记录本身，不是整个库文件：库里还有花销表和
 * 空闲页，删会话收不回来，算进来的话「删了却没少多少」就成了常态。
 */
export function storageUse(summaries: readonly SessionSummary[], sizes: ReadonlyMap<string, number>): StorageUse {
	const byDay = new Map<string, StorageDay>();
	const trees = sessionTrees(summaries, sizes);
	let bytes = 0;
	for (const { summary, bytes: size } of trees) {
		const day = dayKey(summary.updatedAt);
		const seen = byDay.get(day) ?? { day, sessions: 0, bytes: 0 };
		seen.sessions += 1;
		seen.bytes += size;
		bytes += size;
		byDay.set(day, seen);
	}
	const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
	return { bytes, sessions: trees.length, earliest: days[0]?.day ?? null, latest: days.at(-1)?.day ?? null, days };
}
