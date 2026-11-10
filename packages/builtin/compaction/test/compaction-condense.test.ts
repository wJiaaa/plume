import { expect, it } from "vitest";
import type { Message } from "@plume/contract";
import { compactIfNeeded } from "../src/compaction.ts";
import { estimateTokens } from "../src/tokens.ts";
import { recorder, reply, request, say, user } from "./helpers.ts";

it("截短的工具调用参数两份同源：只读参数对象的协议也看得到剪短的路径和命令", async () => {
	const command = `npm test -- ${"--flag ".repeat(2000)}`;
	const messages: Message[] = [
		user("fix it"),
		reply([
			{
				type: "toolCall",
				id: "t1",
				name: "bash",
				arguments: { path: "/repo/src/app.ts", command },
				argumentsText: JSON.stringify({ path: "/repo/src/app.ts", command }),
			},
		]),
		{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 },
		...Array.from({ length: 30 }, (_, i) => (i % 2 ? user(`next ${"y".repeat(2000)}`) : say(`step ${"x".repeat(2000)}`))),
	];
	// 一次请求放不下时分段写；那次调用自己就超过一段的预算，在它所在的那段里被截短。
	const { requests, models } = recorder();
	const result = await compactIfNeeded(request(messages, models));
	expect(result?.kept).toBeDefined();
	const call = requests
		.flatMap((sent) => sent.messages)
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.find((part) => part.type === "toolCall");
	expect(call?.type).toBe("toolCall");
	if (call?.type !== "toolCall") return;
	expect(call.argumentsText!.length).toBeLessThan(command.length);
	expect(JSON.parse(call.argumentsText!)).toEqual(call.arguments);
	expect(call.arguments?.path).toBe("/repo/src/app.ts");
	expect(String(call.arguments?.command)).toMatch(/^npm test -- --flag/);
});

it("摘要请求的预算按实测比例校正", async () => {
	const history: Message[] = [];
	for (let i = 0; i < 60; i++) {
		history.push(user(`需求${i}${"中文说明".repeat(750)}`));
		history.push(say(`回复${i}${"处理结果".repeat(750)}`));
	}
	// 服务商量出来的比字符除以 3.5 多得多，中文上就是这样。
	history[history.length - 1] = say("最后", 190_000);
	const scale = 190_000 / estimateTokens(history);
	expect(scale).toBeGreaterThan(1.5);
	const { requests, models } = recorder();
	const result = await compactIfNeeded(request(history, models, { contextWindow: 200_000 }));
	expect(result?.kept).toBeDefined();
	for (const sent of requests) expect(estimateTokens(sent.messages) * scale).toBeLessThanOrEqual(200_000 * 0.42);
});
