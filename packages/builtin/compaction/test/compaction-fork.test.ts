/**
 * 钩子 context.compact 的最里层：什么时候从主请求分叉、什么时候退回独立请求，以及交给宿主的结论（边界、头、剪枝视图）。
 * 前缀逐字节的核对在宿主那边（`packages/core/agent/test/compaction.test.ts`）。
 */

import { expect, it } from "vitest";
import type { CompactSummary, Message } from "@plume/contract";
import { compact } from "../src/compaction.ts";
import { FORK_HOT_MS, forkable } from "../src/fork.ts";
import { compactInput, recorder, reply, say, textOf, toolResult, user, words } from "./helpers.ts";

/** 一段像样的历史：开头的请求，几轮读文件；最后那条回复量得接近 200k 窗口的触发线。 */
function history(): Message[] {
	const out: Message[] = [user(`登录页点了没反应，查一下原因并修好。${"背景说明".repeat(50)}`)];
	for (let i = 0; i < 4; i++) {
		out.push(
			reply([{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `src/login-${i}.ts` } }]),
			toolResult(`c${i}`, `export const step${i} = ${"1".repeat(4000)};`, "read"),
		);
	}
	out.push(say("先看第五个文件。", 185_000), user("继续"));
	return out;
}

const big = { id: "fake/model", name: "Fake", contextWindow: 200_000, maxOutputTokens: 32_000 };
const hot = () => ({ model: "fake/model", at: Date.now() });
const done = (result: CompactSummary) => {
	if (!result || "pruneOnly" in result) throw new Error("应该压缩了");
	return result;
};

it("缓存还热、同一个模型：从主请求分叉，接着下一次要发的那份历史问，末尾一条指令", async () => {
	const messages = history();
	const { requests, forks, models } = recorder("INDEPENDENT", "FORKED");
	const input = compactInput(messages, { model: big, lineage: hot() });
	const result = done(await compact(input, { models, words }));
	expect(requests).toHaveLength(0);
	expect(forks).toHaveLength(1);
	expect(forks[0]!.messages).toBe(input.request.messages);
	expect(forks[0]!.prompt).toMatch(/Do not call any tools/);
	expect(forks[0]!.prompt).toMatch(/Treat the conversation above/);
	expect(result.via).toBe("fork");
	expect(result.summary).toBe("FORKED");
	expect(input.events).toContainEqual({ phase: "summarizing" });
	// 头是摘要加一句确认，原样交给宿主存。
	expect(result.head).toHaveLength(2);
	expect(textOf(result.head![0]!)).toMatch(/^<session-summary>\nFORKED\n<\/session-summary>/);
	expect(textOf(result.head![0]!)).toContain("recall");
	expect(result.keep).toBeGreaterThan(0);
	expect(messages[result.keep]?.role).not.toBe("toolResult");
});

it("分叉没拿到摘要（前缀对不上、调了工具、出错）就退回独立请求", async () => {
	const { requests, forks, models } = recorder("INDEPENDENT");
	const result = done(await compact(compactInput(history(), { model: big, lineage: hot() }), { models, words }));
	expect(forks).toHaveLength(1);
	expect(requests.length).toBeGreaterThan(0);
	expect(result.via).toBe("independent");
	expect(result.summary).toBe("INDEPENDENT");
});

it("缓存凉了、换了模型、超长恢复（没有起点）都直接走独立请求", async () => {
	for (const lineage of [{ model: "fake/model", at: Date.now() - FORK_HOT_MS - 1 }, { model: "fake/other", at: Date.now() }, undefined]) {
		const { requests, forks, models } = recorder("INDEPENDENT", "FORKED");
		const result = done(await compact(compactInput(history(), { model: big, ...(lineage ? { lineage } : {}) }), { models, words }));
		expect(forks).toHaveLength(0);
		expect(requests.length).toBeGreaterThan(0);
		expect(result.via).toBe("independent");
	}
});

it("缓存留得比五分钟久的服务商，过了默认线也照样分叉", () => {
	expect(forkable({ model: "m", at: 0 }, "m", FORK_HOT_MS + 1)).toBe(false);
	expect(forkable({ model: "m", at: 0, cacheHotMs: 3_600_000 }, "m", FORK_HOT_MS + 1)).toBe(true);
	expect(forkable({ model: "m", at: 0, cacheHotMs: 3_600_000 }, "m", 3_600_001)).toBe(false);
});

it("完整历史加摘要放不进窗口时不分叉", async () => {
	const messages = history();
	// 量出来几乎满窗：分叉请求是完整历史，没地方写摘要了。
	messages[messages.length - 2] = say("先看第五个文件。", 199_000);
	const { forks, models } = recorder("INDEPENDENT", "FORKED");
	await compact(compactInput(messages, { model: big, lineage: hot() }), { models, words });
	expect(forks).toHaveLength(0);
});

it("一轮收尾后问的：不能热分叉就什么也不做，也不画那一行", async () => {
	const { requests, forks, models } = recorder("INDEPENDENT", "FORKED");
	const input = compactInput(history(), { model: big, idle: true });
	expect(await compact(input, { models, words })).toBeUndefined();
	expect(requests).toHaveLength(0);
	expect(forks).toHaveLength(0);
	expect(input.events).toEqual([]);
	// 能热分叉就压。
	const warm = compactInput(history(), { model: big, idle: true, lineage: hot() });
	expect(done(await compact(warm, { models, words })).via).toBe("fork");
});

it("/compact 的说明进分叉的指令；手动压缩不走只剪枝的近路", async () => {
	const { forks, models } = recorder("INDEPENDENT", "FORKED");
	const messages = history();
	messages[messages.length - 2] = say("先看第五个文件。", 1000);
	const result = done(
		await compact(compactInput(messages, { model: big, force: true, manual: { instructions: "保留登录相关的决定" }, lineage: hot() }), { models, words }),
	);
	expect(forks[0]!.prompt).toContain("User-requested summary focus");
	expect(forks[0]!.prompt).toContain("保留登录相关的决定");
	expect(result.via).toBe("fork");
});

it("新边界落在上一次换上的头后面", async () => {
	const head: Message[] = [
		{ role: "user", content: [{ type: "text", text: "<session-summary>\n上一份\n</session-summary>" }], timestamp: 1, synthetic: true },
		say("Understood. Continuing from that summary."),
	];
	const messages = [...head, ...history().slice(1)];
	const { models } = recorder("INDEPENDENT");
	const result = done(await compact(compactInput(messages, { model: big, previous: { head: 2 }, rewrittenAt: 0 }), { models, words }));
	expect(result.keep).toBeGreaterThan(2);
});

it("只剪了工具结果就够了：交回剪枝视图，不摘要", async () => {
	const messages: Message[] = [user("找一下")];
	for (let i = 0; i < 3; i++)
		messages.push(reply([{ type: "toolCall", id: `g${i}`, name: "grep", arguments: { pattern: `p${i}` } }]), toolResult(`g${i}`, `${i}`.repeat(12_000)));
	messages.push(say("完成", 9000));
	const { requests, models } = recorder();
	const result = await compact(compactInput(messages), { models, words });
	expect(requests).toHaveLength(0);
	expect(result && "pruneOnly" in result).toBe(true);
	if (!result || !("pruneOnly" in result)) return;
	expect(result.views.map((view) => view.toolCallId)).toEqual(["g0", "g1", "g2"]);
	for (const view of result.views) expect(view.texts[0]).toMatch(/characters omitted by Plume/);
});

it("留下的那截里剪过的结果随边界一起交回", async () => {
	const messages: Message[] = [user(`目标 ${"g".repeat(20_000)}`)];
	for (let i = 0; i < 8; i++) messages.push(say(`第 ${i} 步 ${"s".repeat(4000)}`), user(`继续 ${i}`));
	messages.push(
		reply([{ type: "toolCall", id: "late", name: "grep", arguments: { pattern: "x" } }]),
		toolResult("late", "x".repeat(12_000)),
		say("找到了", 9500),
		user("然后"),
	);
	const { models } = recorder();
	const result = done(await compact(compactInput(messages), { models, words }));
	expect(result.views?.map((view) => view.toolCallId)).toEqual(["late"]);
});
