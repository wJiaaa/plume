/**
 * `hoistLocalRefs`：指向 `$defs` 以外的本地引用搬进 `$defs`。Kimi 的 MFJS 规范只认 `#/$defs/...`，
 * 原样发出去整个请求过不了校验。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { toAnthropicTools } from "../src/ai/anthropic-messages-request.ts";
import { toChatCompletionsTools } from "../src/ai/openai-chat-completions-request.ts";
import { toResponsesTools } from "../src/ai/openai-responses-request.ts";
import { hoistLocalRefs } from "../src/ai/tool-schema.ts";

test("没有要搬的引用：原样返回同一个对象，提示缓存不受影响", () => {
	const schema = { type: "object", properties: { a: { $ref: "#/$defs/A" } }, $defs: { A: { type: "string" } } };
	assert.equal(hoistLocalRefs(schema), schema);
});

test("`#/definitions/X` 搬进 `$defs`，原处不留第二份", () => {
	const schema = { type: "object", properties: { stop: { $ref: "#/definitions/Stop" } }, definitions: { Stop: { type: "string", enum: ["a", "b"] } } };
	assert.deepEqual(hoistLocalRefs(schema), {
		type: "object",
		properties: { stop: { $ref: "#/$defs/Stop" } },
		$defs: { Stop: { type: "string", enum: ["a", "b"] } },
	});
});

test("指向别的属性的引用：目标复制进 `$defs`，原处也改成引用", () => {
	const schema = { type: "object", properties: { from: { type: "object", properties: { x: { type: "number" } } }, to: { $ref: "#/properties/from" } } };
	const out = hoistLocalRefs(schema) as { properties: Record<string, unknown>; $defs: Record<string, unknown> };
	assert.deepEqual(out.properties, { from: { $ref: "#/$defs/from" }, to: { $ref: "#/$defs/from" } });
	assert.deepEqual(out.$defs.from, { type: "object", properties: { x: { type: "number" } } });
});

test("解析不到的引用不动、不抛", () => {
	const schema = { type: "object", properties: { a: { $ref: "#/definitions/Missing" } } };
	assert.equal(hoistLocalRefs(schema), schema);
});

test("三种格式发出去的工具 schema 都搬过", () => {
	const parameters = { type: "object", properties: { stop: { $ref: "#/definitions/Stop" } }, definitions: { Stop: { type: "string" } } };
	const tools = [{ name: "t", description: "d", parameters }];
	const anthropic = toAnthropicTools(tools)[0] as { input_schema: Record<string, unknown> };
	const chat = toChatCompletionsTools(tools)[0] as { function: { parameters: Record<string, unknown> } };
	const responses = toResponsesTools(tools)[0] as { parameters: Record<string, unknown> };
	for (const schema of [anthropic.input_schema, chat.function.parameters, responses.parameters]) {
		assert.deepEqual((schema.properties as Record<string, unknown>).stop, { $ref: "#/$defs/Stop" });
		assert.equal("definitions" in schema, false);
	}
});
