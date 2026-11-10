/**
 * 三条协议的用量字段：每个桶从哪几个字段读、按什么顺序回退、`input` 里含不含缓存。
 *
 * 从前三个适配器各写一段 `if (typeof raw.xxx === "number")`，Chat 链只认 `prompt_tokens_details.cached_tokens`、
 * 缓存写入写死 0——DeepSeek 的命中数在 `prompt_cache_hit_tokens`、Kimi 的在顶层 `cached_tokens`，于是这两家
 * 的缓存命中在账上一直是 0、全按原价算。服务商每多一个，三处就各要改一遍，改漏一处就是一条账不对。
 *
 * 现在只有一张表（`USAGE_DIALECTS`）。**新增一个服务商变体 = 在对应协议、对应桶的列表里加一行**，
 * 写明字段路径和出处；解析逻辑一个字都不用动。
 *
 * 四个桶（input / output / cacheRead / cacheWrite）必须不重叠——用量页和计价器都是四个桶直接相加，
 * 重叠一份就算两遍钱。`reasoning` 不是第五个桶，它是 output 里的一部分，只用于展示。
 */

import type { ApiFormat, Usage } from "../types.ts";

/** 一个字段来源。`path` 是 usage 对象里的点分路径；`source` 写明哪家服务商、依据是文档还是参考实现。 */
interface UsageField {
	path: string;
	source: string;
}

/** 表里能声明的桶。 */
export type UsageBucket = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning";

/** 一条协议的用量方言。 */
interface UsageDialect {
	/**
	 * `input` 字段报的那个数里含着哪些缓存桶。含着就要扣掉，四个桶才不重叠。
	 *
	 * OpenAI 两条协议是「含」（`prompt_tokens` = 未命中 + 命中 + 写入），Anthropic 是「不含」
	 * （`input_tokens` 只是缓存断点之后那一段）。这是协议语义，不是服务商差异。
	 */
	inputIncludes: readonly ("cacheRead" | "cacheWrite")[];
	/** 服务商直接报了「未命中」那一份时，用它当 input，不再做减法。 */
	uncachedInput: readonly UsageField[];
	/** 每个桶的候选字段，按优先级排。 */
	fields: Readonly<Record<UsageBucket, readonly UsageField[]>>;
}

/**
 * 声明表。每一行的出处写在 `source` 里；指不出出处的不要往这里加。
 *
 * 同一个桶的几个字段是**同一个量的别名**，不是要相加的几部分——所以取值规则是「第一个大于 0 的」，
 * 见 `pick`。
 */
const USAGE_DIALECTS: Readonly<Record<ApiFormat, UsageDialect>> = {
	"openai-chat-completions": {
		inputIncludes: ["cacheRead", "cacheWrite"],
		uncachedInput: [
			{ path: "prompt_cache_miss_tokens", source: "DeepSeek 文档：prompt_tokens = hit + miss" },
		],
		fields: {
			input: [{ path: "prompt_tokens", source: "OpenAI 文档" }],
			output: [{ path: "completion_tokens", source: "OpenAI 文档（含 reasoning_tokens）" }],
			cacheRead: [
				{ path: "prompt_tokens_details.cached_tokens", source: "OpenAI / OpenRouter / Kimi 文档" },
				{ path: "prompt_cache_hit_tokens", source: "DeepSeek 文档" },
				{ path: "cached_tokens", source: "Kimi 文档：最后一个 usage chunk 的顶层字段；pi openai-completions.ts parseChunkUsage" },
				{ path: "prompt_token_details.cached_tokens", source: "pi mistral-conversations.ts：少一个 s 的拼写变体" },
				{ path: "num_cached_tokens", source: "pi mistral-conversations.ts" },
				{ path: "cache_read_input_tokens", source: "LiteLLM 转发 Anthropic 模型时顶层带的 Anthropic 字段" },
			],
			cacheWrite: [
				{ path: "prompt_tokens_details.cache_write_tokens", source: "Kimi 文档；OpenRouter（pi openai-completions.ts parseChunkUsage）" },
				{ path: "prompt_tokens_details.cache_creation_input_tokens", source: "阿里云百炼显式缓存文档（未实测）" },
				{ path: "cache_creation_input_tokens", source: "LiteLLM 转发 Anthropic 模型时顶层带的 Anthropic 字段" },
				{ path: "cache_write_tokens", source: "推断：与 Kimi 顶层 cached_tokens 对称的写法，未见服务商文档" },
			],
			reasoning: [{ path: "completion_tokens_details.reasoning_tokens", source: "OpenAI 文档" }],
		},
	},
	"openai-responses": {
		inputIncludes: ["cacheRead", "cacheWrite"],
		uncachedInput: [],
		fields: {
			input: [{ path: "input_tokens", source: "OpenAI 文档" }],
			output: [{ path: "output_tokens", source: "OpenAI 文档（含 reasoning_tokens）" }],
			cacheRead: [{ path: "input_tokens_details.cached_tokens", source: "OpenAI 文档" }],
			cacheWrite: [
				{ path: "input_tokens_details.cache_write_tokens", source: "OpenRouter Responses（pi openai-responses-shared.ts）" },
			],
			reasoning: [{ path: "output_tokens_details.reasoning_tokens", source: "OpenAI 文档" }],
		},
	},
	"anthropic-messages": {
		inputIncludes: [],
		uncachedInput: [],
		fields: {
			input: [{ path: "input_tokens", source: "Anthropic 文档：不含缓存读写" }],
			output: [{ path: "output_tokens", source: "Anthropic 文档" }],
			cacheRead: [
				{ path: "cache_read_input_tokens", source: "Anthropic 文档；DeepSeek / Kimi / MiniMax 的 Anthropic 兼容端点同名" },
			],
			cacheWrite: [
				{ path: "cache_creation_input_tokens", source: "Anthropic 文档；兼容端点同名" },
			],
			reasoning: [],
		},
	},
};

/** 点分路径取一个非负有限数。别的（null、字符串、负数）一律当没有。 */
function numberAt(raw: Record<string, unknown>, path: string): number | undefined {
	let node: unknown = raw;
	for (const key of path.split(".")) {
		if (!node || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return typeof node === "number" && Number.isFinite(node) && node >= 0 ? node : undefined;
}

/**
 * 几个别名里取一个：第一个大于 0 的；都是 0 就是 0；一个数都没有就是没有。
 *
 * 不照抄 pi 的 `a ?? b ?? c`（取第一个非空）：中转常在标准位置填一个占位的 `cached_tokens: 0`，
 * 真正的数在服务商自己的字段里——`??` 会停在那个 0 上，命中永远记成 0。别名说的是同一个量，
 * 不存在「一个说 0、另一个说 500 而 0 才对」的情况。
 */
function pick(raw: Record<string, unknown>, fields: readonly UsageField[]): number | undefined {
	let seen: number | undefined;
	for (const field of fields) {
		const value = numberAt(raw, field.path);
		if (value === undefined) continue;
		if (value > 0) return value;
		seen = 0;
	}
	return seen;
}

/**
 * 按协议读出这一帧里出现了的桶。没出现的桶不在结果里——调用方据此决定「不动」而不是「清零」。
 *
 * 「`input` 含缓存」的协议有一条额外约束：input 和它含着的那几个桶**一起给、一起更新**。给了 input
 * 却没给缓存字段，缓存桶就是 0，不能沿用上一帧的值——否则扣的和存的不是同一个数，桶又重叠了。
 */
export function readUsage(api: ApiFormat, raw: Record<string, unknown>): Partial<Record<UsageBucket, number>> {
	const dialect = USAGE_DIALECTS[api];
	const out: Partial<Record<UsageBucket, number>> = {};
	for (const bucket of ["output", "cacheRead", "cacheWrite", "reasoning"] as const) {
		const value = pick(raw, dialect.fields[bucket]);
		if (value !== undefined) out[bucket] = value;
	}
	const total = pick(raw, dialect.fields.input);
	const uncached = pick(raw, dialect.uncachedInput);
	if (dialect.inputIncludes.length === 0) {
		if (total !== undefined) out.input = total;
		return out;
	}
	if (total === undefined && uncached === undefined) return out;
	for (const bucket of dialect.inputIncludes) out[bucket] ??= 0;
	const included = dialect.inputIncludes.reduce((sum, bucket) => sum + (out[bucket] ?? 0), 0);
	out.input = uncached ?? Math.max(0, (total ?? 0) - included);
	return out;
}

/**
 * 把一帧用量合进 `usage`：出现了的桶覆盖，没出现的不动，`total` 跟着重算。
 *
 * 「没出现的不动」是 Anthropic 那条链要的：`message_start` 带输入和缓存，`message_delta` 通常只带
 * `output_tokens`，清零会把前一帧的输入抹掉。费用不在这里算，见 `priceAttempt`。
 */
export function applyUsage(api: ApiFormat, usage: Usage, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const read = readUsage(api, raw as Record<string, unknown>);
	if (read.input !== undefined) usage.input = read.input;
	if (read.output !== undefined) usage.output = read.output;
	if (read.cacheRead !== undefined) usage.cacheRead = read.cacheRead;
	if (read.cacheWrite !== undefined) usage.cacheWrite = read.cacheWrite;
	if (read.reasoning !== undefined) usage.reasoning = read.reasoning;
	usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
