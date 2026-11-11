/**
 * 页面的 alert、confirm、离开页面提示，在 agent 操作网页时由宿主替它答，答了什么写进工具结果。
 *
 * 不接管时页面弹一个系统对话框等人去点，页面的主线程就停在那一句上：agent 接下来每一次读页面、点按钮都等满时限报
 * 「页面没有响应」，直到有人碰巧看到那个对话框。所以工具调用进行时，这个会话的每一页都叫宿主替它答
 * （`answerDialogs`，连同调用开始前就开着、没人答的那一个）；调用结束交回系统对话框，人自己浏览时照旧。
 */

import type { WebPageEvent, WebPages } from "@plume/contract";
import type { Workspace } from "./workspace.ts";

// i18n-exempt：这一页的话都写进给模型的工具结果。

interface Call {
	accept: boolean;
	met: Extract<WebPageEvent, { type: "dialog" }>[];
}

export interface Dialogs {
	/** 一次 agent 调用：期间这个会话的页面弹出的对话框都由它答。 */
	answering<T>(sessionId: string, accept: boolean, run: () => Promise<T>): Promise<{ value: T; met: Call["met"] }>;
}

export function createDialogs(web: WebPages, workspace: Workspace): Dialogs {
	/** 进行中的调用，按会话。工具都是 mutating 的，同一会话里一次只有一个。 */
	const calls = new Map<string, Call>();
	const answer = (id: string, accept: boolean | null) => web.answerDialogs(id, accept).catch(() => {});

	workspace.onDialog((sessionId, event) => {
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

export function describeDialogs(met: Call["met"]): string {
	return met
		.map((dialog) => {
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
