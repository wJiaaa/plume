/**
 * 冒烟：连得上模型吗？它会调工具吗？
 *
 *   node --experimental-transform-types test/tool-eval/smoke.ts [<供应商 id>/<模型 id>]
 *
 * 这个目录里别的评测都靠它先通，所以单独一个文件、先跑。用的是应用自己的设置和 key 存放处（见 `model.ts`），
 * 不自己读 key：认证方式和产品不一样的评测，可能产品坏了它照样通过。
 */

import { streamAssistant } from "../../packages/core/llm/src/ai/index.ts";
import type { AssistantMessage, ToolSpec } from "../../packages/core/llm/src/types.ts";
import { loadModel } from "./model.ts";

const ECHO_TOOL: ToolSpec = {
	name: "echo",
	description: "Return the text you are given. Call this exactly once with the word the user asks for.",
	parameters: {
		type: "object",
		properties: { text: { type: "string", description: "The text to echo." } },
		required: ["text"],
		additionalProperties: false,
	},
};

async function main(): Promise<void> {
	const { provider, model } = await loadModel(process.argv[2]);
	console.log(`provider=${provider.id} api=${provider.api} baseUrl=${provider.baseUrl}`);
	console.log(`model=${model.modelId} key=${provider.apiKey ? "present" : "MISSING"}`);

	const started = Date.now();
	const stream = streamAssistant(
		provider,
		model,
		{
			systemPrompt: "You are a test fixture. Follow instructions exactly.",
			messages: [{ role: "user", content: [{ type: "text", text: "Call the echo tool with the word: pineapple" }], timestamp: Date.now() }],
			tools: [ECHO_TOOL],
		},
		{ maxTokens: 512, retryAttempts: 2 },
	);

	let deltas = 0;
	let final: AssistantMessage | undefined;
	while (true) {
		const next = await stream.next();
		if (next.done) {
			final = next.value;
			break;
		}
		if (next.value.type === "toolcall_delta" || next.value.type === "text_delta") deltas += 1;
	}

	const elapsed = Date.now() - started;
	const calls = final?.content.filter((c) => c.type === "toolCall") ?? [];
	console.log(`\nelapsed=${elapsed}ms deltas=${deltas} stopReason=${final?.stopReason}${final?.errorMessage ? ` error=${final.errorMessage}` : ""}`);
	console.log(`toolCalls=${calls.length}`);
	for (const call of calls) {
		if (call.type !== "toolCall") continue;
		console.log(`  ${call.name}(${JSON.stringify(call.arguments)})`);
	}

	const ok = calls.length === 1 && JSON.stringify(calls[0]).includes("pineapple");
	console.log(ok ? "\n✓ 冒烟通过" : "\n✗ 冒烟失败");
	if (!ok) process.exitCode = 1;
}

await main();
