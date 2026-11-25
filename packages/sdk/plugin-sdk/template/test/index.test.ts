/**
 * 逻辑入口的测试：`plume-plugin check`（或 `plume-plugin test`）用 Node 自带的 node:test 跑，不用装测试框架。
 * loadPlugin 用假的 ctx 跑插件的 apply，再直接跑它注册的工具、钩子；写法见 skill plume-plugin 的「测试」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPlugin } from "@plumeai/plugin-sdk/testing";
import plugin from "../src/index.ts";

test("__TOOL__ 按名字问好，details 交给卡片", async () => {
	const loaded = await loadPlugin(plugin);
	const result = await loaded.runTool("__TOOL__", { name: " Ada " });
	assert.equal(result.output, "Hello, Ada!");
	assert.deepEqual(result.details, { name: "Ada" });
	await loaded.dispose();
});

test("__TOOL__ 没给名字时以出错结束", async () => {
	const loaded = await loadPlugin(plugin);
	const result = await loaded.runTool("__TOOL__", {});
	assert.equal(result.isError, true);
	await loaded.dispose();
});
