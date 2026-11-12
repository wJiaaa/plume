import { expect, it } from "vitest";
import type { AssistantMessage, Message } from "@plume/contract";
import { contextBreakdown, estimateContext } from "../src/context-breakdown.ts";

/** 工具表里都是没标类别的普通工具。 */
const plainTools = () => undefined;

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

it("按段估：项目指令文件和记忆的段按插件标的类别从系统提示词里扣出来，不重复算；全局指令算系统提示词；不认段名", () => {
	const instructions = "i".repeat(350);
	const memory = "m".repeat(70);
	const systemPrompt = ["s".repeat(700), instructions, memory, "g".repeat(35), "p".repeat(35)].join("\n\n");
	const estimate = estimateContext(
		{
			systemPrompt,
			sections: [
				{ id: "identity", text: "s".repeat(700) },
				{ id: "agents-md", text: instructions, category: "conventions" },
				{ id: "learned", text: memory, category: "memory" },
				{ id: "notes", text: "x" },
				{ id: "settings", text: "g".repeat(35), category: "instructions" },
				// 段名和 plume.prompt 的项目指令同名、没标类别：算系统提示词。
				{ id: "projectInstructions", text: "p".repeat(35) },
			],
			messages: [{ role: "user", content: [{ type: "text", text: "u".repeat(35) }], timestamp: 0 }],
			tools: [],
		},
		plainTools,
	);
	expect(estimate.segments).toEqual({
		messages: 10,
		tools: 0,
		mcpTools: 0,
		skills: 0,
		systemPrompt: Math.ceil(systemPrompt.length / 3.5) - 100 - 20,
		conventions: 100,
		memory: 20,
	});
	expect(estimate.memoryFiles).toEqual([]);
});

it("MCP 的工具和技能目录各算一段，按插件标的类别认、不认名字：技能目录从系统提示词里扣出来，别的能力目录算系统提示词", () => {
	const catalogue = "k".repeat(70);
	const agents = "a".repeat(35);
	const systemPrompt = ["s".repeat(350), catalogue, agents].join("\n\n");
	const tool = (name: string) => ({ name, description: "d".repeat(34 - name.length), parameters: {} });
	const connector = new Set(["github_search", "connector_call"]);
	const estimate = estimateContext(
		{
			systemPrompt,
			sections: [
				{ id: "identity", text: "s".repeat(350) },
				{ id: "catalogue", text: catalogue, category: "skills" },
				{ id: "agents", text: agents, category: "catalog" },
			],
			messages: [],
			// 叫 mcp__ 的工具没标类别，也算普通工具。
			tools: [tool("read"), tool("github_search"), tool("connector_call"), tool("mcp__x")],
		},
		(name) => (connector.has(name) ? "mcp" : undefined),
	);
	expect(estimate.segments).toMatchObject({ tools: 21, mcpTools: 21, skills: 20, systemPrompt: Math.ceil(systemPrompt.length / 3.5) - 20 });
});

it("有服务商的总数时各段按比例缩放，加起来正好是总数；大的在前，0 的不列", () => {
	const estimate = {
		segments: { messages: 100, tools: 300, mcpTools: 0, skills: 0, systemPrompt: 50, conventions: 50, memory: 0 },
		memoryFiles: [],
	};
	const messages: Message[] = [reply(900, 100), reply(999, 0, { stopReason: "pending" })];
	const breakdown = contextBreakdown(estimate, messages, 200_000);
	expect(breakdown).toMatchObject({ limit: 200_000, used: 1000, measured: true });
	expect(breakdown.segments).toEqual([
		{ key: "tools", tokens: 600 },
		{ key: "messages", tokens: 200 },
		{ key: "systemPrompt", tokens: 100 },
		{ key: "conventions", tokens: 100 },
	]);
});

it("还没有写完的回复时用估算，measured 为假", () => {
	const segments = { messages: 7, tools: 3, mcpTools: 0, skills: 0, systemPrompt: 0, conventions: 0, memory: 0 };
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
	const estimate = estimateContext(
		{
			systemPrompt: "",
			sections: [
				{ id: "identity", text: "s", files: [{ path: "/x/identity.md", chars: 1 }] },
				{ id: "learned", text: memory, category: "memory", files: [{ path: "/data/learned.md", chars: 70 }] },
				{
					id: "agents-md",
					text: instructions,
					category: "conventions",
					files: [
						{ path: "/repo/AGENTS.md", chars: 210 },
						{ path: "/repo/app/AGENTS.md", chars: 105 },
						{ path: "/bad", chars: Number.NaN },
					],
				},
			],
			messages: [],
			tools: [],
		},
		plainTools,
	);
	expect(estimate.memoryFiles).toEqual([
		{ key: "conventions", path: "/repo/AGENTS.md", tokens: 60 },
		{ key: "conventions", path: "/repo/app/AGENTS.md", tokens: 30 },
		{ key: "memory", path: "/data/learned.md", tokens: 20 },
	]);
});

it("各文件按所在那段缩放，包在外面的说明文字不算哪个文件", () => {
	const estimate = {
		segments: { messages: 100, tools: 0, mcpTools: 0, skills: 0, systemPrompt: 0, conventions: 100, memory: 0 },
		memoryFiles: [
			{ key: "conventions" as const, path: "/repo/AGENTS.md", tokens: 60 },
			{ key: "conventions" as const, path: "/repo/app/AGENTS.md", tokens: 30 },
		],
	};
	const breakdown = contextBreakdown(estimate, [reply(400, 0)], 200_000);
	expect(breakdown.segments).toContainEqual({ key: "conventions", tokens: 200 });
	expect(breakdown.memoryFiles).toEqual([
		{ path: "/repo/AGENTS.md", tokens: 120 },
		{ path: "/repo/app/AGENTS.md", tokens: 60 },
	]);
});
