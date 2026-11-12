/**
 * 代管探针的逻辑入口：用代管接口（`launch({ steward: true })`、`ctx.sessions.post`、`respond`、`answer`）把一个会话接到面板上，
 * 面板代替「外面的人」。弹着的卡和模型的回复都从 `ctx.sessions.observe` 收，只留自己代管的会话和它下面的子会话（子智能体、侧边聊天）的；
 * 子会话的卡也由面板代答。转出去哪些由插件自己定，这里全转。外面的人是谁、该不该答由插件确认：探针的「外面」就是面板，不做核对。
 */

import type { Plugin, PendingRequest } from "@plume/contract";
import { NAME, type ProbeApi, type ProbeView } from "./api.ts";

/** 每个会话最多留几段回复：面板只看最近的。 */
const KEEP = 20;

export default {
	name: NAME,
	apply(ctx) {
		/** 代管着的会话 → 它（和它下面的子会话）弹着的卡、模型在它里面的回复。 */
		const watched = new Map<string, { pending: Map<string, PendingRequest>; replies: string[] }>();
		const listeners = new Set<() => void>();
		const changed = () => {
			for (const listener of listeners) listener();
		};
		const entry = (sessionId: string) => {
			let found = watched.get(sessionId);
			if (!found) watched.set(sessionId, (found = { pending: new Map(), replies: [] }));
			return found;
		};
		/** 会话 id → 它归哪个代管会话（自己，或子会话的父会话）；查过一次就记下，子会话不会换父会话。 */
		const homes = new Map<string, string | null>();
		const homeOf = async (sessionId: string): Promise<string | null> => {
			if (watched.has(sessionId)) return sessionId;
			if (!homes.has(sessionId)) {
				const parentId = (await ctx.sessions.get(sessionId))?.parentId;
				homes.set(sessionId, parentId ?? null);
			}
			const home = homes.get(sessionId) ?? null;
			return home && watched.has(home) ? home : null;
		};

		// 子会话的卡要先查它的父会话：一个一个按到达的先后处理，同一张卡的弹出和收起不会换了次序。
		let queue = Promise.resolve();
		ctx.sessions.observe(({ sessionId, event }) => {
			if (event.type !== "approval" && event.type !== "response") return;
			queue = queue.then(async () => {
				const home = await homeOf(sessionId).catch(() => null);
				const mine = home ? watched.get(home) : undefined;
				if (!mine) return;
				if (event.type === "approval") {
					if (event.approval) mine.pending.set(sessionId, event.approval);
					else mine.pending.delete(sessionId);
					changed();
					return;
				}
				// 只列代管会话自己的回复：子会话的回复是交给父会话的，由父会话的模型转述。
				if (home !== sessionId) return;
				const text = event.reply.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("")
					.trim();
				if (!text) return;
				mine.replies = [...mine.replies, text].slice(-KEEP);
				changed();
			});
		});

		const view = async (sessionId: string): Promise<ProbeView> => {
			const stewarded = (await ctx.sessions.get(sessionId))?.steward === NAME;
			// 人停止了代管就不再收它的东西：面板上的卡和回复跟着清掉。
			if (!stewarded) watched.delete(sessionId);
			const mine = stewarded ? entry(sessionId) : undefined;
			// 自己的卡排在前面，再是子会话的：哪个先弹的人在桌面上也只看见各自那一张。
			const [asking] = [...(mine?.pending ?? [])].sort(([a], [b]) => Number(b === sessionId) - Number(a === sessionId));
			return { stewarded, ...(asking ? { pending: { sessionId: asking[0], request: asking[1] } } : {}), replies: mine?.replies ?? [] };
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
