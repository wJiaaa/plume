/**
 * 代管探针的逻辑入口：用代管接口（`launch({ steward: true })`、`ctx.sessions.post`、`respond`、`answer`）把一个会话接到面板上，
 * 面板代替「外面的人」。弹着的卡和模型的回复都从 `ctx.sessions.observe` 收，只留自己代管的会话的；转出去哪些由插件自己定，
 * 这里全转。外面的人是谁、该不该答由插件确认：探针的「外面」就是面板，不做核对。
 */

import type { Plugin, PendingRequest } from "@plume/contract";
import { NAME, type ProbeApi, type ProbeView } from "./api.ts";

/** 每个会话最多留几段回复：面板只看最近的。 */
const KEEP = 20;

export default {
	name: NAME,
	apply(ctx) {
		const watched = new Map<string, { pending?: PendingRequest; replies: string[] }>();
		const listeners = new Set<() => void>();
		const changed = () => {
			for (const listener of listeners) listener();
		};
		const entry = (sessionId: string) => {
			let found = watched.get(sessionId);
			if (!found) watched.set(sessionId, (found = { replies: [] }));
			return found;
		};

		ctx.sessions.observe(({ sessionId, event }) => {
			const mine = watched.get(sessionId);
			if (!mine) return;
			if (event.type === "approval") {
				mine.pending = event.approval;
				changed();
			} else if (event.type === "response") {
				const text = event.reply.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("")
					.trim();
				if (!text) return;
				mine.replies = [...mine.replies, text].slice(-KEEP);
				changed();
			}
		});

		const view = async (sessionId: string): Promise<ProbeView> => {
			const stewarded = (await ctx.sessions.get(sessionId))?.steward === NAME;
			// 人停止了代管就不再收它的东西：面板上的卡和回复跟着清掉。
			if (!stewarded) watched.delete(sessionId);
			const mine = stewarded ? entry(sessionId) : undefined;
			return { stewarded, ...(mine?.pending ? { pending: mine.pending } : {}), replies: mine?.replies ?? [] };
		};

		const api: ProbeApi = {
			async open(message, cwd) {
				const launched = await ctx.sessions.launch({ message, steward: true, ...(cwd ? { cwd } : {}) });
				entry(launched.session.id);
				return launched.session.id;
			},
			async post(sessionId, message) {
				return (await ctx.sessions.post(sessionId, message)).started;
			},
			respond: (sessionId, toolCallId, decision) => ctx.sessions.respond(sessionId, toolCallId, decision),
			answer: (sessionId, toolCallId, value) => ctx.sessions.answer(sessionId, toolCallId, value),
			async *watch(sessionId, call) {
				let wake: (() => void) | undefined;
				const listener = () => wake?.();
				listeners.add(listener);
				call.signal.addEventListener("abort", listener, { once: true });
				try {
					while (!call.signal.aborted) {
						const next = new Promise<void>((resolve) => (wake = resolve));
						yield await view(sessionId);
						await next;
					}
				} finally {
					listeners.delete(listener);
				}
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
