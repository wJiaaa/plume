import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expandTemplate, splitArguments } from "../src/expand.ts";
import type { CommandProvider, PluginContext } from "@plume/contract";
import type { CommandsApi } from "../src/api.ts";
import plugin from "../src/index.ts";
import { loadCommands, parseFrontmatter } from "../src/loader.ts";

test("frontmatter：单行、带引号、多行块；没闭合时整个文件当正文", () => {
	const parsed = parseFrontmatter('---\ndescription: "审一遍"\nargument-hint: <file>\nnotes: |\n  第一行\n  第二行\n---\n\n正文\n');
	assert.deepEqual(parsed.frontmatter, { description: "审一遍", "argument-hint": "<file>", notes: "第一行\n第二行" });
	assert.equal(parsed.body, "正文\n");
	assert.deepEqual(parseFrontmatter("---\ndescription: x\n正文"), { frontmatter: {}, body: "---\ndescription: x\n正文", unclosed: true });
});

test("读目录：子目录是命名空间，同名时先出现的赢，坏名字报出来", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-commands-test-"));
	try {
		const first = join(root, "first");
		const second = join(root, "second");
		await mkdir(join(first, "git"), { recursive: true });
		await mkdir(second, { recursive: true });
		await writeFile(join(first, "git", "commit.md"), "---\ndescription: 提交\n---\n写提交说明");
		await writeFile(join(first, "review.md"), "# 审一遍改动\n\n$ARGUMENTS");
		await writeFile(join(second, "review.md"), "被遮蔽的");
		await writeFile(join(second, "Bad Name.md"), "x");
		const { commands, diagnostics } = await loadCommands([
			{ dir: first, scope: "workspace", origin: "plume" },
			{ dir: second, scope: "user", origin: "plume" },
		]);
		assert.deepEqual(
			commands.map((command) => [command.name, command.description]),
			[
				["git:commit", "提交"],
				["review", "审一遍改动"],
			],
		);
		assert.deepEqual(diagnostics.map((item) => item.problem).sort(), ["badName", "shadowed"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("展开：$ARGUMENTS 取原文，$1 取第一个参数，没有占位符时接在末尾", () => {
	assert.deepEqual(splitArguments(`a "b c" 'd'`), ["a", "b c", "d"]);
	assert.equal(expandTemplate("看 $1 和 $2，全部是 $ARGUMENTS", `x "y z"`), `看 x 和 y z，全部是 x "y z"`);
	// 插进去的参数里的 $2 不会再被换一次。
	assert.equal(expandTemplate("$1 / $2", "$2 b"), "$2 / b");
	assert.equal(expandTemplate("审一遍", "src/a.ts"), "审一遍\n\nsrc/a.ts");
	assert.equal(expandTemplate("审一遍", ""), "审一遍");
});

test("deliver：认 steer、followUp，prompt 等于没写；写错的照默认发并报出来", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-commands-test-"));
	try {
		await writeFile(join(root, "focus.md"), "---\ndeliver: steer\n---\n只看 $ARGUMENTS");
		await writeFile(join(root, "after.md"), "---\ndelivery: followUp\n---\n跑完测试");
		await writeFile(join(root, "plain.md"), "---\ndeliver: prompt\n---\n审一遍");
		await writeFile(join(root, "typo.md"), "---\ndeliver: steering\n---\n纠偏");
		const { commands, diagnostics } = await loadCommands([{ dir: root, scope: "user", origin: "plume" }]);
		assert.deepEqual(
			commands.map((command) => [command.name, command.deliver]),
			[
				["after", "followUp"],
				["focus", "steer"],
				["plain", undefined],
				["typo", undefined],
			],
		);
		assert.deepEqual(
			diagnostics.map((item) => [item.problem, item.detail]),
			[["badDeliver", "steering"]],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("/commands 打开设置里的命令管理，不发消息；带了话不吞；同名的命令文件被它遮住", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "plume-commands-manage-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const prior = { plume: process.env.PLUME_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
	process.env.PLUME_HOME = join(home, "plume");
	process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
	t.after(() => {
		for (const [key, value] of [
			["PLUME_HOME", prior.plume],
			["CLAUDE_CONFIG_DIR", prior.claude],
		] as const)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	});
	await mkdir(join(home, "plume", "commands"), { recursive: true });
	await writeFile(join(home, "plume", "commands", "commands.md"), "自己写的同名命令\n");
	let provider: CommandProvider | undefined;
	plugin.apply({
		locale: () => "zh-CN",
		commands: { provide: (given: CommandProvider) => (provider = given) },
		serve() {},
	} as unknown as PluginContext);
	const listed = await provider!.list({});
	assert.equal(listed[0]?.name, "commands");
	assert.equal(listed[0]?.description, "管理斜杠命令，或新建一个");
	assert.deepEqual(await provider!.expand("commands", "", {}), { handled: true, openSettings: "commands" });
	await assert.rejects(Promise.resolve(provider!.expand("commands", "多余的话", {})), /不接收参数/);
});

test("设置页切到项目：列出项目和个人两层；项目的文件只在看着那个项目时认；没选项目不能建项目命令", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "plume-commands-scope-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const prior = { plume: process.env.PLUME_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
	process.env.PLUME_HOME = join(home, "plume");
	process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
	t.after(() => {
		for (const [key, value] of [
			["PLUME_HOME", prior.plume],
			["CLAUDE_CONFIG_DIR", prior.claude],
		] as const)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	});
	const project = join(home, "repo");
	await mkdir(join(home, "plume", "commands"), { recursive: true });
	await mkdir(join(project, ".plume", "commands"), { recursive: true });
	await writeFile(join(home, "plume", "commands", "mine.md"), "个人的\n");
	await writeFile(join(project, ".plume", "commands", "ours.md"), "项目的\n");
	let api: CommandsApi | undefined;
	const trashed: string[] = [];
	plugin.apply({
		locale: () => "zh-CN",
		commands: { provide() {} },
		serve: (given: CommandsApi) => (api = given),
		trash: async (path: string) => void trashed.push(path),
	} as unknown as PluginContext);

	const personal = await api!.list(null);
	assert.deepEqual(
		personal.commands.map((command) => [command.name, command.scope]),
		[["mine", "user"]],
	);
	assert.equal(personal.projectDir, undefined);
	const scoped = await api!.list(project);
	assert.deepEqual(
		scoped.commands.map((command) => [command.name, command.scope]),
		[
			["mine", "user"],
			["ours", "workspace"],
		],
	);
	assert.equal(scoped.projectDir, join(project, ".plume", "commands"));
	// 不是绝对路径的当没选项目。
	assert.equal((await api!.list("repo")).projectDir, undefined);

	const ours = join(project, ".plume", "commands", "ours.md");
	await assert.rejects(api!.remove(ours, null), /不是一个已经读到的命令文件/);
	await api!.remove(ours, project);
	assert.deepEqual(trashed, [ours]);

	await assert.rejects(api!.create("new-one", "workspace", null), /先在页面顶上切到一个项目/);
	await assert.rejects(api!.reveal("workspace", null), /先在页面顶上切到一个项目/);
});
