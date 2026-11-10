import type { AssistantMessage, Message, UserMessage } from "@plume/contract";
import { describe, expect, it } from "vitest";
import { contextReading, contextUsed, formatTokens } from "../src/format.ts";

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

describe("formatTokens", () => {
	it("每一档留一位小数", () => {
		expect(formatTokens(812)).toBe("812");
		expect(formatTokens(12_345)).toBe("12.3k");
		expect(formatTokens(200_000)).toBe("200.0k");
		expect(formatTokens(4_100_000)).toBe("4.1M");
		expect(formatTokens(2_700_000_000)).toBe("2.7B");
	});
});

describe("contextUsed", () => {
	it("取最近一条写完的回复：输入 + 缓存读取 + 缓存写入 + 输出", () => {
		const messages: Message[] = [ask(1), reply(usage(100, 10)), ask(2), reply(usage(50, 20, 1000, 30))];
		expect(contextUsed(messages)).toBe(1100);
	});

	it("跳过还在写的和报了 0 的回复", () => {
		const messages: Message[] = [ask(1), reply(usage(100, 10)), reply(usage(0, 0), { stopReason: "error" }), reply(usage(999, 0), { stopReason: "pending" })];
		expect(contextUsed(messages)).toBe(110);
	});

	it("有重试时按最后那一次请求算", () => {
		const messages: Message[] = [ask(1), reply(usage(300, 30), { lastAttemptUsage: usage(100, 10) })];
		expect(contextUsed(messages)).toBe(110);
	});

	it("没有回复时是 null", () => {
		expect(contextUsed([ask(1)])).toBeNull();
		expect(contextUsed([])).toBeNull();
	});
});

describe("contextReading", () => {
	it("百分比四舍五入，80% 起算紧", () => {
		const messages: Message[] = [ask(1), reply(usage(1000, 0, 158_000, 0))];
		expect(contextReading(messages, 200_000)).toEqual({ used: 159_000, limit: 200_000, percent: 80, tight: false });
		const full: Message[] = [ask(1), reply(usage(1000, 0, 159_000, 0))];
		expect(contextReading(full, 200_000)).toMatchObject({ percent: 80, tight: true });
	});

	it("超过窗口也只写到 100%", () => {
		expect(contextReading([reply(usage(300, 0))], 200)).toMatchObject({ percent: 100, tight: true });
	});

	it("没有窗口或没有回复时是 null", () => {
		expect(contextReading([reply(usage(10, 0))], 0)).toBeNull();
		expect(contextReading([ask(1)], 1000)).toBeNull();
	});
});
