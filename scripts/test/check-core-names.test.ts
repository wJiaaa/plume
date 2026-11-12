import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { nameProblems, scanCode, scanText } from "../check-core-names.mjs";

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

test("全小写的单个词不在比较里时不算，名单外的名字不算", () => {
	const code = [
		'export type PluginKind = "plugin" | "skill" | "connector";',
		'const row = { kind: "task", label: t("monitor") };',
		'if (block.name === "bash") return;',
		'const words = "task list";',
		'const SNAKE = "todo_writer";',
		'const prose = "a `tasks` list, `skill-set` and task`";',
	].join("\n");
	assert.deepEqual(found(code), []);
});

test("提示词里用反引号点名的工具算，全小写的单个词也算", () => {
	assert.deepEqual(found('const line = "How it differs from a sub-agent (`task`): ...";'), ["name task"]);
	assert.deepEqual(found("const note = `先用 \\`skill\\` 载入`;"), ["name skill"]);
});

test("写给模型的 Markdown：插件名、带下划线的名字出现就算，全小写的单个词在反引号里才算", () => {
	const text = [
		"Ask the user with `ask_user`.",
		"Use the task list (plume.side-chat keeps its own).",
		"Dispatch it with `task`.",
		"Read with todo_write.",
	].join("\n");
	const hits = scanText(text, { plugins: lists.plugins, names: new Set([...lists.names, "ask_user"]) }).map(
		({ line, kind, name }: { line: number; kind: string; name: string }) => `${line} ${kind} ${name}`,
	);
	assert.deepEqual(hits.sort(), ["1 name ask_user", "2 plugin plume.side-chat", "3 name task", "4 name todo_write"]);
});

test("内置插件里点名别的内置插件、它的工具算；自己的、注释里的不算", () => {
	const root = mkdtempSync(join(tmpdir(), "plume-names-"));
	try {
		const plugin = (dir: string, files: Record<string, string>) => {
			mkdirSync(join(root, "packages/builtin", dir, "src"), { recursive: true });
			writeFileSync(join(root, "packages/builtin", dir, "package.json"), "{}");
			for (const [file, text] of Object.entries(files)) {
				mkdirSync(dirname(join(root, "packages/builtin", dir, file)), { recursive: true });
				writeFileSync(join(root, "packages/builtin", dir, file), text);
			}
		};
		plugin("todo", { "src/index.ts": 'export default { name: "plume.todo", apply(ctx) { ctx.tools.register({ name: "todo_write" }); } };' });
		plugin("plan", {
			"src/index.ts": [
				'export default { name: "plume.plan" };',
				"// 清单由 plume.todo 的 todo_write 记。",
				'const hasTodo = tools.some((tool) => tool.name === "todo_write");',
				'const panel = "plume.todo/list";',
			].join("\n"),
			"skills/plan/SKILL.md": "Track the steps with `todo_write`.",
		});
		const problems = nameProblems(root)
			.filter(({ file }: { file: string }) => file.includes("packages/builtin/") && file.endsWith("index.ts"))
			.map(({ file, message }: { file: string; message: string }) => `${relative(root, file)} ${message.split("：")[0]}`);
		assert.deepEqual(problems.sort(), [
			"packages/builtin/plan/src/index.ts 第 3 行按名字认了别的插件的 todo_write",
			"packages/builtin/plan/src/index.ts 第 4 行认了插件 plume.todo",
		]);
		// 临时根下没有 ALLOWED 里登记的那些文件（浏览器的技能也在其中），它们报的「例外过时」不算。
		const skill = nameProblems(root).filter(
			({ file, message }: { file: string; message: string }) => file.endsWith("SKILL.md") && !message.startsWith("例外过时"),
		);
		assert.equal(skill.length, 1);
		assert.match(skill[0].message, /todo_write/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
