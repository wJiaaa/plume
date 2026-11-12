/**
 * 页面的 alert、confirm、离开页面提示，在 agent 操作网页时由宿主替它答，答了什么写进工具结果。
 *
 * 不接管时页面弹一个系统对话框等人去点，页面的主线程就停在那一句上：agent 接下来每一次读页面、点按钮都等满时限报
 * 「页面没有响应」，直到有人碰巧看到那个对话框。所以工具调用进行时，这个会话的每一页都叫宿主替它答
 * （`answerDialogs`，连同调用开始前就开着、没人答的那一个）；调用结束交回系统对话框，人自己浏览时照旧。
 *
 * 调用期间页面开的新窗口也一并写进结果：开成后台标签的，agent 要知道去哪找；登录、支付这类小窗口是给人的，agent 该停下来叫人。
 */

import type { WebPages } from "@plume/contract";
import type { PageNotice, Workspace } from "./workspace.ts";

// i18n-exempt：这一页的话都写进给模型的工具结果。

interface Call {
	accept: boolean;
	met: PageNotice[];
}

export interface Dialogs {
	/** 一次 agent 调用：期间这个会话的页面弹出的对话框都由它答。 */
	answering<T>(sessionId: string, accept: boolean, run: () => Promise<T>): Promise<{ value: T; met: Call["met"] }>;
}

export function createDialogs(web: WebPages, workspace: Workspace): Dialogs {
	/** 进行中的调用，按会话。工具都是 mutating 的，同一会话里一次只有一个。 */
	const calls = new Map<string, Call>();
	const answer = (id: string, accept: boolean | null) => web.answerDialogs(id, accept).catch(() => {});

	workspace.onNotice((sessionId, event) => {
		const call = sessionId === null ? undefined : calls.get(sessionId);
		call?.met.push(event);
	});
	// 调用期间新挂上的页（agent 刚开的、`window.open` 开出的后台标签）也由这次调用答。
	workspace.onAttached((page) => {
		const call = page.sessionId === null ? undefined : calls.get(page.sessionId);
		if (call) void answer(page.id, call.accept);
	});

	return {
		async answering(sessionId, accept, run) {
			const call: Call = { accept, met: [] };
			calls.set(sessionId, call);
			const own = () => workspace.pages().filter((page) => page.sessionId === sessionId);
			await Promise.all(own().map((page) => answer(page.id, accept)));
			try {
				return { value: await run(), met: call.met };
			} finally {
				if (calls.get(sessionId) === call) calls.delete(sessionId);
				await Promise.all(own().map((page) => answer(page.id, null)));
			}
		},
	};
}

/** `question` 是工具表里问人的那件工具（`category: "question"`），开了登录、付款窗口时点名它；没有就只说「请用户」。 */
export function describeNotices(met: Call["met"], question?: string): string {
	return met
		.map((dialog) => {
			if (dialog.type === "popup")
				return dialog.window
					? `The page opened a separate window for ${new URL(dialog.url).host || dialog.url}, most likely to sign in or pay. It is for the user and cannot be operated from here: ask the user${question ? ` (${question})` : ""} to finish it there, then read this page again.`
					: `The page opened ${dialog.url} in a new background tab; find it with browser_tabs.`;
			if (dialog.dialog === "alert") return `The page raised an alert "${dialog.message}"; acknowledged.`;
			// 离开页面的提示网页写不了字，所以照它的意思说。
			if (dialog.dialog === "beforeunload")
				return dialog.accepted
					? "The page warned about unsaved changes; left it anyway."
					: 'The page warned about unsaved changes; stayed on it. To leave, repeat the same action with dialog: "accept".';
			return dialog.accepted
				? `The page raised a confirm "${dialog.message}"; accepted.`
				: `The page raised a confirm "${dialog.message}"; dismissed. To accept it, repeat the same action with dialog: "accept".`;
		})
		.join("\n");
}
