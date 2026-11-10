/**
 * 一条回复里同一个 id 的工具调用只留一个。
 *
 * 循环按 content 里的 toolCall 逐个执行。Responses 中转把整份 output 补进来第二遍时，deepseek-flash 的
 * 每个调用都带着同一个 id 出现两次，bash 跑了两遍、edit 第二遍报找不到原文。根因修在
 * `openai-responses.ts` 的 `backfill`，这里守的是所有适配器汇合的那一处兜底。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { streamAssistant, useLlmRegistry } from "../src/ai/index.ts";
import { emptyUsage, type AssistantMessage, type ModelConfig, type Provider, type ProviderConfig, type StreamEvent } from "../src/types.ts";

const MODEL = { id: "p/m", providerId: "p", modelId: "m", name: "m", contextWindow: 100_000, maxOutputTokens: 4096 } as ModelConfig;
const PROVIDER = { id: "p", name: "p", baseUrl: "http://127.0.0.1:9", api: "openai-responses", apiKey: "k", enabled: true, models: [MODEL] } as ProviderConfig;

const read = (id: string, path: string) => ({ type: "toolCall" as const, id, name: "read", arguments: { path } });

const doubled = {
	api: "openai-responses",
	stream() {
		return (async function* (): AsyncGenerator<StreamEvent, AssistantMessage> {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "thinking", thinking: "想" }, read("call_a", "a.ts"), read("call_b", "b.ts"), { type: "thinking", thinking: "想" }, read("call_a", "a.ts"), read("call_b", "b.ts")],
				api: "openai-responses",
				provider: "p",
				model: "m",
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: 1,
			};
			yield { type: "done", message };
			return message;
		})();
	},
} as unknown as Provider;

test("同一个 id 的调用在 done 事件和返回值里都只剩第一个", async () => {
	useLlmRegistry({ get: (api) => (api === "openai-responses" ? doubled : undefined) });
	try {
		const stream = streamAssistant(PROVIDER, MODEL, { systemPrompt: "", messages: [], tools: [] });
		const ids = (message: AssistantMessage) => message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
		const first = await stream.next();
		assert.equal(first.done, false);
		assert.ok(!first.done && first.value.type === "done");
		assert.deepEqual(ids(first.value.message), ["call_a", "call_b"]);
		const last = await stream.next();
		assert.ok(last.done);
		assert.deepEqual(ids(last.value), ["call_a", "call_b"]);
		assert.equal(last.value.content.length, 4, "只去掉重复的调用，推理块不动");
	} finally {
		useLlmRegistry(null);
	}
});
