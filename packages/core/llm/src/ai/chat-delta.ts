/**
 * Chat Completions 流的入站解码：一个 chunk 里的各个字段各是什么意思。
 *
 * 这里全是一帧看一帧、不碰网络的判断（跨 chunk 的 `<think>` 切分在 `think-tag.ts`）——各家把同一件事
 * 写成不同的形状，认形状的规则住在这里，`openai-chat-completions.ts` 只管把它们接进一条流的状态里。
 */

import type { StopReason } from "../types.ts";
import { argumentFragment } from "../utils/sse.ts";

// ---------------------------------------------------------------------------
// 入站：推理文本挂在哪个键上
// ---------------------------------------------------------------------------

/**
 * 同一件事的三个字段名，按常见程度排。
 *
 * 三个都看，取第一个非空。取第一个而不是拼起来，是因为有的宿主同一个 chunk 里给同一段推理挂两个
 * 别名——拼就重了。
 *
 * 从前这条链只读 `reasoning_content`。代价是 OpenRouter 走 chat/completions 时推理挂在 `delta.reasoning`
 * 上，于是界面上一个思考字都没有——不报错，只是没有。
 */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/** 这个 delta 里的推理文本，和它挂着的那个键。三个都看，取第一个非空的。 */
export function reasoningFromDelta(delta: Record<string, unknown>): { field: string; text: string } | undefined {
	for (const field of REASONING_FIELDS) {
		const value = delta[field];
		if (typeof value === "string" && value.length > 0) return { field, text: value };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// 入站：DeepSeek 的特殊 token 泄漏
// ---------------------------------------------------------------------------

/*
 * DeepSeek 的分词器保留 token 偶尔会原样出现在可见文本里。
 *
 * 来历：有的自建宿主不在服务端剥这些 token，于是它们进了 `delta.content`；而结构化
 * 的 `tool_calls` 照样是对的，所以要修的只是可见文本。
 *
 * 形状：两侧是全角 `｜`（U+FF5C）或 ASCII `|`，中间只允许标识符字符加 DeepSeek 分词器的 `▁`，长度设上限
 * ——三样限制都是为了不去吃普通的尖括号文本。
 *
 * **默认开**：我们没有一张记着哪些端点会泄漏的表，没法按端点开。代价说清楚：让模型原样输出一个字面的
 * `<|endoftext|>` 时，那串字会被吃掉。换来的是泄漏的 token 不会进历史——它一旦进了历史，下一轮就会被模型
 * 当成真的控制符看。
 *
 * 只做剥离这一档。还能再做一层：把用标记文本写出来的工具调用还原成结构化调用（五种方言）。那个不做：
 * 它要认五种方言的开闭标记、要在流中判断「这段文本其实是一个调用」、判错一次就把正常回答吞成一个不存在
 * 的工具调用。剥离是纯减法，还原是猜测，两者的失败代价差一个数量级。
 */
const DEEPSEEK_TOKEN = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/g;
const DEEPSEEK_TOKEN_AT_START = /^\s*<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/;
const DEEPSEEK_TOKEN_AT_END = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*$/;
const DEEPSEEK_OPEN_DELIMS = ["<｜", "<|"] as const;

/** 把泄漏的特殊 token 去掉。首尾被剥掉的那一个连带它旁边的空白一起去，免得留下一行空格。 */
export function stripDeepseekTokens(text: string): string {
	const stripped = text.replace(DEEPSEEK_TOKEN, "");
	if (stripped === text) return text;
	let normalized = stripped;
	if (DEEPSEEK_TOKEN_AT_START.test(text)) normalized = normalized.replace(/^\s+/u, "");
	if (DEEPSEEK_TOKEN_AT_END.test(text)) normalized = normalized.replace(/\s+$/u, "");
	return normalized;
}

/**
 * 结尾那个还没闭合的 token，扣下来等下一个 chunk。
 *
 * 一个 token 会被 SSE 切成两半（`<｜tool` / `▁calls▁begin｜>`），分开看两半都不匹配。末尾单独一个 `<`
 * 也扣着——它可能是下一个 token 的开头。扣留长度设上限，免得正文里一个孤零零的 `<｜` 让缓冲无限长。
 */
export function trailingPartialDeepseekToken(text: string): string {
	let bestIdx = -1;
	for (const delim of DEEPSEEK_OPEN_DELIMS) {
		const idx = text.lastIndexOf(delim);
		if (idx > bestIdx) bestIdx = idx;
	}
	if (bestIdx === -1) return text.endsWith("<") ? "<" : "";
	const tail = text.slice(bestIdx);
	if (tail.includes("｜>") || tail.includes("|>")) return "";
	if (tail.length > 256) return "";
	return tail;
}

// ---------------------------------------------------------------------------
// 入站：finish_reason
// ---------------------------------------------------------------------------


/**
 * `finish_reason` 说的是什么。认不出来的，名字里带着出错的意思才算失败。
 *
 * 从前只认 `stop` / `tool_calls` / `length` 三个，其余留在 `pending`，最后被兜成 `stop` 或 `toolUse`
 * ——**上游中途挂掉报 `finish_reason: "error"`，我们判成功**，把截断的半截答案交给 agent loop 接着跑。
 * 用户看到的是无声截断：没有错误，没有重试，就是话说到一半。
 *
 * 映射里每一条的来历：
 *
 *   - 先折大小写：网关顶着 Google Gemini 后端时会发原生的大写 `STOP` / `MAX_TOKENS`。
 *   - `error`：网关把上游模型的故障报成一个
 *     不带细节的裸 `error`，多数是临时的。
 *   - `insufficient_system_resource`：DeepSeek 自己的文档说这是推理系统资源不足导致的
 *     中断，属于服务端容量问题。
 *   - `content_filter`：内容策略。
 *
 * 后来补的几家：TGI 的 `eos_token` / `stop_sequence` 是正常说完，Mistral 的 `model_length` 是撞上长度上限，
 * 智谱的 `sensitive` 是内容审核。
 *
 * **认不出来的不再一律当失败**。一律当失败的规则要防的是上面 `error` 那种被判成成功的无声截断，而它的代价落在另一头：一个只是**说法不同**的正常结束（上面这几家
 * 补进来之前就是这样）每次都被作废、重试，重试拿到的还是同一个说法——同一家端点上**每一轮都失败**，
 * 用户手上没有任何办法绕过去。两头都会错的时候，看名字：带着出错、中断、超限意思的仍然是失败（防的那
 * 件事照旧防住），像内容审核的落进内容策略，剩下的按说完了交付。
 *
 * 返回 `stopReason` 表示这是一个正常的结束；返回 `error` 表示要抛，抛什么由调用方交给 `failure.ts` 判。
 */
export function mapFinishReason(reason: string): { stopReason?: StopReason; error?: string } {
	const normalized = reason.toLowerCase();
	switch (normalized) {
		case "stop":
		case "end":
		case "eos_token":
		case "stop_sequence":
			return { stopReason: "stop" };
		case "length":
		case "max_tokens":
		case "model_length":
			return { stopReason: "length" };
		case "tool_calls":
		case "function_call":
			return { stopReason: "toolUse" };
		/*
		 * 下面几档都是抛，但落进的分类不一样，而分类决定要不要重试（见 `failure.ts`）：
		 *
		 *   - 内容策略那两档的措辞会被 `FATAL_PHRASES` 里的内容策略那条抓住（`content_filter`、`内容审核`），
		 *     判成 `fatal`——不重试。对的：同一段历史再发一次还是同一个策略。
		 *   - 另外两档谁也不匹配，落进 `upstream`——重试。也对：它们说的都是上游一时的状况。
		 */
		case "content_filter":
			return { error: "回答被内容安全策略拦下（content_filter）" };
		case "sensitive":
			return { error: `回答被内容审核拦下（${reason}）` };
		case "insufficient_system_resource":
			return { error: "上游推理资源不足，这次回答被中断" };
		case "error":
		case "network_error":
			return { error: "上游报告这次生成失败" };
		default:
			/*
			 * 原话原样带在错误里：`failure.ts` 还会再看一遍这句话，z.ai 的
			 * `model_context_window_exceeded` 就是靠这个被认成上下文超长、进而触发压缩的。
			 */
			if (FAILED_FINISH.test(normalized)) return { error: `上游给了一个读不懂的结束原因：${reason}` };
			if (FILTERED_FINISH.test(normalized)) return { error: `回答被内容审核拦下（${reason}）` };
			return { stopReason: "stop" };
	}
}

/** 名字里带着「没做完」的意思。Gemini 的 `OTHER` / `MALFORMED_FUNCTION_CALL` 也在里面：它们是生成出了岔子。 */
const FAILED_FINISH = /error|fail|abort|cancel|interrupt|timeout|timed_out|exceeded|insufficient|unavailable|overload|malformed|unexpected|^other$/;

/** 名字里带着内容审核的意思。Gemini 的 `SAFETY` / `RECITATION` / `PROHIBITED_CONTENT` / `SPII` 经网关原样转来。 */
const FILTERED_FINISH = /filter|safety|sensitive|recitation|prohibited|blocklist|spii|moderat/;

// ---------------------------------------------------------------------------
// 入站：content 不一定是字符串
// ---------------------------------------------------------------------------

/**
 * 一个 delta 的 `content` 里，正文和推理各是什么。
 *
 * 协议写的是字符串，Mistral（Medium、Magistral）发的是**内容片段数组**：`[{type:"text",text}]`，推理模型
 * 还有 `{type:"thinking",thinking:[{type:"text",text}]}`。从前直接 `+=`，数组被转成 `[object Object]`
 * 写进正文、进了历史。
 *
 * 认不出来的片段一律丢掉，不转成字符串——宁可少一段，不能让对象的字面写法进正文。
 */
export function contentOfDelta(content: unknown): { text: string; thinking: string } {
	if (typeof content === "string") return { text: content, thinking: "" };
	const parts = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
	let text = "";
	let thinking = "";
	for (const part of parts) {
		if (typeof part === "string") {
			text += part;
			continue;
		}
		if (!part || typeof part !== "object") continue;
		const typed = part as { type?: unknown; text?: unknown; thinking?: unknown };
		if ((typed.type === undefined || typed.type === "text") && typeof typed.text === "string") {
			text += typed.text;
		} else if (typed.type === "thinking") {
			// Magistral 把推理再包一层片段数组；个别转译过的中转直接给字符串。
			thinking += typeof typed.thinking === "string" ? typed.thinking : contentOfDelta(typed.thinking).text;
		}
	}
	return { text, thinking };
}

// ---------------------------------------------------------------------------
// 入站：写在帧里的错误
// ---------------------------------------------------------------------------

/**
 * 顶层 `code` 是不是在报错：只认 HTTP 的错误码（400–599，数字或数字字符串）。
 *
 * 反过来列「成功码」列不全：中转的成功、心跳码有 `0`、`200`、`"0000"`、`"000000"`、`10000`……漏一个，一条
 * 健康的流就被判成失败。认错误码这一侧，最坏是一个写法古怪的错误帧落成空回答，照样会重试。
 */
const isErrorCode = (code: unknown): boolean => {
	const value = typeof code === "number" ? code : typeof code === "string" && /^\s*\d+\s*$/.test(code) ? Number(code) : Number.NaN;
	return value >= 400 && value <= 599;
};

/**
 * 这一帧是不是一个错误，是的话它说了什么。
 *
 * 从前只认 `error` 且**没有** `choices` 的帧。OpenRouter 的流内错误偏偏两样都带：顶层
 * `error: {code, message}`，外加 `choices: [{delta: {content: ""}, finish_reason: "error"}]`——于是错误被
 * 放过去，落到 `finish_reason: "error"` 上，原话丢了，只剩一句「上游报告这次生成失败」去重试：额度不足、
 * 上下文超长都认不出来，后者本该触发压缩。`{error, choices: []}` 更糟，落成一条空回答。
 *
 * 所以：`error` 带着一句话（字符串，或对象上的 `message`）就是错误，不看 `choices`；什么都没说的
 * `error` 只在没有可读的 `choices` 时才算——那是这里原来的判据，不收紧。
 *
 * 不写 `error` 的错误帧也有好几种，从前都落成空回答：SSE 自己的 `event: error`（`frameEvent`）、国内中转
 * 爱用的 `{code: 500, msg}` 和 `{success: false}`。后两种只在没有 `choices` 时才算：正常帧也有带着 `code: 0` 的，而真正的错误帧
 * 不会再带一份回答；`code` 还得是个错误码，见 `isErrorCode`。没给原话的返回 `{}`，分类器会从整帧原文里自己找。
 */
export function streamErrorOf(event: Record<string, unknown>, frameEvent?: string): { message?: string } | undefined {
	const error = event.error;
	const choices = event.choices;
	const answers = Array.isArray(choices) && choices.length > 0;
	if (error) {
		if (typeof error === "string") return { message: error };
		const said = typeof error === "object" ? (error as { message?: unknown }).message : undefined;
		if (typeof said === "string" && said.trim()) return { message: said };
		return answers ? undefined : {};
	}
	if (frameEvent === "error") return {};
	if (answers) return undefined;
	const said = [event.message, event.msg].find((value): value is string => typeof value === "string" && value.trim().length > 0);
	if (event.success === false) return { message: said };
	if (said && isErrorCode(event.code)) return { message: said };
	return undefined;
}

// ---------------------------------------------------------------------------
// 入站：usage 挂在哪
// ---------------------------------------------------------------------------

/**
 * 这一帧的用量。顶层没有就看 `choices[0].usage`。
 *
 * Kimi / Moonshot 把 usage 放在 choice 里，从前只读顶层，这几家的花费全记成 0。
 */
export function usageOf(event: Record<string, unknown>, choice: Record<string, unknown> | undefined): object | undefined {
	const top = event.usage;
	if (top && typeof top === "object") return top;
	const inChoice = choice?.usage;
	if (inChoice && typeof inChoice === "object") return inChoice;
	return undefined;
}

// ---------------------------------------------------------------------------
// 入站：工具参数的一个分片
// ---------------------------------------------------------------------------

/**
 * 一个工具调用的参数，接上这一片之后是什么。
 *
 * 协议写的是「字符串分片，按顺序拼」。实际有三种别的发法：
 *
 *   - **字符串，但收尾又重发了一遍整串**：先给完整的 `{"path":"a"}`，在带 `finish_reason` 的那一片里再给
 *     一次。拼起来是两份，解析失败，工具拒绝执行。判据：已攒的是一段完整 JSON，新来的也是完整 JSON，并且
 *     等于已攒的或以它开头——增量流里一段完整 JSON 后面不会再接一段以它整个开头的东西，所以只可能是快照。
 *   - **对象，每片带一部分键**：`{path:"a"}` 再 `{offset:10}`。从前按「对象就是整份参数」覆盖，前面的
 *     键丢了。改成合并。浅合并就够：见过的分片都是按顶层键分的，没见过把一个键的值拆成两半发的；真要拆，
 *     嵌套对象被后一片整个替换，和从前的覆盖是同一个结果，不会更坏。
 *   - **对象，每片重发同一整份**：合并同一份等于它自己，行为不变。
 *
 * 对象碰上 `+` 会变成 `[object Object]`，所以序列化走 `argumentFragment`。
 */
export function nextArguments(
	text: string,
	object: Record<string, unknown> | undefined,
	raw: unknown,
): { text: string; object?: Record<string, unknown> } {
	if (typeof raw === "string") return { text: isResentWhole(text, raw) ? raw : text + raw, object };
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const merged = { ...object, ...(raw as Record<string, unknown>) };
		return { text: argumentFragment(merged), object: merged };
	}
	return { text: argumentFragment(raw), object };
}

function isResentWhole(text: string, raw: string): boolean {
	// 先做便宜的判断：增量流里绝大多数分片比已攒的短，到不了解析那一步。
	if (!text || raw.length < text.length || !raw.startsWith(text)) return false;
	return isWholeJson(text) && isWholeJson(raw);
}

function isWholeJson(text: string): boolean {
	if (!text.trimStart().startsWith("{")) return false;
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}
