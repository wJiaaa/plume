/**
 * plume.title 的逻辑入口，跑在 agent 进程：会话的第一条消息够长时，在后台让模型把它总结成一句标题，写回会话。
 *
 * 挂在 `prompt.submit` 上：那时这条消息还没写进会话、宿主还没设默认标题，所以标题还是空串的就是第一条。
 * 总结在后台跑，不拖住这一轮；没模型、超时、出错都只记一笔日志，保留宿主默认取的开头。
 * 用哪个模型在设置 › 智能体里选，开关在设置 › 常规里，都是插件的设置（`ctx.settings`）；没选模型就用这个会话自己的模型。
 * 随应用发、不能停用，所以不想要时靠这个开关关掉，而不是停用插件。
 */

import type { Plugin } from "@plume/contract";
import { normalizeSettings } from "./api.ts";
import { cleanTitleSummary, shouldSummarize, SUMMARY_SYSTEM, TITLE_MAX_TOKENS, TITLE_SUMMARY_TIMEOUT_MS, titlePrompt } from "./summary.ts";

export default {
	name: "plume.title",
	async apply(ctx) {
		const settings = await ctx.settings({ model: undefined, enabled: true }, normalizeSettings);

		/** 正在跑的总结，按会话记：会话删掉时中止它那次，停用时全部中止。 */
		const running = new Map<string, AbortController>();
		ctx.effect(() => {
			for (const controller of running.values()) controller.abort();
			running.clear();
		});
		ctx.sessions.onDeleted((sessionId) => {
			running.get(sessionId)?.abort();
			running.delete(sessionId);
		});

		async function summarize(sessionId: string, text: string, controller: AbortController): Promise<void> {
			try {
				const reply = await ctx.model.complete({
					systemPrompt: SUMMARY_SYSTEM,
					prompt: titlePrompt(text),
					sessionId,
					...(settings.get().model ? { model: settings.get().model } : {}),
					maxTokens: TITLE_MAX_TOKENS,
					// 被上限截断时抛错进日志：不然拿到空串或半句话，标题悄悄没起，没人知道为什么。
					requireComplete: true,
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TITLE_SUMMARY_TIMEOUT_MS)]),
				});
				const title = cleanTitleSummary(reply);
				if (title && !controller.signal.aborted) await ctx.sessions.setTitle(sessionId, title, { automatic: true });
			} catch (error) {
				// 会话删了、插件停了是我们自己叫停的，不算失败。
				// i18n-exempt：日志。
				if (!controller.signal.aborted) ctx.log.warn(`总结会话标题失败：${error instanceof Error ? error.message : String(error)}`);
			} finally {
				if (running.get(sessionId) === controller) running.delete(sessionId);
			}
		}

		ctx.hook("prompt.submit", async (input, next) => {
			const verdict = await next(input);
			if (!settings.get().enabled || verdict.block || !input.fresh || input.synthetic || !shouldSummarize(input.text)) return verdict;
			// 子会话（侧边聊天、子 Agent）和插件的独立会话由建它的插件起名；标题不是空的说明已经有人起过了。
			if (input.session.kind !== "top" || running.has(input.sessionId)) return verdict;
			const session = await ctx.sessions.get(input.sessionId);
			if (!session || session.title !== "") return verdict;
			const controller = new AbortController();
			running.set(input.sessionId, controller);
			void summarize(input.sessionId, input.text, controller);
			return verdict;
		});
	},
} satisfies Plugin;
