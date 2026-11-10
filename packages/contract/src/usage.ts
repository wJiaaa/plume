/**
 * 使用统计（插件经 `ctx.model.usage()` 读）和存储页从 agent 进程拿到的数据。
 */

/**
 * 一小时里、一个供应商的一个模型发出的那些调用，合在一起。页面按它切区间、筛选、拆成柱，逐条的流水不出 agent 进程。
 * 来自会话库的花销表：删掉会话不影响这些数。
 */
export interface UsageRequestBucket {
	/** `YYYY-MM-DD HH`，本地时间。 */
	hour: string;
	/** 供应商 id。 */
	provider: string;
	model: string;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 按调用当时记下的价格算的美元。 */
	cost: number;
	/** 查不到价的请求数：页面上的费用因此只能写「≥」。 */
	unpriced: number;
	/** 量得出生成速度的请求数，以及它们的输出 token 与生成耗时之和。 */
	timed: number;
	timedOutput: number;
	streamMs: number;
	/** 量得出首字时间的请求数与总毫秒。 */
	firstTokens: number;
	firstTokenMs: number;
	/*
	 * 以下只算会话里一步步发的请求（含子会话），不含压缩摘要、分叉和插件的一次性调用：只有它们知道送进去的是什么、
	 * 前后两次能不能比。
	 */
	/** 这些请求计费的 token（输入含缓存读写）按来源分摊，加起来是它们账单上的总数。各部分是估的比例乘实数。 */
	parts: Record<UsageTokenPart, number>;
	/** 发这些请求的会话 id，子会话记成它的顶层会话；已经删掉的不在。跨小时、跨模型数会话要去重，所以给 id 不给个数。 */
	sessions: string[];
	/** 人发的话（不含界面替人说的），记在它之后的第一次请求上。 */
	turns: number;
	/** 有计时的请求数，和它们从发出到收完、其中生成、生成里思考块各占的毫秒。等首字 = modelMs − generateMs。 */
	timedReplies: number;
	modelMs: number;
	generateMs: number;
	thinkingMs: number;
	/** 工具调用次数、出错次数和执行毫秒（并行的各算各的），记在调完工具之后的那次请求上。 */
	tools: number;
	toolErrors: number;
	toolMs: number;
	/** 本该从缓存读到却按全价算的输入。 */
	cacheMiss: UsageCacheMiss;
}

/**
 * 计费 token 的来源：送进去的八类（系统提示词按段分出项目说明与记忆、技能与智能体，加上工具定义和四类消息）和吐出来的两类。
 * `injected` 是界面或插件替人说的话（`synthetic` 的用户消息）。
 */
export type UsageTokenPart =
	| "system"
	| "instructions"
	| "skills"
	| "toolDefs"
	| "user"
	| "injected"
	| "assistant"
	| "toolResults"
	| "outputThinking"
	| "outputReply";

/**
 * 缓存未命中的原因，按同一会话相邻两次请求比出来：工具定义、系统提示词变了；已发出的消息被改写；前缀没变服务商没读到；
 * 没有前缀记录分不清（重启后的第一次请求）；压缩、撤回之后有意重写；换了模型或服务商。
 */
export type UsageCacheMissCause = "tools" | "prompt" | "rewrite" | "provider" | "unknown" | "compaction" | "rewind" | "model";

export interface UsageCacheMiss {
	tokens: number;
	/** 按请求当时记下的费率，这些 token 比按缓存读取多花的美元。 */
	cost: number;
	/** 没记费率、算不出多花多少的那部分 token。 */
	unpriced: number;
	byCause: Partial<Record<UsageCacheMissCause, number>>;
}

export interface UsageScan {
	requests: UsageRequestBucket[];
	/** 供应商 id → 现在的名字。花销按 id 记，删掉的供应商不在这里，只剩 id。 */
	providerNames: Record<string, string>;
	/** 已归档的顶层会话 id，和 `UsageRequestBucket.sessions` 对着数归档了几个。 */
	archived: string[];
}

/** 一天里最后活动过的那些会话：几条，占多少。 */
export interface StorageDay {
	day: string;
	sessions: number;
	bytes: number;
}

export interface StorageUse {
	/** 会话记录占的字节数。 */
	bytes: number;
	/** 有几条会话。 */
	sessions: number;
	/** 最早、最晚那条会话的最后活动日（本地 `YYYY-MM-DD`）。没有会话时都是 null。 */
	earliest: string | null;
	latest: string | null;
	/** 按最后活动日摊开：选了一段日子会删掉什么，按下去之前就算得出来，确认框不会拿总数去问。 */
	days: StorageDay[];
}

/** 要删哪一段，两头都含当天（本地 `YYYY-MM-DD`）；空的那头不设限。 */
export interface ClearRange {
	from: string | null;
	to: string | null;
}

export interface ClearResult {
	/** 删掉了几条会话。 */
	removed: number;
	/** 释放了多少字节（按删之前量到的记录大小算）。 */
	freed: number;
	/** 正在跑、所以没动的那几条。 */
	skipped: number;
}
