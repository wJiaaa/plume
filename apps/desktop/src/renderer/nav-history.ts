/**
 * 后退、前进：窗口去过哪些地方，按下时去哪一个。这里只有规则，记录和跳转在 app.tsx 的状态里。
 *
 * 一个地方是一个界面，会话界面还要加上开着的是哪个会话；其他界面不管开着哪个会话都算同一个地方。
 */

/** 窗口主区域的几个界面。插件的页面是 `page:插件名/id`。 */
export type Screen = "chat" | "settings" | "market" | `page:${string}`;

export interface NavEntry {
	screen: Screen;
	/** 只对会话界面有意义；null 是还没打开会话的空白页。 */
	sessionId: string | null;
}

export interface NavHistory {
	entries: NavEntry[];
	index: number;
}

/** 判断一个地方现在还能不能去要知道的事。 */
export interface NavSnapshot {
	currentId: string | null;
	/** 会话还在不在：删掉的会话回不去。 */
	exists: (sessionId: string) => boolean;
	/** 插件的页面还在不在：插件停用、卸下以后回不去。 */
	hasPage: (screen: `page:${string}`) => boolean;
}

/** 一下午怎么来回都够，又不至于有人去翻它。 */
const NAV_LIMIT = 100;

export const EMPTY_HISTORY: NavHistory = { entries: [], index: -1 };

export function sameEntry(a: NavEntry, b: NavEntry): boolean {
	return a.screen === b.screen && (a.screen !== "chat" || a.sessionId === b.sessionId);
}

/** 把 `entry` 记成当前位置：和浏览器一样，当前位置往前的记录都丢掉。 */
export function record(history: NavHistory, entry: NavEntry): NavHistory {
	const current = history.entries[history.index];
	if (current && sameEntry(current, entry)) return history;
	const entries = [...history.entries.slice(0, history.index + 1), entry].slice(-NAV_LIMIT);
	return { entries, index: entries.length - 1 };
}

/**
 * 这个地方现在还能不能去。
 *
 * 删掉的会话、撤下了的页面不能。没打开会话的空白页只在窗口本来就停在空白页时能去：回到那里得先关掉开着的会话，
 * 后退不应该改动任何东西。
 */
function usable(entry: NavEntry, snapshot: NavSnapshot): boolean {
	if (entry.screen.startsWith("page:")) return snapshot.hasPage(entry.screen as `page:${string}`);
	if (entry.screen !== "chat") return true;
	if (entry.sessionId === null) return snapshot.currentId === null;
	return snapshot.exists(entry.sessionId);
}

/**
 * 往 `direction` 方向最近的、现在还能去的地方，没有就是 null。
 *
 * 跳过去不了的，也跳过和当前位置一样的：跳过之后留下的一串同一个地方，会让按一下什么都不发生。
 */
export function step(history: NavHistory, direction: -1 | 1, snapshot: NavSnapshot): { history: NavHistory; entry: NavEntry } | null {
	const current = history.entries[history.index];
	for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
		const entry = history.entries[index]!;
		if (!usable(entry, snapshot) || (current && sameEntry(current, entry))) continue;
		return { history: { ...history, index }, entry };
	}
	return null;
}
