import assert from "node:assert/strict";
import { test } from "node:test";
import { queueMove } from "../src/renderer/composer/queue-move.ts";

test("排队条挪位置只数还排着的那几条，正在收起的那一行不当落点", () => {
	const rows = [
		{ entry: { id: "a" }, leaving: false },
		{ entry: { id: "gone" }, leaving: true },
		{ entry: { id: "c" }, leaving: false },
	];
	assert.deepEqual(queueMove(rows, 0, 1), { id: "a", targetId: "c", placement: "after" });
	assert.deepEqual(queueMove(rows, 1, 0), { id: "c", targetId: "a", placement: "before" });
	assert.equal(queueMove(rows, 1, 2), null);
	assert.equal(queueMove(rows, 0, 0), null);
});
