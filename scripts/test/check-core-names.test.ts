import assert from "node:assert/strict";
import { test } from "node:test";
import { scanCode } from "../check-core-names.mjs";

const lists = {
	plugins: new Set(["plume.side-chat", "plume.terminal", "plume.git"]),
	names: new Set(["task", "monitor", "skill", "todo_write", "mcp__", "projectMemory", "subagent_result"]),
};
const found = (code: string) => scanCode(code, lists).map(({ kind, name }: { kind: string; name: string }) => `${kind} ${name}`);

test("本体代码里的插件名报出来，以插件名打头的面板 id 也算", () => {
	assert.deepEqual(found('if (child.owner === "plume.side-chat") return;'), ["plugin plume.side-chat"]);
	assert.deepEqual(found("const panel = '[data-panel=\"plume.terminal/terminal\"]';"), ["plugin plume.terminal"]);
	assert.deepEqual(found("const id = `plume.git/${tab}`;"), ["plugin plume.git"]);
});

test("注释、同前缀的 localStorage 键、window.plume 上的方法不算插件名", () => {
	const code = [
		"/** 插件名（`plume.side-chat`）→ 显示名。 */",
		"// plume.terminal 的面板",
		'const KEY = "plume.sidebar.collapsed";',
		'const TABS = "plume.panel-tabs";',
		"void window.plume.git?.open();",
		'const other = "plume.git-extra";',
	].join("\n");
	assert.deepEqual(found(code), []);
});

test("按名字比较、switch、集合里的工具名报出来，带行号", () => {
	assert.deepEqual(
		scanCode('switch (name) {\n\tcase "task":\n\t\treturn 1;\n}', lists).map(({ line, name }: { line: number; name: string }) => [line, name]),
		[[2, "task"]],
	);
	assert.deepEqual(found('if (block.name === "monitor") return;'), ["name monitor"]);
	assert.deepEqual(found('if ("skill" !== call.name) return;'), ["name skill"]);
	assert.deepEqual(found('const DESCRIBED = new Set(["grep", "monitor"]);'), ["name monitor"]);
	assert.deepEqual(found('return name.startsWith("mcp__");'), ["name mcp__"]);
});

test("带下划线、大写字母的名字出现在哪个字面量里都算", () => {
	assert.deepEqual(found('const TODO = "todo_write";'), ["name todo_write"]);
	assert.deepEqual(found('const MEMORY = ["projectInstructions", "projectMemory"];'), ["name projectMemory"]);
	assert.deepEqual(found('const tag = `<subagent_result id="${id}">`;'), ["name subagent_result"]);
	assert.deepEqual(found("const tool = `mcp__${server}__${name}`;"), ["name mcp__"]);
});

test("全小写的单个词不在比较里时不算，名单外的基本工具不算", () => {
	const code = [
		'export type PluginKind = "plugin" | "skill" | "connector";',
		'const row = { kind: "task", label: t("monitor") };',
		'if (block.name === "bash") return;',
		'const words = "task list";',
		'const SNAKE = "todo_writer";',
	].join("\n");
	assert.deepEqual(found(code), []);
});
