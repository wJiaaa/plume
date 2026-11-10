/**
 * 请一个会话的转录把某次工具调用的卡片摆到中间、闪一下（插件的 `ui.revealToolCall`，画廊的「在对话中查看」）。
 *
 * 是一个请求而不是一次调用：会滚动的东西——转录的窗口、跟随底部——都在 `Transcript` 里，而请求发出时那个会话
 * 可能还没打开、还没读完。请求放在这里，转录读完以后自己取。
 */

import { useSyncExternalStore } from "react";

export interface RevealRequest {
	sessionId: string;
	toolCallId: string;
	nonce: number;
}

let request: RevealRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

const emit = () => {
	for (const listener of listeners) listener();
};

export function requestReveal(sessionId: string, toolCallId: string): void {
	request = { sessionId, toolCallId, nonce: ++nonce };
	emit();
}

/** 取走这个请求；晚到的一方不能把更新的请求一起取消掉。 */
export function settleReveal(taken: number): void {
	if (request?.nonce !== taken) return;
	request = null;
	emit();
}

export function useRevealRequest(sessionId: string): RevealRequest | null {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => (request?.sessionId === sessionId ? request : null),
		() => null,
	);
}

/** 闪一下：外层带上 `data-plume-flash`，插件的样式按它画；动画结束或两秒多以后撤掉。减少动态效果时不闪。 */
export function flash(element: HTMLElement, reduced: boolean): void {
	if (reduced) return;
	element.removeAttribute("data-plume-flash");
	// 读一次布局：同一张卡再闪一次时重新开始动画，而不是并进上一次。
	void element.offsetWidth;
	element.setAttribute("data-plume-flash", "");
	const done = () => element.removeAttribute("data-plume-flash");
	element.addEventListener("animationend", done, { once: true });
	window.setTimeout(done, 2400);
}
