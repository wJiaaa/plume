import { expect, it } from "vitest";
import type { AssistantMessage, Message } from "@plume/contract";
import { contextBreakdown, estimateContext } from "../src/context-breakdown.ts";

function reply(input: number, output: number, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	const usage = { input, output, cacheRead: 0, cacheWrite: 0, total: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	return {
		role: "assistant",
		content: [{ type: "text", text: "好" }],
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage,
		stopReason: "stop",
		timestamp: 0,
		...extra,
	} as AssistantMessage;
}

it("按段估：项目指令和插件标成记忆的段从系统提示词里扣出来，不重复算；不认记忆的段名", () => {
	const instructions = "i".repeat(350);
	const memory = "m".repeat(70);
	const systemPrompt = ["s".repeat(700), instructions, memory].join("\n\n");
	const estimate = estimateContext({
		systemPrompt,
		sections: [
			{ id: "identity", text: "s".repeat(700) },
			{ id: "projectInstructions", text: instructions },
			{ id: "learned", text: memory, category: "memory" },
			{ id: "notes", text: "x" },
		],
		messages: [{ role: "user", content: [{ type: "text", text: "u".repeat(35) }], timestamp: 0 }],
		tools: [],
	});
	expect(estimate.segments).toEqual({
		messages: 10,
		tools: 0,
		mcpTools: 0,
		skills: 0,
		systemPrompt: Math.ceil(systemPrompt.length / 3.5) - 100 - 20,
		projectInstructions: 100,
		memory: 20,
	});
	expect(estimate.memoryFiles).toEqual([]);
});

it("MCP 的工具和技能目录各算一段：技能目录从系统提示词里扣出来", () => {
	const catalogue = "k".repeat(70);
	const systemPrompt = ["s".repeat(350), catalogue].join("\n\n");
	const tool = (name: string) => ({ name, description: "d".repeat(34 - name.length), parameters: {} });
	const estimate = estimateContext({
		systemPrompt,
		sections: [
			{ id: "identity", text: "s".repeat(350) },
			{ id: "skills", text: catalogue },
		],
		messages: [],
		tools: [tool("read"), tool("mcp__github__search"), tool("mcp_call")],
	});
	expect(estimate.segments).toMatchObject({ tools: 11, mcpTools: 21, skills: 20, systemPrompt: Math.ceil(systemPrompt.length / 3.5) - 20 });
});

it("有服务商的总数时各段按比例缩放，加起来正好是总数；大的在前，0 的不列", () => {
	const estimate = {
		segments: { messages: 100, tools: 300, mcpTools: 0, skills: 0, systemPrompt: 50, projectInstructions: 50, memory: 0 },
		memoryFiles: [],
	};
	const messages: Message[] = [reply(900, 100), reply(999, 0, { stopReason: "pending" })];
	const breakdown = contextBreakdown(estimate, messages, 200_000);
	expect(breakdown).toMatchObject({ limit: 200_000, used: 1000, measured: true });
	expect(breakdown.segments).toEqual([
		{ key: "tools", tokens: 600 },
		{ key: "messages", tokens: 200 },
		{ key: "systemPrompt", tokens: 100 },
		{ key: "projectInstructions", tokens: 100 },
	]);
});

it("还没有写完的回复时用估算，measured 为假", () => {
	const segments = { messages: 7, tools: 3, mcpTools: 0, skills: 0, systemPrompt: 0, projectInstructions: 0, memory: 0 };
	const breakdown = contextBreakdown({ segments, memoryFiles: [] }, [], 1000);
	expect(breakdown).toMatchObject({
		used: 10,
		measured: false,
		segments: [
			{ key: "messages", tokens: 7 },
			{ key: "tools", tokens: 3 },
		],
	});
});

it("项目指令和记忆按文件列出来源：先指令后记忆，形状不对的跳过，别的段标了也不列", () => {
	const instructions = "i".repeat(350);
	const memory = "m".repeat(70);
	const estimate = estimateContext({
		systemPrompt: "",
		sections: [
			{ id: "identity", text: "s", files: [{ path: "/x/identity.md", chars: 1 }] },
			{ id: "learned", text: memory, category: "memory", files: [{ path: "/data/learned.md", chars: 70 }] },
			{
				id: "projectInstructions",
				text: instructions,
				files: [
					{ path: "/repo/AGENTS.md", chars: 210 },
					{ path: "/repo/app/AGENTS.md", chars: 105 },
					{ path: "/bad", chars: Number.NaN },
				],
			},
		],
		messages: [],
		tools: [],
	});
	expect(estimate.memoryFiles).toEqual([
		{ key: "projectInstructions", path: "/repo/AGENTS.md", tokens: 60 },
		{ key: "projectInstructions", path: "/repo/app/AGENTS.md", tokens: 30 },
		{ key: "memory", path: "/data/learned.md", tokens: 20 },
	]);
});

it("各文件按所在那段缩放，包在外面的说明文字不算哪个文件", () => {
	const estimate = {
		segments: { messages: 100, tools: 0, mcpTools: 0, skills: 0, systemPrompt: 0, projectInstructions: 100, memory: 0 },
		memoryFiles: [
			{ key: "projectInstructions" as const, path: "/repo/AGENTS.md", tokens: 60 },
			{ key: "projectInstructions" as const, path: "/repo/app/AGENTS.md", tokens: 30 },
		],
	};
	const breakdown = contextBreakdown(estimate, [reply(400, 0)], 200_000);
	expect(breakdown.segments).toContainEqual({ key: "projectInstructions", tokens: 200 });
	expect(breakdown.memoryFiles).toEqual([
		{ path: "/repo/AGENTS.md", tokens: 120 },
		{ path: "/repo/app/AGENTS.md", tokens: 60 },
	]);
});
