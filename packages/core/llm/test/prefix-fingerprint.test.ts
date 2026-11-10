/**
 * 缓存未命中的归因证据：请求前缀从哪里开始和上一次不同。
 *
 * 只看 usage 分不清「本地改了前缀」和「服务商没读到」——这两种要做的事完全不同。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePrefix, payloadSegments } from "../src/ai/prefix-fingerprint.ts";

test("只追加消息时没有变化；改了中间一条，变化落在那一条上", () => {
	const first = payloadSegments({ system: "s", tools: [{ name: "t" }], messages: [{ role: "user", content: "a" }] });
	const appended = payloadSegments({ system: "s", tools: [{ name: "t" }], messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
	assert.deepEqual(comparePrefix(first, appended), { segments: 5 });

	const edited = payloadSegments({ system: "s", tools: [{ name: "t" }], messages: [{ role: "user", content: "a!" }, { role: "assistant", content: "b" }] });
	assert.deepEqual(comparePrefix(appended, edited).change, { segment: "messages[0]", before: 29, after: 30 });
	assert.equal(comparePrefix(appended, payloadSegments({ system: "s2", tools: [{ name: "t" }], messages: [] })).change?.segment, "system");
});

test("Chat Completions 开头那条 system 消息记成 system，改了提示词不会被当成改写历史", () => {
	const body = (prompt: string) => ({ tools: [{ name: "t" }], messages: [{ role: "system", content: prompt }, { role: "user", content: "a" }] });
	assert.deepEqual(payloadSegments(body("s")).map((segment) => segment.name), ["tools", "system", "params", "messages[1]"]);
	assert.equal(comparePrefix(payloadSegments(body("s")), payloadSegments(body("s2"))).change?.segment, "system");
});

test("挪动的 cache_control 断点不算前缀变化", () => {
	const before = payloadSegments({ messages: [{ role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] }] });
	const after = payloadSegments({ messages: [{ role: "user", content: [{ type: "text", text: "a" }] }, { role: "user", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] }] });
	assert.equal(comparePrefix(before, after).change, undefined);
});

test("工具 schema 和调用参数里同名的 cache_control 是真数据，变了照样算", () => {
	const tools = (value: string) => [{ name: "t", input_schema: { type: "object", properties: { cache_control: { const: value } } }, cache_control: { type: "ephemeral" } }];
	assert.equal(comparePrefix(payloadSegments({ tools: tools("no-store") }), payloadSegments({ tools: tools("public") })).change?.segment, "tools");
	const call = (value: string) => ({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "t", input: { cache_control: value } }] }] });
	assert.equal(comparePrefix(payloadSegments(call("no-store")), payloadSegments(call("public"))).change?.segment, "messages[0]");
	const system = (breakpoint: boolean) => ({ system: [{ type: "text", text: "s", ...(breakpoint ? { cache_control: { type: "ephemeral" } } : {}) }] });
	assert.equal(comparePrefix(payloadSegments(system(true)), payloadSegments(system(false))).change, undefined, "system 块上的断点不算");
});

test("thinking 档位这类请求参数变了算前缀变化；逐次重算的输出上限不算", () => {
	const body = (budget: number, maxTokens: number) => ({ model: "m", max_tokens: maxTokens, stream: true, thinking: { type: "enabled", budget_tokens: budget }, system: "s", messages: [{ role: "user", content: "a" }] });
	assert.equal(comparePrefix(payloadSegments(body(4096, 8000)), payloadSegments(body(24_576, 8000))).change?.segment, "params");
	assert.equal(comparePrefix(payloadSegments(body(4096, 8000)), payloadSegments(body(4096, 6000))).change, undefined);
});

test("某一段整个出现或消失（关掉 thinking、工具全断开），变化记在那一段上，不错位到后面", () => {
	const on = { system: "s", thinking: { type: "enabled", budget_tokens: 4096 }, messages: [{ role: "user", content: "a" }] };
	const off = { system: "s", messages: [{ role: "user", content: "a" }] };
	assert.equal(comparePrefix(payloadSegments(on), payloadSegments(off)).change?.segment, "params");
	assert.equal(comparePrefix(payloadSegments(off), payloadSegments(on)).change?.segment, "params");
	const withTools = { tools: [{ name: "t" }], system: "s", messages: [{ role: "user", content: "a" }] };
	assert.equal(comparePrefix(payloadSegments(withTools), payloadSegments(off)).change?.segment, "tools");
	const chat = (system: boolean) => ({ messages: [...(system ? [{ role: "system", content: "s" }] : []), { role: "user", content: "a" }] });
	assert.equal(comparePrefix(payloadSegments(chat(true)), payloadSegments(chat(false))).change?.segment, "system");
});

test("字符串内容改写成带断点的单个 text 块不算前缀变化", () => {
	// Chat Completions 给 Claude 放断点时就是这么改写的，下一轮断点挪走又变回字符串。
	const marked = (text: string) => [{ type: "text", text, cache_control: { type: "ephemeral" } }];
	const tail = { tools: [], messages: [{ role: "system", content: marked("s") }, { role: "user", content: marked("a") }] };
	const next = { tools: [], messages: [{ role: "system", content: marked("s") }, { role: "user", content: "a" }, { role: "assistant", content: marked("b") }] };
	assert.equal(comparePrefix(payloadSegments(tail), payloadSegments(next)).change, undefined);
	// 内容真变了照样算。
	const edited = { tools: [], messages: [{ role: "system", content: "s" }, { role: "user", content: "a!" }] };
	assert.equal(comparePrefix(payloadSegments(tail), payloadSegments(edited)).change?.segment, "messages[1]");
});
