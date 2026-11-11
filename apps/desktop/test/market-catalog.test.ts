import assert from "node:assert/strict";
import test from "node:test";
import type { InstalledPlugin, MarketEntry } from "../src/shared/market.ts";
import { merge, UNFILED } from "../src/renderer/market/catalog.ts";

const entry: MarketEntry = {
	id: "example",
	kind: "plugin",
	name: "市场名称",
	description: "市场说明",
	version: "1.1.0",
	logo: "data:image/png;base64,bWFya2V0",
	category: "开发",
};
const installed: InstalledPlugin = {
	id: "example",
	kind: "plugin",
	name: "本机名称",
	description: "本机说明",
	version: "1.0.0",
	hash: "old",
	dir: "/plugins/example",
	source: "market",
};

test("已装图标优先，保留本机说明和市场更新判断", () => {
	const plugin = { ...installed, logo: "data:image/png;base64,bG9jYWw=", category: "本机" };
	const [item] = merge([entry], [plugin], [], ["example"]);
	assert.equal(item.logo, plugin.logo);
	assert.equal(item.name, plugin.name);
	assert.equal(item.description, plugin.description);
	assert.equal(item.category, plugin.category);
	assert.equal(item.entry, entry);
	assert.equal(item.installed, plugin);
	assert.equal(item.outdated, true);
});

test("本机缺图标时用市场补齐，不覆盖其他已有字段", () => {
	const [item] = merge([entry], [installed], []);
	assert.equal(item.logo, entry.logo);
	assert.equal(item.name, installed.name);
	assert.equal(item.description, installed.description);
	assert.equal(item.category, entry.category);
	assert.equal(item.outdated, false);
	assert.equal(installed.logo, undefined);
});

test("只有市场、只有本机和完全无图标的条目都能合并", () => {
	assert.equal(merge([entry], [], [])[0].logo, entry.logo);
	const local = { ...installed, source: "upload" as const, logo: "data:image/png;base64,bG9jYWw=" };
	const [item] = merge([entry], [local], [], ["example"]);
	assert.equal(item.logo, local.logo);
	assert.equal(item.outdated, false);
	const [withoutMarket] = merge([], [installed], []);
	assert.equal(withoutMarket.logo, undefined);
	assert.equal(withoutMarket.category, UNFILED);
	assert.equal(withoutMarket.outdated, false);
	assert.equal(merge([], [local], [])[0].logo, local.logo);
});
