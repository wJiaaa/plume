/**
 * plume.title 的逻辑入口，跑在 agent 进程：会话的第一条消息够长时，在后台让模型把它总结成一句标题，写回会话。
 *
 * 挂在 `prompt.submit` 上：那时这条消息还没写进会话、宿主还没设默认标题，所以标题还是空串的就是第一条。
 * 总结在后台跑，不拖住这一轮；没模型、超时、出错都只记一笔日志，保留宿主默认取的开头。
 * 用哪个模型在设置 › 智能体里选，开关在设置 › 常规里，都存在插件数据目录的 `settings.json`；没选模型就用这个会话自己的模型。
 * 随应用发、不能停用，所以不想要时靠这个开关关掉，而不是停用插件。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import type { TitleApi } from "./api.ts";
import { cleanTitleSummary, shouldSummarize, SUMMARY_SYSTEM, TITLE_MAX_TOKENS, TITLE_SUMMARY_TIMEOUT_MS, titlePrompt } from "./summary.ts";

export default {
	name: "plume.title",
	async apply(ctx) {
		const settingsFile = join(ctx.dataDir, "settings.json");
		const saved = await readFile(settingsFile, "utf8").then(
			(text) => JSON.parse(text) as { model?: unknown; enabled?: unknown },
			() => ({}) as { model?: unknown; enabled?: unknown },
		);
		let model = typeof saved.model === "string" ? saved.model : undefined;
		// 缺省开着，只记关掉的那一种。
		let enabled = saved.enabled !== false;
		let writing: Promise<void> = Promise.resolve();
		/** 两项写在同一个文件里：排着队写，轮到时才和当时的另一项合并，连着改两项不会互相盖掉。 */
		function save(patch: { model?: string | undefined; enabled?: boolean }): Promise<void> {
			writing = writing
				.catch(() => undefined)
				.then(async () => {
					const nextModel = "model" in patch ? patch.model : model;
					const nextEnabled = patch.enabled ?? enabled;
					const content = { ...(nextModel ? { model: nextModel } : {}), ...(nextEnabled ? {} : { enabled: false }) };
					await writeFile(`${settingsFile}.tmp`, JSON.stringify(content, null, 2));
					await rename(`${settingsFile}.tmp`, settingsFile);
					model = nextModel;
					enabled = nextEnabled;
				});
			return writing;
		}
		ctx.serve({
			model: async () => model,
			setModel: (next: string | undefined) => save({ model: typeof next === "string" && next ? next : undefined }),
			enabled: async () => enabled,
			setEnabled: (next: boolean) => save({ enabled: next === true }),
		} satisfies TitleApi);

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
					...(model ? { model } : {}),
					maxTokens: TITLE_MAX_TOKENS,
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
			if (!enabled || verdict.block || !input.fresh || input.synthetic || !shouldSummarize(input.text)) return verdict;
			const session = (await ctx.sessions.list()).find((summary) => summary.id === input.sessionId);
			// 子会话（侧边聊天、子 Agent）由建它的插件起名；标题不是空的说明已经有人起过了。
			if (!session || session.parentId || session.title !== "" || running.has(input.sessionId)) return verdict;
			const controller = new AbortController();
			running.set(input.sessionId, controller);
			void summarize(input.sessionId, input.text, controller);
			return verdict;
		});
	},
} satisfies Plugin;
