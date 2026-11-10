/**
 * 上下文窗口用到哪儿了：按发出去的那份请求分段估，再按服务商报的总数等比缩放。
 *
 * 服务商只报一次请求的总数，不报每段各多少，所以各段只能按字数估（约 3.5 个字符一个 token）。估出来的和量出来的
 * 总是对不上；差额按比例摊到各段，不全压在对话消息上——会话刚开始时对话消息是最小的一段，全压上去它会被摊成 0。
 *
 * 估的是最近一次真正发出去的请求（经过 model.context 各层、压缩之后的那份），在发请求时记下，不为了读数再把钩子跑一遍：
 * 那些层是插件，有的会记状态。
 */

import type { ContextBreakdown, ContextSegmentKey, Message, ModelContext, PromptSection } from "@plume/contract";

/** 项目指令和项目记忆这两段可以按文件列出来源。 */
type MemoryKey = "projectInstructions" | "projectMemory";

/** 发出去的那份请求每段估了多少 token，以及项目指令、项目记忆里各文件那一截估了多少。 */
export interface ContextEstimate {
	segments: Record<ContextSegmentKey, number>;
	memoryFiles: Array<{ key: MemoryKey; path: string; tokens: number }>;
}

/** 代码和文字平均下来大约 3.5 个字符一个 token。 */
function tokensOf(chars: number): number {
	return Math.ceil(chars / 3.5);
}

/** 一条消息大约多少字符；图片不管多大按 6000 算（约 1500 token）。 */
function messageChars(message: Message): number {
	let chars = 0;
	if (message.role === "assistant") {
		for (const part of message.content) {
			if (part.type === "text") chars += part.text.length;
			else if (part.type === "thinking") chars += part.thinking.length;
			else chars += JSON.stringify(part.arguments).length + part.name.length;
		}
	} else {
		for (const part of message.content) chars += part.type === "text" ? part.text.length : 6000;
	}
	return chars;
}

/** MCP 服务的工具：plume.mcp 登记的 `mcp__服务__工具`，和工具多了时代替它们的那两个。 */
function isMcpTool(name: string): boolean {
	return name.startsWith("mcp__") || name === "mcp_search" || name === "mcp_call";
}

/** 系统提示词里单独列出的段，段名是 plume.skills、plume.prompt 和 plume.memory 给的。 */
const CARVED = ["skills", "projectInstructions", "projectMemory"] as const;
const MEMORY: readonly MemoryKey[] = ["projectInstructions", "projectMemory"];

export function estimateContext(context: Pick<ModelContext, "systemPrompt" | "sections" | "messages" | "tools">): ContextEstimate {
	const carved = { skills: 0, projectInstructions: 0, projectMemory: 0 };
	for (const section of context.sections) {
		const id = CARVED.find((key) => key === section.id);
		if (id) carved[id] += tokensOf(section.text.length);
	}
	const schema = (tools: typeof context.tools) => tools.map((tool) => `${tool.name}${tool.description}${JSON.stringify(tool.parameters)}`).join("").length;
	return {
		segments: {
			messages: tokensOf(context.messages.reduce((sum, message) => sum + messageChars(message), 0)),
			tools: tokensOf(schema(context.tools.filter((tool) => !isMcpTool(tool.name)))),
			mcpTools: tokensOf(schema(context.tools.filter((tool) => isMcpTool(tool.name)))),
			// 单独列出的段从系统提示词里扣掉：它们本来就在提示词里，再整份算一遍提示词，总数会比发出去的还大。
			systemPrompt: Math.max(0, tokensOf(context.systemPrompt.length) - carved.skills - carved.projectInstructions - carved.projectMemory),
			...carved,
		},
		memoryFiles: MEMORY.flatMap((key) => context.sections.filter((section) => section.id === key).flatMap((section) => filesOf(key, section))),
	};
}

/** 一段标的来源。`files` 是插件交来的，形状不对的条目跳过。 */
function filesOf(key: MemoryKey, section: PromptSection): ContextEstimate["memoryFiles"] {
	if (!Array.isArray(section.files)) return [];
	return section.files
		.filter((file) => typeof file?.path === "string" && Number.isFinite(file.chars) && file.chars > 0)
		.map((file) => ({ key, path: file.path, tokens: tokensOf(file.chars) }));
}

/**
 * 最近一条写完的回复报的总数：输入 + 缓存读取 + 缓存写入 + 输出。和用量插件圆环上的数是同一个口径：
 * 取 `lastAttemptUsage`（重试丢掉的那几次不共用这个窗口），报了 0 的往前找。一条都没有时是 null。
 */
function measuredTotal(messages: readonly Message[]): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || message.stopReason === "pending") continue;
		const usage = message.lastAttemptUsage ?? message.usage;
		const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
		if (total > 0) return total;
	}
	return null;
}

export function contextBreakdown(estimate: ContextEstimate, messages: readonly Message[], limit: number): ContextBreakdown {
	const guesses = estimate.segments;
	const keys = Object.keys(guesses) as ContextSegmentKey[];
	const guessed = keys.reduce((sum, key) => sum + guesses[key], 0);
	const total = measuredTotal(messages);
	const scale = scaler(total !== null && guessed > 0 ? total / guessed : 1);
	const sized = Object.fromEntries(keys.map((key) => [key, scale(guesses[key])])) as Record<ContextSegmentKey, number>;
	// 各文件是所在那段的一部分，按那段缩放的比例缩放，加起来不超过那段。
	const inside = (key: MemoryKey) => scaler(guesses[key] > 0 ? sized[key] / guesses[key] : 0);
	const within = { projectInstructions: inside("projectInstructions"), projectMemory: inside("projectMemory") };
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
