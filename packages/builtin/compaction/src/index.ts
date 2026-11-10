/**
 * 长会话留在上下文窗口里（`compaction.ts`）：快满了先剪大的工具结果，还不够就把较早的那段换成一份结构化的摘要，最近的原样留着；
 * 摘要过的原文经 `recall` 工具读回来；人敲 `/compact` 时现在就压。
 *
 * - context.compact 的里层（order 1000）：外面的插件不调 `next` 就整个换成自己的压法，调了 `next` 拿到的是它的结论。
 * - model.context 的里层：每条工具结果第一次发出去时的样子（`freshView`）。每次请求、重开应用以后都按同一条规则从会话重建，
 *   发出去的前缀不变，缓存接得上。
 */

import type { Plugin } from "@plume/contract";
import { compact } from "./compaction.ts";
import { MESSAGES } from "./messages.ts";
import type { Models } from "./models.ts";
import { type ArtifactSink, freshView } from "./prune.ts";
import { recallTool } from "./recall.ts";

/** 比别的插件常用的 order 都大：先让外层的层改完，再定每条结果发出去的样子。 */
const INNER = 1000;

export default {
	name: "plume.compaction",
	// 剪掉的原文经它存起来，占位标记里的 `artifact://` 地址才取得回来。
	inject: ["resources"],
	apply(ctx) {
		const resources = ctx.use("resources");
		const artifactsFor = (sessionId: string): ArtifactSink => ({ keep: (tool, content) => resources.keepArtifact(sessionId, tool, content) });
		const modelsFor = (sessionId: string): Models => ({
			complete: (request) => ctx.model.complete({ sessionId, ...request }),
			// 分叉沿用上一次主请求的系统提示词和模型，这两项宿主不看。
			fork: (request) => ctx.model.complete({ sessionId, systemPrompt: "", fork: true, ...request }),
		});

		ctx.hook(
			"context.compact",
			async (input, next) => {
				// 里面还有层给了结论的照它。
				const inner = await next(input);
				if (inner !== undefined) return inner;
				const words = MESSAGES[ctx.locale()];
				return compact(input, {
					models: modelsFor(input.sessionId),
					artifacts: artifactsFor(input.sessionId),
					words: { tooBig: words.tooBig, cancelled: words.cancelled, empty: words.empty },
				});
			},
			{ order: INNER },
		);

		ctx.hook("model.context", async (input, next) => next({ ...input, messages: freshView(input.messages, artifactsFor(input.sessionId)) }), { order: INNER });

		ctx.tools.register(recallTool((sessionId) => ctx.sessions.messages(sessionId)));

		ctx.commands.provide({
			list() {
				const words = MESSAGES[ctx.locale()];
				return [{ name: "compact", description: words.command, argumentHint: words.argumentHint }];
			},
			// 不发消息：转录里那一行 `/compact` 和它的结果由宿主画（`CompactionRun`）。正在跑、没有模型时宿主抛错，话写在输入框上面。
			async expand(_name, rest, { sessionId }) {
				if (!sessionId) throw new Error(MESSAGES[ctx.locale()].noSession);
				await ctx.sessions.compact(sessionId, { instructions: rest });
				return { handled: true };
			},
		});
	},
} satisfies Plugin;
