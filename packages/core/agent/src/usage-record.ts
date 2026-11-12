/**
 * 花销表里每次主请求多记的那几样：使用统计的「Token 构成」「耗时构成」和缓存未命中诊断，见 `session-db.ts` 的 `insertSpend`。
 *
 * 在发请求、记账的那一刻算好存下，不事后从会话记录回放：发出去的那份请求（经过 model.context 各层、压缩之后）只有那一刻见过，
 * 系统提示词各段由插件拼，回放拿不到；记下来以后读使用统计就是一条 SQL。
 *
 * 构成按字数估比例，再把这次实际计费的输入（含缓存读写）按比例分下去，输出按思考和正文分，所以各部分加起来就是账单上的数。
 */

import type { AssistantMessage, Message, ModelContext, UsageCacheMissCause, UsageTokenPart } from "@plume/contract";
import { requestUsage, type RequestPrefix } from "@plume/llm/types";

/** 送进去的按来源分的几类。系统提示词按段的类别（指令按段名）拆成前三类。 */
const INPUT_PARTS = [
	"system",
	"instructions",
	"skills",
	"toolDefs",
	"user",
	"injected",
	"assistant",
	"toolResults",
] as const satisfies readonly UsageTokenPart[];
type InputPart = (typeof INPUT_PARTS)[number];
export type InputParts = Record<InputPart, number>;
export const TOKEN_PARTS = [...INPUT_PARTS, "outputThinking", "outputReply"] as const satisfies readonly UsageTokenPart[];

/** 指令和记忆：人写的、记下的，每轮原样进提示词。指令的段名是内置插件 plume.prompt 给的；记忆按插件标的类别认（`PromptSection.category`）。 */
const INSTRUCTION_SECTIONS = new Set(["userInstructions", "projectInstructions"]);

/** 图片按一个固定数算：各家算法不同，它在比例里只是一个量级。 */
const IMAGE_TOKENS = 1600;

/** 粗估：ASCII 四个字符一个 token，其余（中文等）一个字符一个。只拿来算比例。 */
function estimateTokens(text: string): number {
	let wide = 0;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) wide++;
	return (text.length - wide) / 4 + wide;
}

function messagePart(message: Message): { part: "user" | "injected" | "assistant" | "toolResults"; tokens: number } {
	if (message.role === "assistant") {
		// 之前的思考块大多不回传给模型，不算。
		let tokens = 0;
		for (const block of message.content) {
			if (block.type === "text") tokens += estimateTokens(block.text);
			else if (block.type === "toolCall") tokens += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.arguments ?? {}));
		}
		return { part: "assistant", tokens };
	}
	let tokens = 0;
	for (const block of message.content) tokens += block.type === "text" ? estimateTokens(block.text) : IMAGE_TOKENS;
	if (message.role === "toolResult") return { part: "toolResults", tokens };
	return { part: message.synthetic ? "injected" : "user", tokens };
}

/** 这次请求送进去的各部分大约多少 token（估的，只用来分账单上的实数）。 */
export function estimateParts(context: Pick<ModelContext, "systemPrompt" | "sections" | "messages" | "tools">): InputParts {
	const parts: InputParts = { system: 0, instructions: 0, skills: 0, toolDefs: 0, user: 0, injected: 0, assistant: 0, toolResults: 0 };
	let sectioned = 0;
	for (const section of context.sections) {
		const tokens = estimateTokens(section.text);
		sectioned += tokens;
		if (INSTRUCTION_SECTIONS.has(section.id) || section.category === "memory") parts.instructions += tokens;
		// 能力目录：技能，和可以派的智能体、没放进工具表的工具这类按需取用的目录，按插件标的类别认。
		else if (section.category === "skills" || section.category === "catalog") parts.skills += tokens;
		else parts.system += tokens;
	}
	// 段与段之间的空行，以及没拆成段的提示词，算系统提示词。
	parts.system += Math.max(0, estimateTokens(context.systemPrompt) - sectioned);
	if (context.tools.length > 0) parts.toolDefs = estimateTokens(JSON.stringify(context.tools));
	for (const message of context.messages) {
		const { part, tokens } = messagePart(message);
		parts[part] += tokens;
	}
	return parts;
}

/** 上一次回复之后、这次请求之前进会话的：人说了几句（轮次），跑了几次工具、几次出错、共多少毫秒。 */
interface TailActivity {
	turns: number;
	tools: number;
	toolErrors: number;
	toolMs: number;
}

/** 一次主请求记账时带上的：发请求那一刻估的各部分，上一次回复之后的动静，以及上一次主请求之后越过的历史改写。 */
export interface SpendNote extends TailActivity {
	parts: InputParts;
	/** 上一次主请求之后历史被有意改写过：压缩（摘要或剪枝）、撤回。两种都有时记压缩，它改得更彻底。 */
	boundary?: "compaction" | "rewind";
}

/** 同一个会话上一次主请求：这一次理应从缓存读到它那么长的前缀。 */
export interface PreviousRequest {
	prompt: number;
	provider: string;
	model: string;
}

/**
 * 未命中量不超过这个数就当作命中。缓存按块计（OpenAI 128 token 一步、从 1024 起，DeepSeek 64 一单位，Anthropic 不到 1024
 * 的前缀不缓存），前缀完全稳定的请求也会差出几十个 token：这是粒度噪声，不是打断。
 */
export const CACHE_NOISE_FLOOR_TOKENS = 1024;

/** 一次主请求的缓存诊断。`cause` 只在 `missed > 0` 时有。 */
interface CacheDiagnosis {
	/** 这一次的输入总量：input + cacheRead + cacheWrite（不含丢掉的重试）。 */
	prompt: number;
	missed: number;
	/** 这些 token 按实付单价而不是缓存读单价多花的美元；没记费率时为 null。 */
	extraCost: number | null;
	cause?: UsageCacheMissCause;
}

function prefixCause(prefix: RequestPrefix | undefined): UsageCacheMissCause {
	if (!prefix) return "unknown";
	const segment = prefix.change?.segment;
	if (segment === undefined) return "provider";
	if (segment === "tools") return "tools";
	if (segment === "system") return "prompt";
	// thinking 档位这类参数：有的让缓存失效、有的不会，证据不够，不归到服务商头上。
	if (segment === "params") return "unknown";
	return "rewrite";
}

/**
 * 对一个会话的主请求逐次比：上一次的输入总量就是这一次理应从缓存读到的前缀，实际 cacheRead 与它的差是未命中。
 *
 * - 期望前缀取 `min(上一次, 这一次)`：这一次比上一次短，最多也只能读到这一次的全部。
 * - 这个服务商/模型在这个会话里从没报过缓存（读写都是 0）时判不了，不计；报过之后再出现全零，才算整段未命中。
 * - 压缩、撤回之后的第一次请求是有意改写前缀，记 `compaction` / `rewind`；换了模型记 `model`。
 * - 其余按请求前缀指纹（`AssistantMessage.prefix`）第一处变化落在哪：工具、系统提示词还是消息；指纹量过而前缀没变，
 *   是服务商那边没读到；没有指纹（重启后的第一次请求）分不清，记 `unknown`。
 * - 不按缓存有效期归类：各家留多久不同，中转更说不准，按猜的时长记成「过期」会把真正的打断藏起来。
 */
export function diagnoseCache(
	reply: AssistantMessage,
	previous: PreviousRequest | undefined,
	reported: boolean,
	boundary: SpendNote["boundary"],
): CacheDiagnosis {
	const usage = requestUsage(reply);
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	if (!previous) return { prompt, missed: 0, extraCost: 0 };
	const missed = Math.max(0, Math.min(previous.prompt, prompt) - usage.cacheRead);
	if (missed <= CACHE_NOISE_FLOOR_TOKENS) return { prompt, missed: 0, extraCost: 0 };
	let cause: UsageCacheMissCause;
	if (boundary) cause = boundary;
	else if (previous.provider !== reply.provider || previous.model !== reply.model) cause = "model";
	else if (usage.cacheRead + usage.cacheWrite === 0 && !reported) return { prompt, missed: 0, extraCost: 0 };
	else cause = prefixCause(reply.prefix);
	return { prompt, missed, extraCost: extraCostOf(reply, missed), cause };
}

/**
 * 未命中的 token 落在 input 或 cacheWrite 里，按这两桶加权的实付单价，减去同样数量按缓存读单价的花费。只用请求当时记下的费率
 * （每百万 token 的美元），之后改价不改写历史；没记费率（模型没配价格）就只报 token。
 */
function extraCostOf(reply: AssistantMessage, missed: number): number | null {
	const usage = requestUsage(reply);
	const rates = usage.cost.rates;
	if (!rates) return null;
	const paidTokens = usage.input + usage.cacheWrite;
	if (paidTokens <= 0) return 0;
	const paid = (usage.input * rates.input + usage.cacheWrite * rates.cacheWrite) / 1_000_000;
	const asRead = (paidTokens * rates.cacheRead) / 1_000_000;
	return Math.max(0, ((paid - asRead) * missed) / paidTokens);
}

/** 这次计费的输入按估的比例分到各部分，输出分成思考和正文。各部分加起来就是账单上的 token。 */
export function billedParts(reply: AssistantMessage, parts: InputParts): Record<UsageTokenPart, number> {
	const { usage } = reply;
	const billed = usage.input + usage.cacheRead + usage.cacheWrite;
	const estimated = INPUT_PARTS.reduce((sum, part) => sum + parts[part], 0);
	const out = { ...parts, outputThinking: 0, outputReply: 0 };
	for (const part of INPUT_PARTS) out[part] = estimated > 0 ? (parts[part] / estimated) * billed : part === "system" ? billed : 0;
	if (usage.output > 0) {
		let thinking = usage.reasoning ?? 0;
		if (!thinking) {
			const thought = reply.content.reduce((sum, block) => sum + (block.type === "thinking" ? estimateTokens(block.thinking) : 0), 0);
			const said = messagePart(reply).tokens;
			thinking = thought + said > 0 ? (thought / (thought + said)) * usage.output : 0;
		}
		out.outputThinking = Math.min(thinking, usage.output);
		out.outputReply = usage.output - out.outputThinking;
	}
	return out;
}

/** 回复里花在思考块上的毫秒，不超过生成那段，也不超过整次请求。 */
export function thinkingMs(reply: AssistantMessage): number | null {
	if (reply.durationMs === undefined || reply.sseDurationMs === undefined) return null;
	const thought = reply.content.reduce((sum, block) => sum + (block.type === "thinking" ? (block.durationMs ?? 0) : 0), 0);
	return Math.min(thought, reply.sseDurationMs, reply.durationMs);
}

/** 会话里最后一条回复之后的那些消息合成 `TailActivity`。工具结果因此记在调了它之后的那次请求上。 */
export function tailActivity(messages: readonly Message[]): TailActivity {
	const activity = { turns: 0, tools: 0, toolErrors: 0, toolMs: 0 };
	const tail = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
	for (const message of tail) {
		if (message.role === "user" && !message.synthetic) activity.turns += 1;
		else if (message.role === "toolResult") {
			activity.tools += 1;
			if (message.isError) activity.toolErrors += 1;
			activity.toolMs += message.durationMs ?? 0;
		}
	}
	return activity;
}
