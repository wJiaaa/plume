import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyFailure, messageFromBody, serverDelayMs, worthRetrying } from "../src/ai/failure.ts";
import { RetryBudget, fetchWithRetry } from "../src/ai/retry.ts";

const transport = (code?: string, message = "fetch failed") =>
	classifyFailure({ from: "transport", error: code ? Object.assign(new Error(message), { cause: { code } }) : new Error(message) });

test("认得出的传输故障算连接问题", () => {
	for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]) {
		const failure = transport(code);
		assert.equal(failure.kind, "network", `${code} 应当算连接问题`);
		assert.equal(worthRetrying(failure), true);
	}
});

test("没见过的传输故障也重试，而不是当场放弃", () => {
	// 白名单时代的漏网之鱼：名字没见过就一律不重试。
	const failure = transport("EWEIRD_NEW_CODE");
	assert.equal(failure.kind, "network");
	assert.equal(worthRetrying(failure), true);
});

test("证书问题不重试——再试一百次还是同一张证书", () => {
	for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
		assert.equal(transport(code).kind, "fatal", `${code} 应当直接报错`);
	}
	assert.equal(transport("ERR_INVALID_URL").summary, "接口地址无效");
});

test("密钥、模型、额度、请求体——只有这几样不重试", () => {
	assert.equal(classifyFailure({ from: "status", status: 401 }).kind, "fatal");
	assert.equal(classifyFailure({ from: "status", status: 403 }).kind, "fatal");
	assert.equal(classifyFailure({ from: "status", status: 404 }).kind, "fatal");
	assert.equal(classifyFailure({ from: "status", status: 402 }).kind, "fatal");
	assert.equal(classifyFailure({ from: "status", status: 400 }).kind, "fatal");
	assert.equal(classifyFailure({ from: "status", status: 413 }).kind, "fatal");
	assert.equal(classifyFailure({ from: "status", status: 422 }).kind, "fatal");
	// 界面据此给出下一步，所以分类必须带上它。
	assert.equal(classifyFailure({ from: "status", status: 401 }).hint, "check-key");
	assert.equal(classifyFailure({ from: "status", status: 404 }).hint, "check-model");
	assert.equal(classifyFailure({ from: "status", status: 402 }).hint, "check-billing");
});

test("白名单外的状态码现在会重试", () => {
	// 改动前这两个直接报错——真值表里的「漏网」两行。
	for (const status of [520, 521, 530, 598, 466]) {
		const failure = classifyFailure({ from: "status", status });
		assert.equal(failure.kind, "upstream", `${status} 应当重试`);
		assert.equal(worthRetrying(failure), true);
	}
	assert.equal(classifyFailure({ from: "status", status: 429 }).kind, "upstream");
	assert.equal(classifyFailure({ from: "status", status: 503 }).kind, "upstream");
});

test("流内 error 事件重试，哪怕它什么都没说", () => {
	// 截图里那个：中转发一个空的 error 事件，界面显示 Unknown provider error。
	const bare = classifyFailure({ from: "stream" });
	assert.equal(bare.kind, "upstream");
	assert.equal(worthRetrying(bare), true);
	assert.equal(bare.summary, "服务商中断了这次回答");

	const withMessage = classifyFailure({ from: "stream", message: "upstream temporarily unavailable" });
	assert.equal(withMessage.kind, "upstream");
});

test("正文里写着终局理由的，状态码再像临时故障也照拒", () => {
	// 有的中转把欠费答成 503。
	const quota = classifyFailure({ from: "status", status: 503, body: JSON.stringify({ error: { code: "insufficient_quota" } }) });
	assert.equal(quota.kind, "fatal");
	assert.equal(quota.hint, "check-billing");

	// OpenRouter 流内错误帧的原话、DeepSeek 402 的原话。
	for (const message of ["Insufficient credits. Add more using https://openrouter.ai/credits", "Insufficient Balance"]) {
		assert.equal(classifyFailure({ from: "stream", message }).hint, "check-billing", message);
	}

	const banned = classifyFailure({ from: "stream", message: "account_suspended: contact support" });
	assert.equal(banned.kind, "fatal");

	const filtered = classifyFailure({ from: "stream", message: "content_filter triggered" });
	assert.equal(filtered.kind, "fatal");
	assert.equal(filtered.hint, "blocked");
});

test("空回答算失败，不算「模型没话说」", () => {
	for (const why of ["no-content", "no-frames", "unparsable"] as const) {
		const failure = classifyFailure({ from: "empty", why });
		assert.equal(failure.kind, "upstream", `${why} 应当重试`);
	}
	assert.equal(classifyFailure({ from: "empty", why: "unparsable" }).summary, "返回的内容无法解析");
});

test("摘要一行放得下，原文一个字不丢", () => {
	const long = "x".repeat(5000);
	const failure = classifyFailure({ from: "status", status: 500, body: JSON.stringify({ error: { message: long } }) });
	assert.ok(failure.summary.length <= 48, `摘要 ${failure.summary.length} 字，超了一行的位置`);
	assert.ok((failure.detail?.length ?? 0) > 100, "原文应当留着，给悬停和展开用");
	assert.ok(failure.detail!.includes("还有"), "截断时要说明还有多少");
});

test("一页 HTML 不会被顶到摘要上", () => {
	const failure = classifyFailure({ from: "status", status: 502, body: "<html><head><title>502 Bad Gateway</title></head><body>...</body></html>" });
	assert.equal(failure.summary, "网关错误");
	assert.ok(!failure.summary.includes("<"), "摘要里不该有标签");
});

test("错误正文的五种写法都能挑出那句话", () => {
	assert.equal(messageFromBody(JSON.stringify({ error: { message: "上游繁忙" } })), "上游繁忙");
	assert.equal(messageFromBody(JSON.stringify({ message: "上游繁忙" })), "上游繁忙");
	assert.equal(messageFromBody(JSON.stringify({ detail: "上游繁忙" })), "上游繁忙");
	assert.equal(messageFromBody(JSON.stringify({ error: "上游繁忙" })), "上游繁忙");
	assert.equal(messageFromBody(JSON.stringify({ data: { error: { reason: "上游繁忙" } } })), "上游繁忙");
	assert.equal(messageFromBody("上游繁忙"), "上游繁忙");
	assert.equal(messageFromBody("<html>502</html>"), "");
});

test("服务器说的等待时间，头和正文两处都认", () => {
	assert.equal(serverDelayMs("2"), 2000);
	assert.equal(serverDelayMs(null, JSON.stringify({ error: { reset_seconds: 54 } })), 54_000);
	assert.equal(serverDelayMs(null, JSON.stringify({ reset_time: "53s" })), 53_000);
	assert.equal(serverDelayMs(null, JSON.stringify({ retry_after_ms: 1500 })), 1500);
	assert.equal(serverDelayMs(null, JSON.stringify({ retry_after: 7 })), 7000);
	assert.equal(serverDelayMs(null, JSON.stringify({ retry_after_seconds: 7 })), 7000);
	assert.equal(serverDelayMs(null, JSON.stringify({ model: "gpt-4o-2024" })), undefined, "模型名里的数字不是等待时间");
	assert.equal(serverDelayMs(null, JSON.stringify({ error: { code: 503 } })), undefined, "状态码也不是");
	assert.equal(serverDelayMs(null, "not json at all"), undefined);
	assert.equal(serverDelayMs(null, undefined), undefined);
});

test("限流原话、Gemini 的 retryDelay 里写着的等待时间也认", () => {
	const openai = JSON.stringify({ error: { message: "Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 29000. Please try again in 11.05s.", type: "tokens", code: "rate_limit_exceeded" } });
	assert.equal(serverDelayMs(null, openai), 11_050);
	assert.equal(serverDelayMs(null, "Please try again in 1m2s."), 62_000);
	assert.equal(serverDelayMs(null, "Please try again in 20ms."), 20);
	assert.equal(classifyFailure({ from: "stream", message: "Rate limit reached. Please try again in 6m0s." }).retryAfterMs, 360_000);
	const gemini = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota. Please retry in 30.5s.", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }] } });
	assert.equal(serverDelayMs(null, gemini), 30_000);
	assert.equal(serverDelayMs(null, "retry in 5 minutes"), undefined, "不是时长写法的不猜");
});

test("Gemini 每分钟限流用的是欠费那句话，按限流重试；按天用完和 OpenAI 的额度耗尽照旧是终局", () => {
	const gemini = (quotaId: string) => JSON.stringify({
		error: {
			code: 429,
			status: "RESOURCE_EXHAUSTED",
			message: "You exceeded your current quota, please check your plan and billing details.",
			details: [
				{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId }] },
				{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "31s" },
			],
		},
	});
	const perMinute = classifyFailure({ from: "status", status: 429, body: gemini("GenerateRequestsPerMinutePerProjectPerModel-FreeTier") });
	assert.equal(perMinute.kind, "upstream");
	assert.equal(perMinute.retryAfterMs, 31_000);
	assert.equal(classifyFailure({ from: "status", status: 429, body: gemini("GenerateRequestsPerDayPerProjectPerModel-FreeTier") }).hint, "check-billing");
	const openai = JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } });
	assert.equal(classifyFailure({ from: "status", status: 429, body: openai }).kind, "fatal");
});

test("529 过载按上游故障重试", () => {
	const overloaded = classifyFailure({ from: "status", status: 529, body: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) });
	assert.equal(overloaded.kind, "upstream");
	assert.equal(worthRetrying(overloaded), true);
});

test("同一个错误的指纹一样，不同的不一样", () => {
	const first = classifyFailure({ from: "stream", message: "upstream busy (request 8f2a1b)" });
	const second = classifyFailure({ from: "stream", message: "upstream busy (request c93d4e)" });
	// 每条都带着不同的请求 id，归一化掉才认得出「还是刚才那个错误」。
	assert.equal(first.fingerprint, second.fingerprint);

	const other = classifyFailure({ from: "stream", message: "model overloaded" });
	assert.notEqual(first.fingerprint, other.fingerprint);
});

/**
 * 状态码耗尽的重试，不会被另一类的额度接着养下去。
 *
 * 这是改动过程中真出过的一个死循环，而且是默认配置就会撞上的：`fetchWithRetry` 把判好的
 * `FailureError` 抛在自己的 `try` 里，被自己的 `catch` 接住，那里查的是 network 预算——默认无限。
 * 一个 upstream 额度早已用尽的 503 于是永远重试下去，`retry-policy.test.ts` 整个文件挂住，一条都
 * 跑不出来，看起来像是测试框架坏了。
 */
test("upstream 用尽就停，不会被 network 的无限额度接着重试", async () => {
	let calls = 0;
	const budget = new RetryBudget({
		network: { retries: null, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
		upstream: { retries: 2, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
	});
	await assert.rejects(
		fetchWithRetry(
			async () => {
				calls++;
				return new Response("busy", { status: 503 });
			},
			"https://example.test",
			{},
			{ budget, sleep: async () => {} },
		),
	);
	// 首次 + 两次重试，然后停下——而不是转到天荒地老。
	assert.equal(calls, 3);
});

test("花过钱的失败标出来，没花的不标", () => {
	// 流已经吐了字，说明请求被受理了——那些 token 服务商已经收过钱。
	assert.equal(classifyFailure({ from: "stream", message: "boom", spent: true }).costIncurred, true);
	assert.equal(classifyFailure({ from: "stream", message: "boom" }).costIncurred, undefined);
	assert.equal(transport("ECONNRESET").costIncurred, undefined);
});

test("状态码已经判了终局时，正文写明的理由决定该去改哪儿", () => {
	// Gemini 把无效密钥答成 400，只看状态码就成了「检查请求」，人会去翻请求体。
	const key = classifyFailure({ from: "status", status: 400, body: JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }) });
	assert.equal(key.kind, "fatal");
	assert.equal(key.hint, "check-key");
	// 中转把模型名写错答成 400。
	const model = classifyFailure({ from: "status", status: 400, body: JSON.stringify({ error: { message: "model not found: gpt-9" } }) });
	assert.equal(model.hint, "check-model");
	// 没说理由的，照旧按状态码。
	assert.equal(classifyFailure({ from: "status", status: 400, body: JSON.stringify({ error: { message: "messages: field required" } }) }).hint, "check-request");
	assert.equal(classifyFailure({ from: "status", status: 401 }).hint, "check-key");
	// 超长的认法不受影响。
	const overflow = classifyFailure({ from: "status", status: 400, body: JSON.stringify({ error: { message: "prompt is too long: 213462 tokens > 200000 maximum" } }) });
	assert.equal(overflow.code, "context-overflow");
	assert.equal(overflow.hint, "check-request");
});

test("数组包着的错误正文也挑得出那句话", () => {
	// Gemini 等有时把错误体包在数组里：`[{"error":{...}}]`。
	assert.equal(messageFromBody(JSON.stringify([{ error: { code: 400, message: "API key not valid." } }])), "API key not valid.");
	assert.equal(classifyFailure({ from: "status", status: 400, body: JSON.stringify([{ error: { message: "API key not valid." } }]) }).hint, "check-key");
});

// 2026-10-13 上游实际收到的：Gemini 经中转把拒绝当成回答流出来，中转再用一个泛泛的错误事件收尾。
// 每 5 秒重试一次，直到手动停止。
const GOOGLE_REFUSAL =
	"The prompt could not be submitted. The prompt contains sensitive words that violate Google's Generative AI Prohibited Use policy. Try rephrasing the prompt. If you think this was an error, send feedback.";
const RELAY_CLOSE = '{"type":"error","code":"internal_server_error","message":"response_stream_incomplete: upstream responses stream closed before response.completed","sequence_number":0}';

test("服务商把拒绝写成回答、再被中转泛泛地断掉，认出是拒绝，不重试", () => {
	const refused = classifyFailure({ from: "stream", message: "response_stream_incomplete: upstream responses stream closed before response.completed", raw: RELAY_CLOSE, spent: true, streamed: GOOGLE_REFUSAL });
	assert.equal(refused.kind, "fatal");
	assert.equal(refused.hint, "blocked");
	assert.equal(worthRetrying(refused), false);
	assert.ok(refused.detail?.includes("Prohibited Use policy"), "the refusal itself is kept for the hover");

	// The same close with nothing refused before it is still a hiccup worth another try.
	const hiccup = classifyFailure({ from: "stream", message: "response_stream_incomplete: upstream responses stream closed before response.completed", raw: RELAY_CLOSE, spent: true, streamed: "这是一段正常的回答，说到一半" });
	assert.equal(hiccup.kind, "upstream");
});

test("正常回答里提到 safety 或拒绝的句式，断流照样重试", () => {
	const answer = `${"线程安全靠这把锁保证。".repeat(60)} This lock guarantees thread safety. The prompt could not be submitted in a long essay about it.`;
	const cut = classifyFailure({ from: "stream", message: "回答只传了一半，连接就断了", spent: true, streamed: answer });
	assert.equal(cut.kind, "upstream", "a long answer that quotes a refusal is not one");
	const short = classifyFailure({ from: "stream", message: "回答只传了一半，连接就断了", spent: true, streamed: "This lock guarantees thread safety." });
	assert.equal(short.kind, "upstream", "only the providers' own refusal sentences count in a model's text");
});

test("400 的正文写着被内容策略拦下，判成被拦，而不是请求体有问题", () => {
	const blocked = classifyFailure({ from: "status", status: 400, body: '{"error":{"message":"Your request was rejected as a result of our safety system: moderation_blocked","code":"moderation_blocked"}}' });
	assert.equal(blocked.kind, "fatal");
	assert.equal(blocked.hint, "blocked");
	const malformed = classifyFailure({ from: "status", status: 400, body: '{"error":{"message":"Invalid value for messages[3].content"}}' });
	assert.equal(malformed.hint, "check-request", "an ordinary bad request keeps its own reading");
	const prohibited = classifyFailure({ from: "stream", message: "PROHIBITED_CONTENT" });
	assert.equal(prohibited.hint, "blocked");
});
