/**
 * 眼下有哪些提示：哪里都能报一声（插件经 `ui.notify`），提示条订阅这里。
 *
 * 放在模块里而不是 app.tsx 的状态里：报的人有的在组件里、有的在组件外（插件的回调），提示条只有一处画。
 */

import type { Notice, ToastLevel } from "./stack.ts";

/** 卡片上带的去处：跳到那个会话、在文件夹里指出刚写的文件。 */
export type NoticeTarget = Pick<Notice, "sessionId" | "reveal">;

let notices: readonly Notice[] = [];
const listeners = new Set<() => void>();
let counter = 0;

function emit(): void {
	for (const listener of listeners) listener();
}

/** 报一声。同样的话连着报会并成一张卡片，见 `groupNotices`。 */
export function notify(message: string, level: ToastLevel = "info", target: NoticeTarget = {}): void {
	if (!message.trim()) return;
	counter += 1;
	notices = [...notices, { ...target, id: String(counter), level, message }];
	emit();
}

export function dismissNotice(id: string): void {
	const next = notices.filter((notice) => notice.id !== id);
	if (next.length === notices.length) return;
	notices = next;
	emit();
}

export function subscribeNotices(listener: () => void): () => void {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

export function currentNotices(): readonly Notice[] {
	return notices;
}
