/**
 * 第 13 节「用户把话再说一遍」：压缩后提到之前说过，或者折叠掉的原话又出现了，才算；保留在尾部、模型还看得见的那些不算，
 * 「继续」这种短话也不算。第 14 节只数前缀有理由命中的请求。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../packages/contract/src/index.ts";
import { emptyUsage } from "../../packages/core/llm/src/types.ts";
import { afterCompaction, type AuditStream, cacheLifetime, LIFETIME_BUCKETS, restates } from "../audit-compaction.ts";

const user = (text: string, synthetic = false): Message => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: 1,
	...(synthetic ? { synthetic: true } : {}),
});
const said = (text: string): Message => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "p",
	model: "m",
	usage: emptyUsage(),
	stopReason: "stop",
	timestamp: 1,
});

const stream = (messages: Message[], at: number, kept: number): AuditStream => ({ messages, calls: [], boundaries: [{ at, kept }], resultTokens: () => 0 });

test("折叠掉的话压缩后又说了一遍算；还留在尾部的不算", () => {
	const messages = [
		user("改完以后不要推送到远端分支，等我先看过"),
		said("好的"),
		user("只改 packages/core 里面的代码，桌面端不要动"),
		said("明白"),
		// 边界：之前 4 条，保留最后 2 条（第 3、4 条）。
		user("记得：改完以后不要推送到远端分支，等我先看过"),
		user("只改 packages/core 里面的代码，桌面端不要碰"),
		user("我之前说过要先跑测试"),
		user("继续"),
		user("<env>今天是 2026-11-04</env>", true),
	];
	const result = afterCompaction([stream(messages, 4, 2)]);
	assert.equal(result.userAfter, 4, "synthetic 的不是人说的话");
	assert.equal(result.repeatedAfter, 2, "折叠掉的那句重说了一遍，加上明说「之前说过」的那句");
});

test("重说要真的重合，也要够长", () => {
	assert.ok(restates("不要推送到远端分支，等我先看过", "改完以后不要推送到远端分支，等我先看过"));
	assert.ok(!restates("继续", "继续"), "短回复本来就会反复说");
	assert.ok(!restates("帮我看一下登录页为什么白屏了", "改完以后不要推送到远端分支，等我先看过"));
});

test("缓存寿命只数命中、服务商没读到和说不清的；太短的前缀和有意改写不算", () => {
	const cells = cacheLifetime([
		{ model: "m", idleMs: 30_000, expected: 50_000, cause: "hit" },
		{ model: "m", idleMs: 30_000, expected: 50_000, cause: "provider" },
		{ model: "m", idleMs: 2 * 3_600_000, expected: 50_000, cause: "unknown" },
		{ model: "m", idleMs: 30_000, expected: 500, cause: "provider" },
		{ model: "m", idleMs: 30_000, expected: 50_000, cause: "compaction" },
	]).get("m")!;
	assert.deepEqual(cells[0], { hit: 1, lost: 1, unproven: 0 });
	assert.deepEqual(cells[LIFETIME_BUCKETS.length - 1], { hit: 0, lost: 0, unproven: 1 });
});
