import assert from "node:assert/strict";
import { test } from "node:test";
import { copiedCount } from "../audit-copies.ts";

const CREATED = 1_000_000;
const at = (...timestamps: number[]) => timestamps.map((timestamp) => ({ timestamp }));

test("分叉开头早于创建时刻的那段是抄来的", () => {
	const fork = { createdAt: CREATED, forkedFrom: { sessionId: "a" } };
	assert.equal(copiedCount(fork, at(CREATED - 5000, CREATED - 1000, CREATED + 10, CREATED + 20)), 2);
	assert.equal(copiedCount(fork, at(CREATED - 5000, CREATED - 1000)), 2, "分叉之后还没说过话：全是抄来的");
});

test("不是分叉的会话一条都不去掉", () => {
	assert.equal(copiedCount({ createdAt: CREATED }, at(CREATED - 5000, CREATED + 10)), 0);
});
