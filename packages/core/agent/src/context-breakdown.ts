/**
 * 上下文窗口用到哪儿了：按发出去的那份请求分段估，再按服务商报的总数等比缩放。
 *
 * 服务商只报一次请求的总数，不报每段各多少，所以各段只能按字数估（`token-estimate.ts`，压缩用的也是这一份）。估出来的和量出来的
 * 总是对不上；差额按比例摊到各段，不全压在对话消息上——会话刚开始时对话消息是最小的一段，全压上去它会被摊成 0。
 *
 * 估的是最近一次真正发出去的请求（经过 model.context 各层、压缩之后的那份），在发请求时记下，不为了读数再把钩子跑一遍：
 * 那些层是插件，有的会记状态。
 */

import type { ContextBreakdown, ContextSegmentKey, Message, ModelContext, PromptSection, ToolDefinition } from "@plume/contract";
import { charsToTokens, contextUsage, messageTokens, textTokens, toolTokens } from "./token-estimate.ts";

/** 项目指令和记忆这两段可以按文件列出来源。 */
type MemoryKey = "conventions" | "memory";

/** 发出去的那份请求每段估了多少 token，以及项目指令、记忆里各文件那一截估了多少。 */
export interface ContextEstimate {
	segments: Record<ContextSegmentKey, number>;
	memoryFiles: Array<{ key: MemoryKey; path: string; tokens: number }>;
}

/**
 * 系统提示词里单独列出的段，按插件标的类别认（`PromptSection.category`）：技能目录、项目里的指令文件、记忆。
 * 人写的全局指令（`instructions`）和别的能力目录（`catalog`）在这里算系统提示词。
 */
type Carved = "skills" | MemoryKey;
function carvedAs(section: PromptSection): Carved | undefined {
	const { category } = section;
	return category === "skills" || category === "conventions" || category === "memory" ? category : undefined;
}

/** `categoryOf` 查工具表里某个工具是哪一类（注册它的插件标的 `ToolDefinition.category`）：MCP 服务的工具单独一段。 */
export function estimateContext(
	context: Pick<ModelContext, "systemPrompt" | "sections" | "messages" | "tools">,
	categoryOf: (tool: string) => ToolDefinition["category"],
): ContextEstimate {
	const isMcpTool = (name: string) => categoryOf(name) === "mcp";
	const carved: Record<Carved, number> = { skills: 0, conventions: 0, memory: 0 };
	for (const section of context.sections) {
		const key = carvedAs(section);
		if (key) carved[key] += Math.ceil(textTokens(section.text));
	}
	return {
		segments: {
			messages: Math.ceil(messageTokens(context.messages)),
			tools: Math.ceil(toolTokens(context.tools.filter((tool) => !isMcpTool(tool.name)))),
			mcpTools: Math.ceil(toolTokens(context.tools.filter((tool) => isMcpTool(tool.name)))),
			// 单独列出的段从系统提示词里扣掉：它们本来就在提示词里，再整份算一遍提示词，总数会比发出去的还大。
			systemPrompt: Math.max(0, Math.ceil(textTokens(context.systemPrompt)) - carved.skills - carved.conventions - carved.memory),
			...carved,
		},
		memoryFiles: (["conventions", "memory"] as const).flatMap((key) =>
			context.sections.filter((section) => carvedAs(section) === key).flatMap((section) => filesOf(key, section)),
		),
	};
}

/** 一段标的来源。`files` 是插件交来的，形状不对的条目跳过。 */
function filesOf(key: MemoryKey, section: PromptSection): ContextEstimate["memoryFiles"] {
	if (!Array.isArray(section.files)) return [];
	return section.files
		.filter((file) => typeof file?.path === "string" && Number.isFinite(file.chars) && file.chars > 0)
		.map((file) => ({ key, path: file.path, tokens: Math.ceil(charsToTokens(file.chars)) }));
}

export function contextBreakdown(estimate: ContextEstimate, messages: readonly Message[], limit: number): ContextBreakdown {
	const guesses = estimate.segments;
	const keys = Object.keys(guesses) as ContextSegmentKey[];
	const guessed = keys.reduce((sum, key) => sum + guesses[key], 0);
	// 服务商量的数（加上最近一条回复之后的消息），和压缩判断有多满用的是同一个（`ContextCompact.usage`）。
	const usage = contextUsage(messages);
	const total = usage.measured ? usage.tokens : null;
	const scale = scaler(total !== null && guessed > 0 ? total / guessed : 1);
	const sized = Object.fromEntries(keys.map((key) => [key, scale(guesses[key])])) as Record<ContextSegmentKey, number>;
	// 各文件是所在那段的一部分，按那段缩放的比例缩放，加起来不超过那段。
	const inside = (key: MemoryKey) => scaler(guesses[key] > 0 ? sized[key] / guesses[key] : 0);
	const within = { conventions: inside("conventions"), memory: inside("memory") };
	return {
		limit,
		used: keys.reduce((sum, key) => sum + sized[key], 0),
		measured: total !== null,
		segments: keys
			.map((key) => ({ key, tokens: sized[key] }))
			.filter((segment) => segment.tokens > 0)
			.sort((a, b) => b.tokens - a.tokens),
		memoryFiles: estimate.memoryFiles.map((file) => ({ path: file.path, tokens: within[file.key](file.tokens) })),
	};
}

/** 对累加的和取整，不对每段各自取整：缩放后的各段加起来仍然正好是缩放后的总数。 */
function scaler(factor: number): (tokens: number) => number {
	let seen = 0;
	return (tokens) => {
		const before = Math.round(seen * factor);
		seen += tokens;
		return Math.round(seen * factor) - before;
	};
}
