/**
 * 厂商特例的描述方式。见 `index.ts` 顶上那段：为什么有这一层、和「撞出来再学」的那几张表怎么分工。
 *
 * 一条规则只是数据：在哪些模型 / 端点上、思考开关在每种格式下该怎么写。怎么把它翻成请求体是 `thinking.ts`
 * 的事，适配器只问结果，不认识任何一家厂商。
 */

/**
 * Anthropic 格式开思考的写法。
 *
 *   - `budget`：`thinking: {type: "enabled", budget_tokens}`。默认；端点点名不认时会学成 `adaptive`。
 *   - `adaptive`：`thinking: {type: "adaptive"}` + `output_config.effort`。
 *   - `enabled-effort`：`thinking: {type: "enabled"}` + `output_config.effort`——认 effort、忽略 budget 的兼容端点。
 *   - `effort-only`：只发 `output_config.effort`，不发 `thinking`——请求结构里根本没有这个字段的端点。
 */
export type AnthropicThinkingOn = "budget" | "adaptive" | "enabled-effort" | "effort-only";

/** 一个模型族在思考开关上的脾气。只写和默认不同的那几项，其余由 `index.ts` 的默认值补齐。 */
interface ThinkingDialect {
	anthropic?: AnthropicThinkingOn;
	/** Chat Completions 关思考时不收 `reasoning_effort: "none"`，整个字段不发。 */
	chatRefusesNone?: boolean;
	/** Responses 关思考时不收 `reasoning: {effort: "none"}`，整个 `reasoning` 不发。 */
	responsesRefusesNone?: boolean;
	/** Responses 上每个助手轮都要以推理项开头（DeepSeek）。见 `openai-responses-request.ts` 的补位分支。 */
	leadingReasoning?: boolean;
	/**
	 * 关不掉：服务端强制思考，发关闭参数会报错。界面上不给「关闭」，请求里也不发关闭参数。
	 */
	alwaysOn?: boolean;
}

/** 补齐默认值之后的结果。适配器拿到的就是这个。 */
export type ResolvedThinking = Required<ThinkingDialect>;

/** 一条规则。`model` 和 `endpoint` 都写时两个都要命中；要「任一命中」就写成两条。 */
export interface VendorRule {
	/** 线上模型名（`model.modelId`）。不写表示不看模型。 */
	model?: RegExp;
	/** 端点地址（`provider.baseUrl`）。不写表示不看端点。 */
	endpoint?: RegExp;
	thinking: ThinkingDialect;
	/**
	 * 同一前缀隔多久以内多半还读得到缓存，毫秒。不写就用分叉的默认值（`compaction-fork.ts` 的 `FORK_HOT_MS`，
	 * 按最短的常见有效期定）。写错的代价是一次压缩：分叉时缓存已凉，完整历史按原价读一遍。
	 */
	cacheHotMs?: number;
	/** 出处：官方原话、实测记录。说不出出处的不要加。 */
	source: string;
}
