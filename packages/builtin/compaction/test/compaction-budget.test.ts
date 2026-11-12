/**
 * 压缩真正要守住的两样预算：摘要请求能有多重，剪枝要省多少才跳过摘要。
 */

import { expect, it } from "vitest";
import type { Message } from "@plume/contract";
import { compactIfNeeded } from "../src/compaction.ts";
import type { SummaryRequest } from "../src/models.ts";
import { estimate, recorder, reply, request, say, textOf, toolResult, user } from "./helpers.ts";

/** 摘要请求带的全部，按估算的单位。 */
const requestTokens = (sent: SummaryRequest) => estimate.text(sent.systemPrompt) + estimate.messages(sent.messages) + estimate.text(sent.prompt);
/** 只算截短后的历史。 */
const historyTokens = (sent: SummaryRequest) => estimate.messages(sent.messages);

it("一次摘要请求放不下的历史分段写，每段都在预算里，一步也不丢", async () => {
	const history: Message[] = [user("做这件事")];
	for (let i = 0; i < 16; i++) {
		history.push(user(...Array.from({ length: 10 }, (_, b) => `块${i}.${b} ${"u".repeat(2000)}`)));
		history.push(
			reply([
				{ type: "thinking", thinking: "t".repeat(6000) },
				{ type: "text", text: `做了第 ${i} 步 ${"r".repeat(3000)}` },
				{ type: "toolCall", id: `c${i}`, name: "write", arguments: { path: `/repo/f${i}.ts`, content: "w".repeat(4000), note: "n".repeat(4000) } },
			]),
		);
		history.push(toolResult(`c${i}`, `ok ${i}`));
	}
	const { requests, models } = recorder();
	const result = await compactIfNeeded(request(history, models));
	expect(result?.kept).toBeDefined();
	expect(requests.length).toBeGreaterThan(1);
	for (const sent of requests) expect(historyTokens(sent)).toBeLessThanOrEqual(10_000 * 0.4);
	// 第一段之后的每一段都以上一段写下的摘要开头。
	for (const sent of requests.slice(1)) expect(JSON.stringify(sent.messages[0]?.content)).toMatch(/<session-summary>/);
	const calls = requests
		.flatMap((sent) => sent.messages)
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.filter((part) => part.type === "toolCall");
	const sentIds = new Set(calls.map((call) => call.type === "toolCall" && call.id));
	const folded = history
		.slice(0, history.length - result!.kept!)
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.filter((part) => part.type === "toolCall");
	expect(folded.length).toBeGreaterThanOrEqual(15);
	for (const call of folded) expect(call.type === "toolCall" && sentIds.has(call.id)).toBe(true);
	expect(
		requests.some((sent) => sent.messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("omitted here")))),
	).toBe(false);
	for (const call of calls) expect(JSON.stringify(call.type === "toolCall" && call.arguments)).toMatch(/\/repo\/f\d+\.ts/);
});

it("超过分段上限时每段各自截短，缺口写明", async () => {
	const history: Message[] = [user(`目标：把整个仓库迁移过去 ${"g".repeat(200)}`)];
	for (let i = 0; i < 200; i++) {
		history.push(say(`第 ${i} 步 ${"s".repeat(300)}`));
		history.push(user(`继续 ${i} ${"c".repeat(300)}`));
	}
	const { requests, models } = recorder();
	const result = await compactIfNeeded(request(history, models));
	expect(result?.kept).toBeDefined();
	expect(requests).toHaveLength(4);
	for (const sent of requests) expect(historyTokens(sent)).toBeLessThanOrEqual(10_000 * 0.4);
	expect(textOf(requests[0]!.messages[0]!)).toMatch(/^目标：把整个仓库迁移过去/);
	expect(requests.flatMap((sent) => sent.messages).some((message) => /omitted/.test(textOf(message)))).toBe(true);
	const older = history.length - result!.kept!;
	expect(requests.at(-1)!.messages.some((message) => textOf(message).startsWith(textOf(history[older - 1]!).slice(0, 12)))).toBe(true);
});

it("放不下的请求不发：手动压缩说清原因", async () => {
	const history: Message[] = [user("开始")];
	for (let i = 0; i < 30; i++) history.push(say(`步骤 ${i} ${"x".repeat(1500)}`), user(`继续 ${"y".repeat(1500)}`));
	const { requests, models } = recorder();
	await expect(
		compactIfNeeded(
			request(history, models, { force: true, manual: { instructions: "重点".repeat(20_000), words: { tooBig: "TOO_BIG", cancelled: "", empty: "" } } }),
		),
	).rejects.toThrow("TOO_BIG");
	expect(requests).toHaveLength(0);
});

it("剪掉上一次整份发出去的结果、按实测折算后放得下时，不要摘要", async () => {
	const history: Message[] = [user("找一下")];
	for (let i = 0; i < 3; i++)
		history.push(reply([{ type: "toolCall", id: `g${i}`, name: "grep", arguments: { pattern: `p${i}` } }]), toolResult(`g${i}`, `${i}`.repeat(12_000)));
	history.push(say("完成", estimate.messages(history)));
	const { requests, models } = recorder();
	const result = await compactIfNeeded(request(history, models));
	expect(result).toBeTruthy();
	expect(requests).toHaveLength(0);
	expect(result!.kept).toBeUndefined();
	expect(result!.messages).toHaveLength(history.length);
	expect(estimate.messages(result!.messages)).toBeLessThan(10_000 * 0.7);
});

it("实测比估算大、剪完落不到余量以下时照样摘要", async () => {
	const history: Message[] = [user("找一下")];
	for (let i = 0; i < 3; i++)
		history.push(reply([{ type: "toolCall", id: `g${i}`, name: "grep", arguments: { pattern: `p${i}` } }]), toolResult(`g${i}`, `${i}`.repeat(12_000)));
	for (let i = 0; i < 6; i++) history.push(say(`说明 ${"z".repeat(1200)}`), user(`继续 ${"q".repeat(1200)}`));
	history.push(say("完成", estimate.messages(history) * 2));
	const { requests, models } = recorder();
	const result = await compactIfNeeded(request(history, models));
	expect(result?.kept).toBeDefined();
	expect(requests.length).toBeGreaterThanOrEqual(1);
});

it("摘要请求要的回复就是发前核对给它留的位置", async () => {
	const history: Message[] = [user("开始")];
	for (let i = 0; i < 12; i++) history.push(say(`步骤 ${i} ${"x".repeat(1200)}`), user(`继续 ${"y".repeat(1200)}`));
	history.push(say("完成", estimate.messages(history) * 2));
	const { requests, models } = recorder();
	await compactIfNeeded(request(history, models, { maxOutputTokens: 8000 }));
	expect(requests.length).toBeGreaterThanOrEqual(1);
	for (const sent of requests) expect(requestTokens(sent) * 2 + sent.maxTokens).toBeLessThanOrEqual(10_000);
});

it("独立摘要之后尾部又让出去的，在摘要里，不会两头都没有", async () => {
	const history: Message[] = [user("目标：迁移配置")];
	for (let i = 0; i < 30; i++) history.push(say(`第 ${i} 步记号M${i} ${"s".repeat(1500)}`), user(`继续 ${i} 记号U${i}`));
	for (let i = 0; i < 2; i++) {
		history.push(
			reply([{ type: "toolCall", id: `big${i}`, name: "write", arguments: { path: `/repo/big${i}.ts`, content: `记号B${i} ${"w".repeat(26_000)}` } }]),
		);
		history.push(toolResult(`big${i}`, `写好了 记号R${i}`));
	}
	const { requests, models } = recorder();
	const result = await compactIfNeeded(request(history, models, { contextWindow: 32_000, overhead: 10_000 }));
	expect(result?.kept).toBeDefined();
	const summarised = JSON.stringify(requests.map((sent) => sent.messages));
	const kept = JSON.stringify(result!.messages);
	const lost = history
		.map((message) => /记号[MUBR]\d+/.exec(JSON.stringify(message))?.[0])
		.filter((mark): mark is string => Boolean(mark) && !summarised.includes(mark!) && !kept.includes(mark!));
	expect(lost).toEqual([]);
});
