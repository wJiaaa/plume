import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createSideChatBindings } from "../src/bindings.ts";

async function fixture(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "plume-side-chat-bindings-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sides = new Map<string, { parentId: string; createdAt: number }>();
	const deleted: string[] = [];
	let clock = 0;
	let created = 0;
	const add = (id: string, parentId = "main") => {
		sides.set(id, { parentId, createdAt: ++clock });
		return id;
	};
	const deps = {
		file: join(dir, "tabs.json"),
		parentOf: (id: string) => sides.get(id)?.parentId,
		list: async (parentId: string) =>
			[...sides]
				.filter(([, side]) => side.parentId === parentId)
				.map(([id, side]) => ({ id, title: id, createdAt: side.createdAt }))
				.sort((a, b) => b.createdAt - a.createdAt),
		open: async (parentId: string) => add(`created-${++created}`, parentId),
		close: async (id: string) => {
			deleted.push(id);
			sides.delete(id);
		},
		missing: () => new Error("missing"),
	};
	return { deps, sides, add, deleted, created: () => created };
}

test("跨 renderer 并发认领不抢同一段，反序恢复仍按 tab 接回原记录", async (t) => {
	const f = await fixture(t);
	f.add("older");
	f.add("newer");
	f.add("another-parent", "other");
	const bindings = await createSideChatBindings(f.deps);
	assert.deepEqual(await Promise.all([bindings.bind("tab-a", "main"), bindings.bind("tab-b", "main"), bindings.bind("tab-a", "main")]), [
		"newer",
		"older",
		"newer",
	]);
	f.add("newest-unbound");
	const restored = await createSideChatBindings(f.deps);
	assert.equal(await restored.bind("tab-b", "main"), "older");
	assert.equal(await restored.open("tab-a", "main"), "newer");
	assert.equal(f.created(), 0);
	assert.deepEqual(JSON.parse(await readFile(f.deps.file, "utf8")), { "tab-a": "newer", "tab-b": "older" });
});

test("空标签也持久保留空白，恢复时不抢后来 /btw 开出的会话", async (t) => {
	const f = await fixture(t);
	const bindings = await createSideChatBindings(f.deps);
	assert.equal(await bindings.bind("empty-tab", "main"), undefined);
	f.add("btw");
	const restored = await createSideChatBindings(f.deps);
	assert.equal(await restored.bind("empty-tab", "main"), undefined);
	assert.equal(await restored.bind("btw-tab", "main"), "btw");
	assert.deepEqual(await Promise.all([restored.open("empty-tab", "main"), restored.open("empty-tab", "main")]), ["created-1", "created-1"]);
	assert.equal(f.created(), 1);
});

test("异步新建中的重复挂载只新建一次，关闭等绑定落地再删，迟到的 open 不复活", async (t) => {
	const f = await fixture(t);
	const create = f.deps.open;
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started = () => {};
	const starting = new Promise<void>((resolve) => {
		started = resolve;
	});
	f.deps.open = async (parentId) => {
		started();
		await gate;
		return create(parentId);
	};
	const bindings = await createSideChatBindings(f.deps);
	const first = bindings.open("tab", "main");
	const duplicate = bindings.open("tab", "main");
	await starting;
	const closing = bindings.close("tab");
	release();
	assert.deepEqual(await Promise.all([first, duplicate]), ["created-1", "created-1"]);
	await closing;
	assert.equal(f.created(), 1);
	assert.deepEqual(f.deleted, ["created-1"]);
	assert.deepEqual(JSON.parse(await readFile(f.deps.file, "utf8")), {});
	await assert.rejects(bindings.open("tab", "main"), /missing/);
	await assert.rejects(bindings.bind("tab", "main"), /missing/);
});

test("绑定不能串到另一主会话，原来的子会话缺失时也不能偷偷认领另一段", async (t) => {
	const f = await fixture(t);
	f.add("original");
	const bindings = await createSideChatBindings(f.deps);
	assert.equal(await bindings.bind("tab", "main"), "original");
	await assert.rejects(bindings.open("tab", "other"), /missing/);
	f.sides.delete("original");
	f.add("unrelated");
	const restored = await createSideChatBindings(f.deps);
	await assert.rejects(restored.bind("tab", "main"), /missing/);
	assert.equal(f.created(), 0);
	await restored.forget("original");
	assert.equal(await restored.bind("tab", "main"), undefined);
	assert.deepEqual(JSON.parse(await readFile(f.deps.file, "utf8")), { tab: null });
});

test("绑定文件损坏时明确失败，不把已有记录当成无绑定重建", async (t) => {
	const f = await fixture(t);
	await writeFile(f.deps.file, JSON.stringify({ tab: 42 }));
	await assert.rejects(createSideChatBindings(f.deps), /missing/);
	assert.equal(f.created(), 0);
});

test("最早那段所在的标签：没接上标签的、别的会话的、关掉的都不算", async (t) => {
	const f = await fixture(t);
	f.add("unbound-oldest");
	f.add("older");
	f.add("newer");
	f.add("elsewhere", "other");
	const bindings = await createSideChatBindings(f.deps);
	assert.equal(await bindings.first("main"), undefined);
	assert.equal(await bindings.bind("tab-new", "main"), "newer");
	assert.equal(await bindings.bind("tab-old", "main"), "older");
	assert.equal(await bindings.bind("tab-other", "other"), "elsewhere");
	assert.equal(await bindings.first("main"), "tab-old");
	await bindings.close("tab-old");
	assert.equal(await bindings.first("main"), "tab-new");
});
