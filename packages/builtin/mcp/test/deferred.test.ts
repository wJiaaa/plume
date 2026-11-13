import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeferredSessions } from "../src/deferred.ts";

test("改成按需搜索的会话记进文件：重开（新建一份）还在，删掉的会话一起抹掉", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-deferred-"));
	try {
		const file = join(dir, "data", "deferred-sessions.json");
		const first = new DeferredSessions(file);
		assert.equal(await first.has("a"), false);
		await Promise.all([first.add("a"), first.add("b")]);
		await first.delete("b");

		const reopened = new DeferredSessions(file);
		assert.equal(await reopened.has("a"), true);
		assert.equal(await reopened.has("b"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
