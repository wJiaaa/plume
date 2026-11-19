import type { AssistantMessage, CompactionRun, Message, UserMessage } from "@plume/contract";
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextReading, contextUsed, readingOf, rewrittenFrom } from "../src/renderer/composer/context-usage.ts";

type Usage = AssistantMessage["usage"];

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function reply(u: Usage, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: u,
		stopReason: "stop",
		timestamp: 0,
		...extra,
	} as AssistantMessage;
}

function ask(timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text: "q" }], timestamp };
}

test("取最近一条写完的回复：输入 + 缓存读取 + 缓存写入 + 输出", () => {
	const messages: Message[] = [ask(1), reply(usage(100, 10)), ask(2), reply(usage(50, 20, 1000, 30))];
	assert.equal(contextUsed(messages), 1100);
});

test("跳过还在写的和报了 0 的回复", () => {
	const messages: Message[] = [ask(1), reply(usage(100, 10)), reply(usage(0, 0), { stopReason: "error" }), reply(usage(999, 0), { stopReason: "pending" })];
	assert.equal(contextUsed(messages), 110);
});

test("有重试时按最后那一次请求算", () => {
	const messages: Message[] = [ask(1), reply(usage(300, 30), { lastAttemptUsage: usage(100, 10) })];
	assert.equal(contextUsed(messages), 110);
});

test("没有回复时是 null", () => {
	assert.equal(contextUsed([ask(1)]), null);
	assert.equal(contextUsed([]), null);
});

test("百分比四舍五入，80% 起算紧", () => {
	const messages: Message[] = [ask(1), reply(usage(1000, 0, 158_000, 0))];
	assert.deepEqual(contextReading(messages, 200_000), { used: 159_000, limit: 200_000, percent: 80, tight: false });
	const full: Message[] = [ask(1), reply(usage(1000, 0, 159_000, 0))];
	assert.deepEqual(contextReading(full, 200_000), { used: 160_000, limit: 200_000, percent: 80, tight: true });
});

test("超过窗口也只写到 100%", () => {
	assert.deepEqual(contextReading([reply(usage(300, 0))], 200), { used: 300, limit: 200, percent: 100, tight: true });
});

test("没有窗口或没有回复时是 null", () => {
	assert.equal(contextReading([reply(usage(10, 0))], 0), null);
	assert.equal(contextReading([ask(1)], 1000), null);
});

function run(at: number, extra: Partial<CompactionRun> = {}): CompactionRun {
	return { id: `r${at}`, at, startedAt: 0, status: "done", phase: "summarizing", retries: 0, code: "done", ...extra };
}

test("压缩落在转录第几条：只认真改写了历史的（换成摘要、只剪了工具结果），取最后那次", () => {
	assert.equal(rewrittenFrom([]), 0);
	assert.equal(rewrittenFrom([run(4), run(9, { code: "prune-only", status: "skipped" })]), 9);
	assert.equal(rewrittenFrom([run(4), run(9, { status: "failed", code: "failed" }), run(12, { status: "running", code: undefined })]), 4);
});

test("压缩之前的回复报的用量不算：压完、还没发下一次请求时没有量过的读数", () => {
	const messages: Message[] = [ask(1), reply(usage(150_000, 1000)), ask(2)];
	assert.equal(contextUsed(messages, 2), null);
	assert.equal(contextReading(messages, 400_000, 2), null);
	// 压缩以后回来的回复照常算。
	assert.equal(contextUsed([...messages, reply(usage(30_000, 500))], 2), 30_500);
});

test("按估算的总数读数，和量过的同一套百分比", () => {
	assert.deepEqual(readingOf(28_800, 400_000), { used: 28_800, limit: 400_000, percent: 7, tight: false });
});
