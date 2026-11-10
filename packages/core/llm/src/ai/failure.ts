/**
 * 一次失败是什么、值不值得再试一次——只在这里回答一次。
 *
 * 从前这个判断被写了四遍：HTTP 状态码一份白名单（`isRetryableStatus`），传输异常一份白名单
 * （`isRetryableError`），流内 error 事件干脆当成「服务商本人拒绝了」直接早退，整轮恢复那层再
 * 拿一个 `retryable` 布尔自己判一次。四份名单互不知情，于是同一个故障在这一层算「可以再试」、
 * 在下一层算「没救了」，设置页写着「无限重试」而请求在第一次就放弃——因为那种失败压根没进过
 * 重试的门。
 *
 * 更要命的是四份都是**白名单**：只有见过的才重试。中转每换一种错法就多一个漏网的，而中转换错法
 * 这件事是不会停的。所以这里把默认值翻过来：
 *
 *   只有明确「再问一百遍也是这个答复」的才是 `fatal`，其余一切都值得再试。
 *
 * 黑名单是有限的、确定的、几乎不增长的——密钥、模型名、请求体、配额、内容策略，就这几样。而
 * 「其余一切」是敞开的：下一个没见过的状态码、下一种错误体格式、下一个只写着 `Unknown provider
 * error` 的空事件，不改一行代码就自动落进 `upstream`。
 *
 * 两个可重试的值刻意只有两个，因为设置页上就是两行（`RetryPolicy`）。类型层面保证「界面上能配
 * 的」和「实际会重试的」不会各说各话——想加第三类，改这个枚举，编译器会把该改的地方全指出来。
 */

/**
 * 摘要的长度上限。
 *
 * 界面上这句话只有一行的位置，而中转的错误体动辄是一整页 JSON 或者一段 HTML。原文不会丢——它在
 * `detail` 里，界面把它折进可滚动的区域和悬停提示——但顶在最前面的必须是一句能一眼看完的话。
 */
const SUMMARY_MAX = 48;

/** 原文留多少。够看清是什么，又不至于把一页 HTML 塞进会话日志的每一条记录。 */
const DETAIL_MAX = 2000;

type FailureKind = "network" | "upstream" | "fatal";

/**
 * 界面据此挂动作：401 旁边给「去检查密钥」，404 给「换个模型」。
 *
 * 是分类的产物而不是界面自己猜的，所以加一个动作不用碰分类逻辑，认一种新错误也不用碰界面。
 */
type FailureHint = "check-key" | "check-model" | "check-billing" | "check-request" | "blocked";

/**
 * 循环自己能处理的那几种 `fatal`，给程序认的名字。
 *
 * `hint` 是给界面挂动作的，粒度按「人该去改哪儿」分；这里按「循环能做什么」分，两者不重合：
 * 上下文超长和请求体格式错误在界面上都是 `check-request`，而只有前者压缩一次历史就可能过。
 */
type FailureCode = "context-overflow";

export interface Failure {
	kind: FailureKind;
	/** 一句话，一行放得下，给人看的。 */
	summary: string;
	/** 服务商原文，展开或悬停才看。 */
	detail?: string;
	/** 服务器自己说的等待时间，比任何我们猜的曲线都准。 */
	retryAfterMs?: number;
	hint?: FailureHint;
	/** 见 `FailureCode`。只在认出来时有，缺省不代表「不是」——旧日志里的失败都没有它。 */
	code?: FailureCode;
	/**
	 * 「还是刚才那个错误吗」的答案。
	 *
	 * 无限重试撞上一个我们不认识的终局错误时，界面唯一能说的真话就是「已经重连 47 次，一直是
	 * 同一个错误」。指纹让这句话不需要认识任何具体的错误就能说出口——真正的临时故障，文案和状态
	 * 码会变；一字不差重复几十次的，人一眼就知道不是在排队。
	 */
	fingerprint: string;
	/**
	 * 这一种失败自己的重试上限，和用户的策略取更严的那个。
	 *
	 * 绝大多数失败不该有这个——「重试几次」是用户的决定，设置页上那个「一直重试」写着的就是
	 * 「网络回来之前别放弃」，那是他要的。
	 *
	 * 例外是重发根本不可能改变结果的那些。空回答是眼下唯一一种：重发的是逐字节相同的请求体，
	 * 拿回来的是逐字节相同的空。服务端状态的波动（503、限流、实例在换）几次之内就会变个样子，
	 * 而几十次一模一样的，只说明这个请求在这个端点上就是会得到空——再等一百次也是。
	 *
	 * 真实日志里量到过一次：同一个请求重发 222 次、34 分钟，直到人工按停。
	 */
	retryLimit?: number;
	/**
	 * 这次失败有没有已经花掉 token。
	 *
	 * 流已经开始吐字，说明请求被受理了，那些 token 服务商已经收过钱——重试就是再付一次。连接在
	 * 握手阶段就断掉则一分钱没花。两者都该重试，但只有前者需要把代价摆到界面上，否则一个开着
	 * 无限重试的窗口可以安静地烧穿账单。
	 */
	costIncurred?: boolean;
}

export type FailureInput =
	/**
	 * fetch 本身抛了：连接没建立，或者建立后断了。
	 *
	 * `sending`：异常是从发请求那一下（`fetch(...)` 本身）抛出来的，而不是读流、解码时。只有调用 fetch
	 * 的那一处知道这件事，见 `fromTransport` 里用到它的那一段。
	 */
	| { from: "transport"; error: unknown; sending?: boolean }
	/** 服务器答了，但状态码不是 2xx。 */
	| { from: "status"; status: number; body?: string }
	/**
	 * 连接和状态码都正常，错误写在流里面。
	 *
	 * `streamed`：出错之前已经流到窗口里的正文（`spokenSoFar`）。服务商有时把拒绝当成回答写出来，再由中转
	 * 补一个泛泛的错误收尾，单看那个错误像是一次抖动——见 `refusalIn`。
	 */
	| { from: "stream"; message?: string; raw?: string; spent?: boolean; streamed?: string }
	/**
	 * 流正常结束，但一个字都没有——见 `fromEmpty`。
	 *
	 * `not-stream`：状态码 200、content-type 却明说是 JSON 或网页，正文根本不是 SSE（见 `retry.ts` 的
	 * `streamOrFailure`）。`output.truncated`：是不是撞了输出上限——撞上限的空不是故障。
	 */
	| { from: "empty"; why: "no-content" | "no-frames" | "unparsable" | "not-stream"; body?: string; output?: SpentOutput };

/** 空回答那一次，是不是撞了输出上限。 */
type SpentOutput = { truncated: boolean };

// ---------------------------------------------------------------------------
// 黑名单：唯一需要维护的名单
// ---------------------------------------------------------------------------

/**
 * 再问一百遍也是同一个答复的状态码。
 *
 * 401/403 是密钥，404 是模型名或地址，402 是钱，400/413/422 是请求体本身——注意最后这组在到达
 * 这里之前，`loop.ts` 已经试过裁掉历史重发一次了，所以走到这一步意味着裁完还是不行。
 *
 * 429 明显不在里面：它是「现在别问，等会儿再问」，是最该重试的一个。
 */
const FATAL_STATUS = new Map<number, { summary: string; hint: FailureHint }>([
	[400, { summary: "请求不被接受", hint: "check-request" }],
	[401, { summary: "密钥被拒绝", hint: "check-key" }],
	[403, { summary: "没有访问权限", hint: "check-key" }],
	[404, { summary: "模型或地址不存在", hint: "check-model" }],
	[402, { summary: "额度不足", hint: "check-billing" }],
	[413, { summary: "请求内容过大", hint: "check-request" }],
	[422, { summary: "请求参数不合法", hint: "check-request" }],
]);

/**
 * 证书出问题不是网络抖动。
 *
 * 一张过期的证书、一个对不上的域名，重试一百次还是同一张证书——公司代理换了根证书、自建中转只配了
 * 叶子证书，链补不全，重试一百次还是补不全。
 *
 * 认名字的规律而不是一张名单：OpenSSL 和 Node 的证书、TLS 错误码有几十个（`CERT_REVOKED`、
 * `ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN`……），从前的名单列了九个，漏掉的落进 network、默认无限重试。
 * 只认名字里带 `CERT` 的：`ERR_SSL_*` / `ERR_TLS_*` 里还有握手超时、`TLSV1_ALERT_INTERNAL_ERROR`、
 * `BAD_RECORD_MAC` 这类代理和边缘节点上偶发的告警，换一次连接就好，判成证书错误会停在一次抖动上，还让人
 * 去查一张没问题的证书。
 */
const isCertificateCause = (code: string): boolean => /CERT/.test(code) || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE";

/** 地址本身的问题：哪个码、哪句话，给人看什么。排在证书之前认，证书类统一说「证书校验失败」。 */
const ADDRESS_CAUSES = new Map<string, string>([
	["ERR_INVALID_URL", "接口地址无效"],
	// 用 https 连一个只开了 http 的端口（本地模型服务最常见）：对面回的不是 TLS，是地址写错了。
	["ERR_SSL_WRONG_VERSION_NUMBER", "协议不匹配，检查地址是 http 还是 https"],
]);

/**
 * 走 HTTP 代理时代理答的不是 200。undici 的原话 `Proxy response (407) !== 200 when HTTP Tunneling`，
 * code 是 `UND_ERR_ABORTED`——按码看是一次普通的中止，会被当断线无限重试。407 是代理要认证，凭据不改
 * 永远是 407；代理答的别的码（502、503）是代理自己在抖，照旧重试。
 */
const PROXY_STATUS = /Proxy response \((\d{3})\)/;

/**
 * cause 链最里层的错误码和一路上的原话。
 *
 * undici 把真正的原因包在一两层 `cause` 里：外层是 `fetch failed`，中间可能是一个只说「socket 出错」
 * 的包装，证书码在最里面。只看第一层会把证书问题认成断线。
 */
function causeChain(error: unknown): { code?: string; messages: string[] } {
	let code: string | undefined;
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
		const link = current as { code?: unknown; message?: unknown; cause?: unknown };
		if (typeof link.code === "string" && link.code) code = link.code;
		if (typeof link.message === "string") messages.push(link.message);
		current = link.cause;
	}
	return { code, messages };
}

/**
 * undici 拒绝发出的地址，`cause` 上没有 code、只有这么一句话：`ftp://`、`htp://` 这种不认识的协议，
 * 以及 fetch 规范禁用的端口（1、6000……）。地址不改，重试多少次都是这一句。
 */
const ADDRESS_REFUSALS = /^(unknown scheme|bad port)$/;

/**
 * 写在错误正文里的终局理由。
 *
 * 中转很少给出规矩的状态码——一个欠费的账号可能收到 200 加一个流内 error 事件。能认出来的就认，
 * 认不出来的落进 `upstream` 去重试，再由界面把「一直是同一个错误」说出来。所以这张表宁可短一些
 * 也不要猜：错判成 `fatal` 会让一次本可以自愈的抖动直接终止，那比多重试几次糟得多。
 */
/** 模型拒绝作答时交给分类器的那句话；上面的内容策略那条认它，判成 `blocked`、不重试。 */
export const REFUSAL_MESSAGE = "模型拒绝回答这次请求";

const FATAL_PHRASES: {
	match: Pick<RegExp, "test">;
	summary: string;
	hint: FailureHint;
	code?: FailureCode;
	notOnRateLimit?: true;
	/** 429 的整个正文说明这不是终局时跳过这条。 */
	passOnRateLimit?: (body: string) => boolean;
}[] = [
	{ match: /insufficient[_\s-]?(?:quota|credits|balance)|exceeded your current quota|余额不足|额度不足|欠费/i, summary: "额度不足", hint: "check-billing", passOnRateLimit: isPerMinuteQuota },
	{ match: /invalid[_\s-]?api[_\s-]?key|incorrect api key|unauthorized|api key not valid|密钥无效/i, summary: "密钥被拒绝", hint: "check-key" },
	{ match: /account[_\s-]?(deactivated|disabled|suspended|banned)|账号已(停用|禁用|封禁)/i, summary: "账号已停用", hint: "check-billing" },
	// `REFUSAL_MESSAGE` 是三条链在模型拒答时自己拼的那句（Anthropic `stop_reason: refusal`、两条 OpenAI 链的 `refusal` 字段）。
	{
		match: /content[_\s-]?filter|content[_\s-]?policy|safety|prohibited[_\s-]?(use|content)|sensitive words|moderation[_\s-]?blocked|违反.{0,6}政策|内容审核|stop_reason:\s*refusal|模型拒绝回答/i,
		summary: "内容被安全策略拒绝",
		hint: "blocked",
	},
	{ match: /model[_\s-]?not[_\s-]?found|does not exist|no such model|模型不存在/i, summary: "模型或地址不存在", hint: "check-model" },
	// 上下文超长也是这张表的一条，原话多、还在长，单独放在 `CONTEXT_OVERFLOW`。
	{ match: { test: isOverflowText }, summary: "上下文超出模型上限", hint: "check-request", code: "context-overflow", notOnRateLimit: true },
];

/**
 * Gemini 的每分钟限额。
 *
 * Gemini 把每分钟限流和按天的额度用完写成同一句 `You exceeded your current quota`（429
 * `RESOURCE_EXHAUSTED`），分得开的只有 `details` 里的 `QuotaFailure`：`quotaId` 是
 * `…PerMinute…` 还是 `…PerDay…`。前者等 `retryDelay` 说的几十秒就好，判成欠费会让一次限流直接
 * 终止这一轮。按天的、以及 OpenAI 真正的额度耗尽（`insufficient_quota`，正文里没有这些字样）照旧是终局。
 */
function isPerMinuteQuota(body: string): boolean {
	return /per[_\s-]?minute/i.test(body) && !/per[_\s-]?day|insufficient[_\s-]?quota/i.test(body);
}

/**
 * 上下文超出模型窗口：各协议、各服务商的说法都在这里，只在这里。
 *
 * 单独认出来，是因为它是 `fatal` 里循环能治的那一种——同一个请求重发一百次还是超长，压缩一次历史
 * 再发就可能过（`loop.ts` 的超长恢复）。认漏了，会话卡在这一轮；认错了，为一个压缩治不好的错
 * 多花一次摘要请求、再如实报错。后者代价有上限，所以宁可多收常见说法，但只收**指向「输入超窗」**
 * 的短语：`max_tokens` 参数本身不合法、限流，都不在这里。
 *
 * 新增一种：把原话里稳定的那一段写成正则放进 `phrases`，行尾注明哪家、原话长什么样；再在
 * `test/context-overflow.test.ts` 的样例表里加一行原话。只看状态码就能断定的，放进 `statuses`。
 * 来源多数取自 pi（`packages/ai/src/utils/overflow.ts`）等收集的实测原话。
 */
const CONTEXT_OVERFLOW = {
	/** 413：请求体超出服务端上限（Anthropic `request_too_large`、网关的 Payload Too Large），压小历史同样能过。 */
	statuses: new Set([413]),
	phrases: [
		/context[_\s-]?length[_\s-]?exceeded/i, // OpenAI 的 error.code；vLLM、中转常原样转发
		/(?:model_)?context_(?:window_)?exceeded/i, // 错误码：context_window_exceeded、model_context_window_exceeded（z.ai 把 finish_reason 写进错误）
		/maximum context length/i, // OpenAI / DeepSeek / OpenRouter / vLLM："This model's maximum context length is 65536 tokens. However, you requested …"
		/exceeds the context window/i, // OpenAI Responses："Your input exceeds the context window of this model."
		/prompt (?:is )?too long/i, // Anthropic："prompt is too long: 213462 tokens > 200000 maximum"；z.ai "Prompt too long"；Ollama
		/input length and `?max_tokens`? exceed context limit/i, // Anthropic 兼容端点："input length and `max_tokens` exceed context limit: 188000 + 21333 > 200000"
		/request_too_large/i, // Anthropic 413 的 error.type
		/input is too long for requested model/i, // Amazon Bedrock
		/input token count.{0,40}exceeds the maximum/i, // Gemini："The input token count (1196265) exceeds the maximum number of tokens allowed"
		/exceeded model token limit/i, // Kimi / Moonshot："Your request exceeded model token limit: 262144"
		/range of input length should be/i, // 通义 DashScope："Range of input length should be [1, 129024]"
		/context window exceeds limit/i, // MiniMax："invalid params, context window exceeds limit"
		/total message token length.{0,60}exceed/i, // OpenAI 兼容服务商："total message token length … exceed model limit"
		/maximum prompt length is \d+/i, // xAI："This model's maximum prompt length is 131072 but the request contains …"
		/reduce the length of the messages/i, // Groq；DeepSeek 与 OpenAI 旧文案的结尾
		/too large for model with \d+ maximum context length/i, // Mistral
		/longer than the model'?s context length/i, // Together："The input (X tokens) is longer than the model's context length (Y tokens)."
		/exceeds (?:the )?maximum allowed input length/i, // OpenRouter / Poolside
		/exceeds the available context size|greater than the context length/i, // llama.cpp / LM Studio
		/prompt token count of \d+ exceeds the limit/i, // GitHub Copilot
		/上下文.{0,8}(?:超过|超出|超限)|超出.{0,6}上下文|输入.{0,6}(?:超过|超出).{0,6}(?:上限|限制|最大)/, // 国内中转、自建网关的中文原话
		/*
		 * `too many tokens` 两头都有人说：上下文超长，和限流。Bedrock 系的限流原话是
		 * `Too many tokens, please wait before trying again.`（429 ThrottlingException），中转常把它原样塞进
		 * 流里。判成超长就是 `fatal`——一次等几秒就好的限流变成永久失败。所以后面跟着「等一等 / 再试 /
		 * 每分钟」的不算；状态码是 429 时整条都不看（`notOnRateLimit`），429 本身就是限流最确切的信号。
		 */
		/too many tokens(?![^.\n]{0,40}(?:wait|try again|retry|per\s+(?:min|minute|second|sec|day|hour)|rate))/i,
	],
	/** 同一句话里明说是限流的，哪条短语对上都不算——pi 用同样的排除挡住 Bedrock 的限流原话。 */
	notOverflow: /rate[_\s-]?limit|too many requests|throttl/i,
};

function isOverflowText(text: string): boolean {
	return !CONTEXT_OVERFLOW.notOverflow.test(text) && CONTEXT_OVERFLOW.phrases.some((phrase) => phrase.test(text));
}

/** 这次失败是不是上下文超长——循环据此决定要不要强制压缩一次再发。 */
export const isContextOverflow = (failure: Failure | undefined): boolean => failure?.code === "context-overflow";

/**
 * 传输层的老面孔，用来把 `network` 和 `upstream` 分开。
 *
 * 注意这已经不是准入名单了——认不出来的不会被拒之门外，只是归到 `upstream` 而已。它现在只负责
 * 回答「该用哪一条规则的间隔」，而不再决定「要不要重试」。这两件事从前是搅在一起的。
 */
const TRANSPORT_CAUSES = /^(UND_ERR_|ECONN|ETIMEDOUT|EPIPE|EAI_|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNRESET|EHOSTDOWN|ENETDOWN|EADDRNOTAVAIL)/;
const TRANSPORT_WORDS = /fetch failed|socket hang up|premature close|terminated|stream_read_error|network|connection|timeout|aborted|ecconn/i;

// ---------------------------------------------------------------------------
// 从原文里挑出一句人话
// ---------------------------------------------------------------------------

/** 常见状态码的固定说法，比把服务器的原文直接顶上去要好读。 */
const STATUS_WORDS = new Map<number, string>([
	[408, "请求超时"],
	[425, "请求过早"],
	[429, "被限流"],
	[500, "服务端异常"],
	[502, "网关错误"],
	[503, "服务暂时不可用"],
	[504, "网关超时"],
	[520, "中转返回未知错误"],
	[521, "源站拒绝连接"],
	[522, "连接源站超时"],
	[524, "源站响应超时"],
	[529, "服务过载"],
	[530, "源站不可达"],
]);

/** HTML 不是给人读的错误信息——一段 `<html><head><title>502` 顶在界面上等于什么都没说。 */
const looksLikeMarkup = (text: string) => /^\s*<(!doctype|html|head|body|pre|center)\b/i.test(text);

/**
 * 错误正文里那句真正说明问题的话。
 *
 * 每家中转把它放在不同的地方，所以按常见程度依次找。找不到就返回空，让调用方退回到状态码的固定
 * 说法——那也比把整个 JSON 糊在界面上强。
 */
export function messageFromBody(body: string | undefined): string {
	if (!body) return "";
	const text = body.trim();
	if (!text || looksLikeMarkup(text)) return "";
	try {
		const parsed: unknown = JSON.parse(text);
		const found = digForMessage(parsed, 0);
		if (found) return found;
	} catch {
		// 不是 JSON。纯文本的短错误照用，长的不要——那多半是一页别的东西。
		if (text.length <= 120 && !text.includes("\n")) return text;
	}
	return "";
}

/** `{error:{message}}`、`{message}`、`{detail}`、`{error:"..."} `——同一件事的四五种写法。 */
function digForMessage(value: unknown, depth: number): string {
	if (depth > 3 || !value) return "";
	if (typeof value === "string") return value.trim();
	// Gemini 等有时把整个错误体包在数组里：`[{"error":{...}}]`。
	if (Array.isArray(value)) return digForMessage(value[0], depth + 1);
	if (typeof value !== "object") return "";
	const record = value as Record<string, unknown>;
	for (const key of ["message", "detail", "error_message", "msg", "reason", "description"]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	for (const key of ["error", "err", "data", "body"]) {
		if (key in record) {
			const found = digForMessage(record[key], depth + 1);
			if (found) return found;
		}
	}
	return "";
}

/** 一行放得下的一句话。原文完整地留在 `detail` 里，这里只负责开头那句。 */
function shorten(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= SUMMARY_MAX) return flat;
	return `${flat.slice(0, SUMMARY_MAX - 1)}…`;
}

/**
 * 服务器说要等多久，毫秒。
 *
 * 从 `Retry-After` 头和错误正文两处找，因为两边都有人用。正文那一路尤其要紧：我们面前这个中转
 * 用 `{"reset_seconds":54}` 回答 503 而完全不发头，从前每一次等待都因此退回到猜的曲线上，几秒钟
 * 就把整个重试预算花在一场它早就说明要持续一分钟的故障上。
 */
export function serverDelayMs(header: string | null | undefined, body?: string): number | undefined {
	if (header) {
		const asSeconds = Number(header);
		const ms = Number.isFinite(asSeconds) ? asSeconds * 1000 : Date.parse(header) - Date.now();
		if (Number.isFinite(ms) && ms > 0) return ms;
	}
	if (!body) return undefined;
	/*
	 * 用正则而不是 `JSON.parse`，是故意的。
	 *
	 * 这个字段藏在不同的层级里，每家还不一样，真要解析就得预先知道所有形状。稳定的是「这个键名
	 * 后面跟着一个数」，而错误正文小到扫一遍不花什么。只认已知的键名，也只认看起来像等待时间的
	 * 数——满世界找数字，迟早会找到一个带数字的模型名然后睡上那么久。
	 */
	const numeric = body.match(/"(?:reset_seconds|retry_after|retry_after_seconds|retryAfter|retry_after_ms)"\s*:\s*(\d+(?:\.\d+)?)/);
	if (numeric) {
		const raw = Number(numeric[1]);
		const ms = numeric[0].includes("_ms") ? raw : raw * 1000;
		if (ms > 0) return ms;
	}
	// `"reset_time":"53s"`——同一件事写成字符串，也有人这么发。Gemini 的 `RetryInfo` 是 `"retryDelay":"30s"`。
	const written = body.match(/"(?:reset_time|retry_after|retryDelay)"\s*:\s*"(\d+(?:\.\d+)?)s"/);
	if (written) {
		const ms = Number(written[1]) * 1000;
		if (ms > 0) return ms;
	}
	// 写在句子里的：OpenAI `Please try again in 11.05s` / `in 1m2s` / `in 20ms`，Gemini `Please retry in 30.5s`。
	const sentence = body.match(/(?:try again|retry) in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i);
	return sentence ? durationMs(sentence[1]) : undefined;
}

/**
 * `1m2s`、`6m0s`、`11.05s`、`20ms` 这种时长写法，毫秒。OpenAI 的 `x-ratelimit-reset-*` 头和
 * 限流原话都这么写。整串都得是时长，认不出就是 `undefined`。
 */
export function durationMs(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(trimmed)) return undefined;
	const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
	let total = 0;
	for (const [, value, name] of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) total += Number(value) * unit[name];
	return total > 0 ? total : undefined;
}

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

/**
 * 把一次失败压成一个短串，用来判断「还是刚才那个错误吗」。
 *
 * 归一化掉每次都会变的东西——数字、UUID、时间戳——否则每条带请求 id 的错误都是「新」的，这个
 * 判断就永远不会成立。
 */
function fingerprintOf(kind: FailureKind, key: string): string {
	const normalized = key
		.toLowerCase()
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#")
		/*
		 * 请求 id 多半是十六进制，而不是十进制。
		 *
		 * 只归一化纯数字是不够的：`request 8f2a1b` 和 `request c93d4e` 是同一个错误的两次，而按
		 * 数字规则它们长得完全不同——于是「一直是同一个错误」这句话永远说不出口。要求里面至少有
		 * 一个数字，免得把 `deadbeef` 这样的普通词也吃掉。
		 */
		.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/g, "#")
		.replace(/\b\d+\b/g, "#")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	let hash = 0;
	for (let index = 0; index < normalized.length; index++) {
		hash = (Math.imul(hash, 31) + normalized.charCodeAt(index)) | 0;
	}
	return `${kind}:${(hash >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

export function classifyFailure(input: FailureInput): Failure {
	switch (input.from) {
		case "transport":
			return fromTransport(input.error, input.sending === true);
		case "status":
			return fromStatus(input.status, input.body);
		case "stream":
			return fromStream(input.message, input.raw, input.spent === true, input.streamed);
		case "empty":
			return fromEmpty(input.why, input.body, input.output);
	}
}

/**
 * 状态码写在异常消息里的那些。
 *
 * `FailureError` 之外，还有一类错误是「已经被压成一句话」的：某处 `throw new Error("HTTP 401:
 * ...")`，或者一个库抛出 `400 Bad Request`。从异常的角度看它们没有 `cause.code`、不认识自己，会
 * 一路落到「没见过的连接问题」里去重试——而 401 重试一万次也还是 401。
 *
 * 只认开头那几种明确的写法。满句子找三位数，迟早会把某个带数字的模型名或者一个字节数当成状态码。
 */
const STATUS_IN_TEXT = [/^HTTP (\d{3})\b/, /^(\d{3}) [A-Z]/, /\bstatus(?: code)?[:\s]+(\d{3})\b/i];

function statusFromText(text: string): number | undefined {
	for (const pattern of STATUS_IN_TEXT) {
		const found = text.match(pattern);
		if (found) {
			const status = Number(found[1]);
			if (status >= 400 && status <= 599) return status;
		}
	}
	return undefined;
}

function fromTransport(error: unknown, sending: boolean): Failure {
	const cause = (error as { cause?: { code?: string; message?: unknown } })?.cause;
	const chain = causeChain(error);
	const code = chain.code;
	const text = error instanceof Error ? error.message : String(error);

	/*
	 * 消息里写着状态码的，按状态码判——它比「这是个异常」这件事说明的多。
	 *
	 * 放在证书检查之后、传输兜底之前：证书问题有自己的 `cause.code`，而这一段针对的是连 code 都
	 * 没有、只剩一句话的那种。
	 */
	if (!code) {
		const status = statusFromText(text);
		if (status !== undefined) return fromStatus(status, text);
	}

	if (code && (ADDRESS_CAUSES.has(code) || isCertificateCause(code))) {
		const address = ADDRESS_CAUSES.get(code);
		return {
			kind: "fatal",
			summary: address ?? "证书校验失败",
			detail: truncateDetail(`${text}${code ? ` (${code})` : ""}`),
			hint: address ? "check-model" : undefined,
			fingerprint: fingerprintOf("fatal", code),
		};
	}

	const proxy = chain.messages.map((message) => message.match(PROXY_STATUS)?.[1]).find(Boolean);
	if (proxy === "407") {
		return {
			kind: "fatal",
			summary: "代理要求认证，检查代理设置里的账号密码",
			detail: truncateDetail(chain.messages.join(" ← ")),
			fingerprint: fingerprintOf("fatal", "proxy-407"),
		};
	}

	// 和码一样看整条 cause 链：这句原话包在第二层时，只看第一层会认成断线、一直重试。
	const refusal = code ? undefined : chain.messages.find((message) => ADDRESS_REFUSALS.test(message));
	if (refusal) {
		return {
			kind: "fatal",
			summary: "接口地址无效",
			detail: truncateDetail(`${text} (${refusal})`),
			hint: "check-model",
			fingerprint: fingerprintOf("fatal", refusal),
		};
	}

	/*
	 * fetch 在发出去之前就拒绝了这个请求。
	 *
	 * 真正的连接故障从 fetch 里出来都是 `TypeError: fetch failed`，原因挂在 `cause` 上；没有 `cause`
	 * 的 `TypeError` 是 fetch 自己在校验参数——请求头的值不是 ByteString（密钥里混进零宽空格、全角
	 * 字母）、请求头里有换行。这种请求一个字节都没发出去，重试一万次也发不出去，而它从前落进
	 * `network`，默认无限重试，界面就在「重连中」里一直转。
	 *
	 * 只在 `sending` 时这样判：读流、解码时抛的 `TypeError`（一帧形状不对的 JSON 上取属性）也没有
	 * `cause`，可那是这一次响应的问题，换一次响应可能就好了。
	 */
	if (sending && error instanceof TypeError && cause === undefined) {
		const header = /ByteString|header/i.test(text);
		return {
			kind: "fatal",
			summary: header ? "请求头含非法字符，检查密钥是否混入了空格或全角字符" : "请求无法发出",
			detail: truncateDetail(text),
			hint: header ? "check-key" : "check-request",
			fingerprint: fingerprintOf("fatal", text),
		};
	}

	/*
	 * 认不出来的也算连接问题，只要它是从 fetch 里抛出来的。
	 *
	 * 走到这里意味着连接层出了状况而我们没见过它的名字。归到 `network` 而不是 `upstream`，是因为
	 * 抛出的位置本身就是证据：服务器要是答了话，我们会在状态码那一路见到它。
	 */
	const known = code ? TRANSPORT_CAUSES.test(code) : TRANSPORT_WORDS.test(text);
	return {
		kind: "network",
		summary: known ? "连接中断" : shorten(text) || "连接中断",
		detail: truncateDetail(`${text}${code ? ` (${code})` : ""}`),
		fingerprint: fingerprintOf("network", code ?? text),
	};
}

function fromStatus(status: number, body?: string): Failure {
	const said = messageFromBody(body);
	const detail = truncateDetail(body ?? "");
	const fatal = FATAL_STATUS.get(status);

	if (fatal) {
		/*
		 * 请求体类的拒收里，认出上下文超长。看整个正文而不只是 `said`：OpenAI 把 `context_length_exceeded`
		 * 写在 `error.code`，`messageFromBody` 挑出来的那句不一定带它。
		 */
		const saysOverflow = fatal.hint === "check-request" && isOverflowText(body ?? "");
		const overflow = saysOverflow || CONTEXT_OVERFLOW.statuses.has(status);
		/*
		 * 状态码只说了「不会变」，没说「去改哪儿」：Gemini 把无效密钥答成 400，中转把模型名写错也答成 400。
		 * 正文里认得出理由的，按理由给动作；超长那条上面已经认过，这里不再让它改写动作。
		 */
		const named = saysOverflow ? undefined : matchFatalPhrase(said || body || "");
		const reason = named && !named.code ? named : fatal;
		return {
			kind: "fatal",
			summary: saysOverflow ? "上下文超出模型上限" : said ? `${reason.summary}：${shorten(said)}` : reason.summary,
			detail,
			hint: reason.hint,
			...(overflow ? { code: "context-overflow" as const } : {}),
			fingerprint: fingerprintOf("fatal", `${status}:${said}`),
		};
	}

	/*
	 * 正文里写着终局理由的，即使状态码看着像临时故障也照拒。
	 *
	 * 有的中转把欠费答成 503，重试到天荒地老也不会变成有钱。
	 */
	const phrase = matchFatalPhrase(said || body || "", status === 429 ? body ?? "" : undefined);
	if (phrase) {
		return {
			kind: "fatal",
			summary: phrase.summary,
			detail,
			hint: phrase.hint,
			...(phrase.code ? { code: phrase.code } : {}),
			fingerprint: fingerprintOf("fatal", `${status}:${phrase.summary}`),
		};
	}

	const words = STATUS_WORDS.get(status);
	return {
		kind: "upstream",
		/*
		 * 固定说法比原文好读，但 429 是例外：「被限流」谁都会说，限的是什么（每分钟 token、并发、某个模型）
		 * 只有原话里有，而那决定人是该等一等还是该换个模型。
		 */
		summary: status === 429 && said ? `被限流：${shorten(said)}` : words ? words : said ? shorten(said) : `服务端返回 ${status}`,
		detail,
		retryAfterMs: serverDelayMs(undefined, body),
		fingerprint: fingerprintOf("upstream", `${status}:${said}`),
	};
}

function fromStream(message: string | undefined, raw: string | undefined, spent: boolean, streamed?: string): Failure {
	const said = (message ?? "").trim() || messageFromBody(raw);
	/*
	 * 超长另看整帧原文，同 `fromStatus`：只在 `error.code` 里写 `context_length_exceeded` 的错误帧，挑出来的
	 * 那句话不带它，不认就当临时故障重试，轮不到压缩。
	 */
	const phrase = matchFatalPhrase(said || raw || "") ?? (raw && isOverflowText(raw) ? OVERFLOW_REASON : undefined);
	if (phrase) {
		return {
			kind: "fatal",
			summary: phrase.summary,
			detail: truncateDetail(raw ?? said),
			hint: phrase.hint,
			...(phrase.code ? { code: phrase.code } : {}),
			fingerprint: fingerprintOf("fatal", phrase.summary),
			costIncurred: spent || undefined,
		};
	}

	/*
	 * 错误本身什么也没说，但它前面流出来的是服务商的拒绝。
	 *
	 * Gemini 经中转时把拒绝当成回答流出来——「The prompt could not be submitted … violate Google's
	 * Generative AI Prohibited Use policy」——中转再补一个泛泛的 `internal_server_error`。只看错误就是一次
	 * 抖动，于是每 5 秒重试一次，每次再流一遍同一段拒绝，直到有人按停。
	 */
	if (refusalIn(streamed)) {
		return {
			kind: "fatal",
			summary: "内容被安全策略拒绝",
			detail: truncateDetail([streamed?.trim(), raw ?? said].filter(Boolean).join("\n\n")),
			hint: "blocked",
			fingerprint: fingerprintOf("fatal", "streamed-refusal"),
			costIncurred: spent || undefined,
		};
	}

	/*
	 * 从前这里是直接放弃的。
	 *
	 * 一句「服务商自己拒绝了，再问也是同样答复」的注释，把中转塞进流里的每一种临时故障都判了
	 * 死刑——包括那个连 message 都不给、只能显示成 `Unknown provider error` 的空事件。它现在
	 * 和别的临时故障一样重试，认得出是终局理由的才在上面那一段被拦下。
	 */
	return {
		kind: "upstream",
		summary: said ? shorten(said) : "服务商中断了这次回答",
		detail: truncateDetail(raw ?? said),
		// 流内错误常只给一句话（`… Please try again in 6m0s.`），原始帧里没有就看那句话。
		retryAfterMs: serverDelayMs(undefined, raw) ?? serverDelayMs(undefined, said),
		fingerprint: fingerprintOf("upstream", said || "stream-error"),
		costIncurred: spent || undefined,
	};
}

function fromEmpty(why: "no-content" | "no-frames" | "unparsable" | "not-stream", body?: string, output?: SpentOutput): Failure {
	const said = messageFromBody(body);
	/*
	 * 不是流、却说了一句话：那是一个写成 JSON 的错误，和流里的错误帧是同一件事，照那一路判。重试上限照空回答：
	 * 200 加一句认不出的错误，多半是配置或网关的问题，重发的又是同一个请求体，不该吃满整份 upstream 预算。
	 */
	if (why === "not-stream" && said) {
		const failure = fromStream(said, body, false);
		return failure.kind === "fatal" ? failure : { ...failure, retryLimit: EMPTY_REPLY_RETRIES };
	}
	const phrase = matchFatalPhrase(said || body || "");
	if (phrase) {
		return {
			kind: "fatal",
			summary: phrase.summary,
			detail: truncateDetail(body ?? ""),
			hint: phrase.hint,
			...(phrase.code ? { code: phrase.code } : {}),
			fingerprint: fingerprintOf("fatal", phrase.summary),
		};
	}
	/*
	 * 一个字都没有，推理把输出上限用完了。
	 *
	 * 这不是故障。从前它落进下面的空回答，同一个请求重发四次，每次都把上限用完、每次都付钱。重发不会变，
	 * 能变的是人：调高最大输出，或者降低思考档位。
	 *
	 * 只认撞了上限的。正常结束、推理花了 token 却没给回答的不在这里：那是偶发的，重发一次常常就好，照旧走
	 * 下面的空回答重试。
	 */
	if (output?.truncated) {
		return {
			kind: "fatal",
			summary: "输出上限被推理用完，调高最大输出或降低思考档位",
			detail: truncateDetail(body ?? ""),
			hint: "check-model",
			fingerprint: fingerprintOf("fatal", "empty:output-exhausted"),
			costIncurred: true,
		};
	}
	/*
	 * 空回复也是失败。
	 *
	 * 从前不是：流正常结束、一个字都没有，会以 `stopReason: "stop"` 收场，屏幕上留下一条空白的
	 * 回答，既不报错也不重试。真值表里有三种故障长这样——一个把错误写成 JSON 却回 200 的中转、
	 * 一个空流、一串非法 JSON——它们和「模型确实没话说」在结局上完全无法区分。
	 */
	// 地址填到了控制台、官网首页上，回来的是 200 加一页 HTML。
	const webPage = why === "not-stream" && looksLikeMarkup(body ?? "");
	const summary = said
		? shorten(said)
		: why === "unparsable"
			? "返回的内容无法解析"
			: webPage
				? "接口返回了网页而不是回答，检查接口地址"
				: why === "not-stream" && body?.trim()
					? "接口没有按流式返回，收到的是一整份 JSON"
					: "服务商返回了空回答";
	return {
		kind: "upstream",
		summary,
		detail: truncateDetail(body ?? ""),
		...(webPage ? { hint: "check-model" as const } : {}),
		fingerprint: fingerprintOf("upstream", `empty:${why}:${said}`),
		/*
		 * 空回答仍然是失败，仍然重试——只是不会重试到地老天荒。见 `Failure.retryLimit`。
		 *
		 * 四次，因为这四次发的是同一个请求体。真临时的波动（中转在重启、实例在换）一两次之内就
		 * 会变个样子，四次是给它的宽限；四次之后还是一模一样的空，继续发第五次唯一确定的事情是
		 * 再等五秒。
		 */
		retryLimit: EMPTY_REPLY_RETRIES,
	};
}

/**
 * 空回答最多重试几次，无论用户把重试设成了什么。
 *
 * 单独命名而不是写成一个字面量，因为解释它的那段话和用到它的地方必须待在一起——下一个想调大
 * 它的人要先读过「重发的是同一个请求体」这句。
 */
const EMPTY_REPLY_RETRIES = 4;

/**
 * 服务商自己的拒绝句式，以回答的形式到达时的样子。
 *
 * 刻意比 `FATAL_PHRASES` 窄：那张表读的是报错正文，那里的 safety 就是拒绝；这里读的是模型写的字，
 * safety 也可能是在讲线程安全。所以只认固定句式，而且只在短回答里认——拒绝就一两句话，不会是一篇
 * 长回答的结尾恰好引用了一句。
 */
const STREAMED_REFUSALS = [/Generative AI Prohibited Use policy/i, /The prompt could not be submitted/i, /prompt contains sensitive words/i];
const REFUSAL_MAX_CHARS = 600;

function refusalIn(streamed: string | undefined): boolean {
	const text = streamed?.trim() ?? "";
	return text.length > 0 && text.length <= REFUSAL_MAX_CHARS && STREAMED_REFUSALS.some((pattern) => pattern.test(text));
}

/** 进行中的回复里已经显示出来的正文——人已经看到的那部分，不含思考。 */
export function spokenSoFar(content: readonly { type: string; text?: string }[]): string {
	return content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("");
}

/** 只看整段原文认出的超长，和 `FATAL_PHRASES` 里那条给一样的结论。 */
const OVERFLOW_REASON = { summary: "上下文超出模型上限", hint: "check-request", code: "context-overflow" } as const;

/** `rateLimitedBody`：状态码是 429 时的整个正文，只有 429 才给。 */
function matchFatalPhrase(text: string, rateLimitedBody?: string): { summary: string; hint: FailureHint; code?: FailureCode } | undefined {
	if (!text) return undefined;
	for (const rule of FATAL_PHRASES) {
		if (rateLimitedBody !== undefined && (rule.notOnRateLimit || rule.passOnRateLimit?.(rateLimitedBody))) continue;
		if (rule.match.test(text)) return { summary: rule.summary, hint: rule.hint, ...(rule.code ? { code: rule.code } : {}) };
	}
	return undefined;
}

function truncateDetail(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	return trimmed.length <= DETAIL_MAX ? trimmed : `${trimmed.slice(0, DETAIL_MAX)}…（还有 ${trimmed.length - DETAIL_MAX} 字）`;
}

/** 值得再试一次吗。三层重试问的都是这一个问题。 */
export const worthRetrying = (failure: Failure): boolean => failure.kind !== "fatal";

/**
 * 一个已经判过的失败，被包成异常往上抛。
 *
 * 少了它就会判两遍，而第二遍是错的：一个 401 在状态码那一路被正确地判成 `fatal`，调用方把它抛成
 * `new Error("HTTP 401: invalid key")`，到了流重试那一层就只剩一个字符串——从异常的角度看它既没有
 * `cause.code` 也不认识自己，于是落进「认不出来的连接问题」，然后被无限重试。判断带着结论一起走，
 * 上面每一层就都不必再猜。
 */
export class FailureError extends Error {
	readonly failure: Failure;
	constructor(failure: Failure) {
		super(failure.summary);
		this.name = "FailureError";
		this.failure = failure;
	}
}

/**
 * 这个异常代表的失败是什么。
 *
 * 已经判过的照搬，没判过的当传输故障判——那是异常唯一可能的另一个来源。
 */
export function failureOf(error: unknown): Failure {
	if (error instanceof FailureError) return error.failure;
	return classifyFailure({ from: "transport", error });
}
