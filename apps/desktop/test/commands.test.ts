import assert from "node:assert/strict";
import { test } from "vitest";
import { commandCompletion, commandDecorations, menuCommands, parseInvocation, resolveCommand, type MenuCommand } from "../src/renderer/composer/commands.ts";

const ENTRIES: MenuCommand[] = [
	{ name: "clear", description: "开新对话", action: "clear" },
	{ name: "git:commit", description: "提交改动", argumentHint: "<说明>", plugin: "plume.commands" },
	{ name: "commit", description: "提交技能", trigger: "$", plugin: "plume.skills" },
	{ name: "plume-plugin", description: "写插件", trigger: "$", plugin: "plume.skills" },
	{ name: "pdf", description: "处理 PDF", trigger: "$", plugin: "plume.skills" },
];

test("解析与匹配按触发符分开：/ 是命令，$ 是技能，同名互不遮蔽", () => {
	assert.deepEqual(parseInvocation("/clear"), { trigger: "/", name: "clear", rest: "" });
	assert.deepEqual(parseInvocation("$pdf 填表"), { trigger: "$", name: "pdf", rest: "填表" });
	assert.deepEqual(parseInvocation("@compact 保留接口"), { trigger: "/", name: "compact", rest: "保留接口" });
	assert.equal(parseInvocation("普通消息"), null);

	assert.equal(resolveCommand(ENTRIES, "commit", "/")?.name, "git:commit");
	assert.equal(resolveCommand(ENTRIES, "commit", "$")?.name, "commit");
	assert.equal(resolveCommand(ENTRIES, "clear", "$"), undefined);
	assert.equal(resolveCommand(ENTRIES, "pdf", "/"), undefined);

	const merged = menuCommands(
		[{ name: "clear", description: "内置", action: "clear" }],
		[
			{ name: "clear", description: "同名命令被盖住", plugin: "a" },
			{ name: "clear", description: "同名技能留着", trigger: "$", plugin: "b" },
		],
	);
	assert.deepEqual(
		merged.map((item) => `${item.trigger ?? "/"}${item.name}`),
		["/clear", "$clear"],
	);
});

test("补全分别在 / 和 $ 后触发，反引号行内代码里不触发", () => {
	assert.deepEqual(commandCompletion("/cl", 3, 3), { trigger: "/", term: "cl", start: 0, end: 3 });
	assert.deepEqual(commandCompletion("帮我用 $pl", 7, 7), { trigger: "$", term: "pl", start: 4, end: 7 });
	assert.deepEqual(commandCompletion("$", 1, 1), { trigger: "$", term: "", start: 0, end: 1 });
	assert.equal(commandCompletion("`$pdf", 5, 5), null);
	assert.equal(commandCompletion("price$pdf", 9, 9), null);
});

test("高亮：行首 / 命令和行首或句中的 $ 技能高亮，代码和未知 $ 不高亮", () => {
	assert.deepEqual(commandDecorations("/git:commit", ENTRIES), [{ start: 0, end: 11, hint: "<说明>" }]);
	assert.deepEqual(commandDecorations("$plume-plugin 写个插件", ENTRIES), [{ start: 0, end: 13 }]);
	assert.deepEqual(commandDecorations("用 $pdf 和 $commit 处理，忽略 $100 和 `$pdf`", ENTRIES), [
		{ start: 2, end: 6 },
		{ start: 9, end: 16 },
	]);
	assert.deepEqual(commandDecorations("路径 /clear 不高亮", ENTRIES), []);
	assert.deepEqual(commandDecorations("```\n$pdf\n```", ENTRIES), []);
});
