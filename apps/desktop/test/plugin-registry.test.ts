import assert from "node:assert/strict";
import test from "node:test";
import { createPluginRegistry } from "../src/renderer/plugin-registry.ts";

test("槽位：按 order 稳定排序，order 相同的保持放入先后；同 key 再放换掉旧的、排到同 order 的最后", () => {
	const slot = createPluginRegistry().slot<string>();
	slot.put("a", "a/1", { key: "a/1", order: 1 });
	slot.put("b", "b/0", { key: "b/0" });
	slot.put("c", "c/1", { key: "c/1", order: 1 });
	slot.put("a", "a/-1", { key: "a/-1", order: -1 });
	assert.deepEqual(slot.list(), ["a/-1", "b/0", "a/1", "c/1"]);
	slot.put("a", "a/1 again", { key: "a/1", order: 1 });
	assert.deepEqual(slot.list(), ["a/-1", "b/0", "c/1", "a/1 again"]);
	assert.equal(slot.has("a/1"), true);
	assert.equal(slot.has("a/2"), false);
});

test("槽位：不给 key 时一个插件一项，再放换掉自己的、排到最后", () => {
	const slot = createPluginRegistry().slot<string>();
	slot.put("a", "a1");
	slot.put("b", "b1");
	slot.put("a", "a2");
	assert.deepEqual(slot.list(), ["b1", "a2"]);
});

test("槽位：按插件撤；每次放入、撤销都换成新数组，没撤掉什么也换", () => {
	const registry = createPluginRegistry();
	const slot = registry.slot<string>();
	slot.put("a", "a/x", { key: "a/x" });
	slot.put("b", "b/x", { key: "b/x" });
	slot.put("a", "a/y", { key: "a/y" });
	const before = slot.list();
	registry.removePlugin("a");
	assert.deepEqual(slot.list(), ["b/x"]);
	assert.notEqual(slot.list(), before);
	const kept = slot.list();
	registry.removePlugin("nobody");
	assert.deepEqual(slot.list(), ["b/x"]);
	assert.notEqual(slot.list(), kept);
	assert.equal(slot.list(), slot.list());
});

test("接手者：order 小的在前，相同时后登记的在前；按插件撤，名字空了就拿掉", () => {
	const registry = createPluginRegistry();
	const handlers = registry.handlers<{ plugin: string; order: number; seq: number }>();
	const first = { plugin: "a", order: 0, seq: 0 };
	const later = { plugin: "b", order: 0, seq: 1 };
	const low = { plugin: "c", order: -1, seq: 2 };
	const high = { plugin: "a", order: 5, seq: 3 };
	handlers.register("read", first);
	handlers.register("read", later);
	handlers.register("read", low);
	handlers.register("read", high);
	handlers.register("edit", { plugin: "a", order: 0, seq: 4 });
	assert.deepEqual(handlers.get("read"), [low, later, first, high]);
	registry.removePlugin("a");
	assert.deepEqual(handlers.get("read"), [low, later]);
	assert.equal(handlers.get("edit"), undefined);
	assert.deepEqual([...handlers.table.keys()], ["read"]);
});

test("接手者：delete 拿掉整个名字，再登记排到 table 的最后", () => {
	const handlers = createPluginRegistry().handlers<{ plugin: string; order: number; seq: number }>();
	handlers.register("a/x", { plugin: "a", order: 0, seq: 0 });
	handlers.register("b/x", { plugin: "b", order: 0, seq: 1 });
	const again = { plugin: "a", order: 0, seq: 2 };
	handlers.delete("a/x");
	handlers.register("a/x", again);
	assert.deepEqual([...handlers.table.keys()], ["b/x", "a/x"]);
	assert.deepEqual(handlers.get("a/x"), [again]);
});

test("一组里的槽位和接手者一起撤，不碰别的组", () => {
	const registry = createPluginRegistry();
	const other = createPluginRegistry();
	const slot = registry.slot<string>();
	const handlers = registry.handlers<{ plugin: string; order: number; seq: number }>();
	const outside = other.slot<string>();
	slot.put("a", "a");
	handlers.register("read", { plugin: "a", order: 0, seq: 0 });
	outside.put("a", "a");
	registry.removePlugin("a");
	assert.deepEqual(slot.list(), []);
	assert.equal(handlers.get("read"), undefined);
	assert.deepEqual(outside.list(), ["a"]);
});
