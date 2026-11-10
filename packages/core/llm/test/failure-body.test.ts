/**
 * 错误体里写着的东西，`failure.ts` 拿它判成什么：429 的原话、200 加 JSON 的错误体、只写在码里的超长。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure } from "../src/ai/failure.ts";

const status = (code: number, body: unknown) => classifyFailure({ from: "status", status: code, body: JSON.stringify(body) });

test("429 有厂商原话时摘要带着原话，不只是「被限流」", () => {
	const failure = status(429, { error: { message: "Rate limit reached for gpt-4o on tokens per min. Limit 30000.", type: "tokens" } });
	assert.equal(failure.kind, "upstream");
	assert.match(failure.summary, /Rate limit reached/);
});

test("可重试的状态码不因错误体里的一个码判死", () => {
	// new-api 某分组暂时没有可用渠道：503 加 `model_not_found`。渠道过一会儿会被重新启用，这该重试。
	const busy = status(503, { error: { message: "当前分组 default 下对于模型 gpt-5 无可用渠道", code: "model_not_found" } });
	assert.equal(busy.kind, "upstream");
	const streamed = classifyFailure({ from: "stream", raw: JSON.stringify({ error: { message: "无可用渠道", code: "model_not_found" } }) });
	assert.equal(streamed.kind, "upstream");
});

test("流里的错误帧只在码里说超长：照样认成超长、去压缩", () => {
	const overflow = classifyFailure({ from: "stream", raw: JSON.stringify({ error: { message: "bad request", code: "context_length_exceeded" } }) });
	assert.equal(overflow.code, "context-overflow");
});

test("200 加 JSON 错误体：重试上限照空回答，不吃满整份 upstream 预算", () => {
	const failure = classifyFailure({ from: "empty", why: "not-stream", body: JSON.stringify({ error: { message: "upstream busy" } }) });
	assert.equal(failure.kind, "upstream");
	assert.equal(failure.summary, "upstream busy");
	assert.equal(failure.retryLimit, 4);
});

test("200 标成 JSON 却一个字节都没有：照空回答报，不说收到了一整份 JSON", () => {
	assert.equal(classifyFailure({ from: "empty", why: "not-stream", body: "" }).summary, "服务商返回了空回答");
});
