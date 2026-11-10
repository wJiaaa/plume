/**
 * 没搜到东西的结果，在真实的一轮里有没有被清掉，清了之后前缀稳不稳？
 *
 *   node --experimental-transform-types test/tool-eval/tidy-eval.ts
 *
 * 不调真模型：模型换成进程里的假服务（`fakeAnthropic`），回复按脚本走。要测的是循环和 plume.compaction 在什么时候改写历史，
 * 不是剪枝的算术——那由 `packages/builtin/compaction` 的单测钉着。
 *
 * plume.compaction 的做法是每条结果第一次发出去时就定下样子（`freshView`）：工具标了 `uneventful`（没搜到、空目录）的，
 * 发出去就是一行「[无结果]」，之后每次请求都是同一份。所以不用像「事后再清」那样权衡缓存：清它的那一刻它还没进过任何缓存，
 * 之后也不再变。三轮，让那条空结果被压在后面的内容下面：
 *
 *   第 1 轮：grep，什么也没找到
 *   第 2 轮：又一次 grep，外加一段 `tailSize` 字的话——空结果上面压了东西
 *   第 3 轮：量——那条空结果在第 2、3 次请求里是不是都已经清掉，而且两次一模一样
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "../../packages/contract/src/index.ts";
import { type FakeReply, fakeAnthropic } from "../../packages/core/agent/src/testing.ts";
import { evalAgent } from "./agent.ts";
import type { EvalModel } from "./model.ts";

const say = (s = "") => process.stderr.write(`${s}\n`);

const EMPTY = "No matches for /nothing/.\n(searched 340 files)".repeat(10);

/** 换掉 plume.tools 的 grep：永远什么都没找到。 */
const emptyGrep: Plugin = {
	name: "eval.empty-grep",
	apply(ctx) {
		ctx.tools.register({
			name: "grep",
			description: "Search file contents.",
			parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
			async execute() {
				return { output: EMPTY, uneventful: true };
			},
		});
	},
};

function script(tailSize: number): FakeReply[] {
	return [
		{ toolCalls: [{ id: "c1", name: "grep", args: { pattern: "nothing" } }] },
		{ text: "x".repeat(tailSize), toolCalls: [{ id: "c2", name: "grep", args: { pattern: "again" } }] },
		{ text: "好了" },
	];
}

/** 一次请求里，某个调用的结果发出去的是什么。 */
function resultIn(request: Record<string, unknown>, toolUseId: string): string | undefined {
	for (const message of (request.messages ?? []) as { content: unknown }[]) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as { type: string; tool_use_id?: string; content?: unknown }[]) {
			if (block.type !== "tool_result" || block.tool_use_id !== toolUseId) continue;
			const content = block.content;
			return typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
		}
	}
	return undefined;
}

for (const [label, tail] of [
	["尾巴很小", 10],
	["尾巴很大", 40_000],
] as const) {
	const fake = await fakeAnthropic(script(tail));
	const model: EvalModel = {
		provider: { id: "fake", name: "假模型", baseUrl: fake.url, api: "anthropic-messages", apiKey: "k", enabled: true, models: [] },
		model: {
			id: "fake/m",
			providerId: "fake",
			modelId: "m",
			name: "M",
			contextWindow: 200_000,
			maxOutputTokens: 4096,
			supportsThinking: false,
			supportsImages: false,
			supportsTools: true,
		},
		settings: { providers: [] },
	};
	const agent = await evalAgent({ model, tools: ["grep"], plugins: [emptyGrep] });
	const cwd = await mkdtemp(join(tmpdir(), "plume-tidy-"));
	try {
		const turn = await agent.run(cwd, "找一下", { maxSteps: 4 });
		for (const error of turn.errors) say(`  出错：${error}`);
		// 第 2 次请求是 c1 刚产生之后，第 3 次请求时它上面已经压着一段回复和另一条结果。
		const fresh = fake.requests[1] ? resultIn(fake.requests[1], "c1") : undefined;
		const buried = fake.requests[2] ? resultIn(fake.requests[2], "c1") : undefined;
		const cleared = buried !== undefined && buried.includes("无结果") && buried.length < 100;
		const stable = fresh === buried;
		say(
			`  ${label.padEnd(10)} 压在中间的那条 ${cleared ? "已清空" : "原样保留"}，两次请求里${stable ? "一模一样" : "不一样"}  ${cleared && stable ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  (${buried?.length ?? "—"} 字符，共 ${fake.requests.length} 次请求)`,
		);
	} finally {
		await agent.close();
		await fake.close();
		await rm(cwd, { recursive: true, force: true });
	}
}
say("\n  两种尾巴都该清，而且清法一样：它第一次发出去时就是「[无结果]」，之后每次请求都是同一份，前缀从没变过，缓存不受影响。");
