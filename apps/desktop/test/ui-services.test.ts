import assert from "node:assert/strict";
import test from "node:test";
import { provideUiService, removeUiServices, uiService } from "../src/renderer/ui-services.ts";

test("界面侧服务：后提供的生效，撤下恢复前一个，没人提供是 undefined", (t) => {
	t.after(() => {
		removeUiServices("example.builtin");
		removeUiServices("example.market");
	});
	const builtin = { open() {} };
	const market = { open() {} };
	assert.equal(uiService("example.view"), undefined);
	provideUiService("example.builtin", "example.view", builtin);
	provideUiService("example.market", "example.view", market);
	assert.equal(uiService("example.view"), market);
	removeUiServices("example.market");
	assert.equal(uiService("example.view"), builtin);
	removeUiServices("example.builtin");
	assert.equal(uiService("example.view"), undefined);
});

test("界面侧服务：同一插件再提供同名的换掉自己前一个并排到最后，别的服务不受影响", (t) => {
	t.after(() => {
		removeUiServices("example.a");
		removeUiServices("example.b");
	});
	const first = { open() {} };
	const second = { open() {} };
	const other = { open() {} };
	const fromB = { open() {} };
	provideUiService("example.a", "example.view", first);
	provideUiService("example.a", "example.other", other);
	provideUiService("example.b", "example.view", fromB);
	provideUiService("example.a", "example.view", second);
	assert.equal(uiService("example.view"), second);
	assert.equal(uiService("example.other"), other);
	removeUiServices("example.a");
	assert.equal(uiService("example.view"), fromB);
	assert.equal(uiService("example.other"), undefined);
});

test("界面侧服务：名字或实现不对时抛错，不登记", () => {
	assert.throws(() => provideUiService("example.a", "", { open() {} }));
	assert.throws(() => provideUiService("example.a", 1, { open() {} }));
	assert.throws(() => provideUiService("example.a", "example.view", null));
	assert.throws(() => provideUiService("example.a", "example.view", "open"));
	assert.equal(uiService("example.view"), undefined);
});
