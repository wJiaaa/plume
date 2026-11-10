/**
 * 失败换成读的人的语言说；系统已经在解释的留给系统；认不出的原样放过去。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { translateIn } from "../../../packages/client/ui/src/i18n/translate.ts";
import { explain } from "../src/renderer/toast/explain.ts";

const zh = (key: Parameters<typeof translateIn>[1]) => translateIn("zh-CN", key);

test("屏幕录制被拒留给 macOS 自己的对话框", () => {
	const result = explain("Failed to get sources.", zh);
	assert.equal(result.silent, true);
	assert.match(result.hint ?? "", /屏幕录制/);
});

test("供应商的 5xx 是一句话，不是一大段 JSON", () => {
	const raw = `HTTP 500: {"error":{"message":"EOF","type":"server_error","code":"internal_server_error"}}`;
	const result = explain(raw, zh);
	assert.equal(result.message, "模型服务暂时不可用");
	assert.equal(result.silent, undefined);
});

test("errno 换成它的意思", () => {
	assert.equal(explain("Error: ENOENT: no such file or directory, open '/tmp/x'", zh).message, "找不到这个文件或目录");
	assert.equal(explain("EACCES: permission denied", zh).message, "没有权限访问这个文件");
	assert.match(explain("connect ECONNREFUSED 127.0.0.1:8080", zh).message, /连接被拒绝/);
});

test("凭证和限流分得开", () => {
	assert.match(explain("HTTP 401 Unauthorized", zh).message, /凭证/);
	assert.match(explain("HTTP 429 Too Many Requests", zh).message, /限流/);
});

test("跟着界面语言", () => {
	assert.equal(explain("HTTP 429", (key) => translateIn("en", key)).message, "Too many requests — you are being rate limited");
});

test("认不出的原样放过去", () => {
	const odd = "Something nobody has seen before (code 7)";
	assert.equal(explain(odd, zh).message, odd);
	assert.equal(explain(odd, zh).hint, undefined);
});
