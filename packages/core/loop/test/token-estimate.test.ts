import { expect, it } from "vitest";
import type { AssistantMessage, Message } from "@plume/contract";
import { contextUsage, tokenEstimate } from "../src/token-estimate.ts";

const reply = (input: number, timestamp: number): AssistantMessage =>
	({
		role: "assistant",
		content: [{ type: "text", text: "a".repeat(7) }],
		usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	}) as AssistantMessage;
const user = (text: string, timestamp: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });

it("压缩拿到的用量：量过的数加上之后的估算；改写前落定的回复不算，退回估算并带上系统提示词和工具表", () => {
	const messages = [user("u".repeat(35), 1), reply(1000, 2), user("v".repeat(35), 3)];
	expect(contextUsage(messages)).toEqual({ measured: true, tokens: 1010 });
	// 报了 0 的往前找。
	expect(contextUsage([...messages, reply(0, 4)])).toEqual({ measured: true, tokens: 1012 });
	expect(contextUsage(messages, { staleAt: 2, overhead: 100 })).toEqual({ measured: false, tokens: 100 + 10 + 2 + 10 });
	// 估算不取整，逐条估的能直接相加。
	expect(tokenEstimate.messages(messages)).toBeCloseTo(tokenEstimate.messages(messages.slice(0, 1)) + tokenEstimate.messages(messages.slice(1)));
	expect(tokenEstimate.text("x".repeat(7))).toBe(2);
});

it("按文字分别计：ASCII 约 3.5 个字符一个 token，中文一字一个；混排的各算各的，拼起来估和分开估相加是同一个数", () => {
	expect(tokenEstimate.text("上下文用量".repeat(10))).toBe(50);
	// 「修好」「的」三个字，其余 14 个 ASCII 字符。
	expect(tokenEstimate.text("修好 login.ts 的 bug")).toBeCloseTo(3 + 14 / 3.5);
	const parts = ["压缩之后圆环的数字比之前还大", '{"path":"src/app.ts","line":42}', "日志：ok"];
	expect(tokenEstimate.text(parts.join(""))).toBeCloseTo(parts.reduce((sum, part) => sum + tokenEstimate.text(part), 0));
	expect(tokenEstimate.messages([user("先查原因，别改代码", 1)])).toBe(9);
});
