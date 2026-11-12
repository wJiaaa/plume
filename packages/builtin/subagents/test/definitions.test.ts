import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { BUILTIN_AGENTS, builtinAgents } from "../src/agents.ts";
import { AgentDefinitions, parseAgent, renderAgent } from "../src/definitions.ts";
import { MESSAGES } from "../src/messages.ts";

const text = MESSAGES.en;
const TOOLS = ["read", "grep", "bash"];

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "plume-agent-defs-"));
	const home = join(root, "home");
	const project = join(root, "project");
	mkdirSync(project);
	mkdirSync(join(root, ".Trash"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (dir: string, file: string, raw: string) => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, file), raw);
	};
	return {
		root,
		home,
		project,
		// 系统废纸篓由宿主给（`ctx.trash`）；这里移进临时目录里的 `.Trash`，不碰真的废纸篓。
		definitions: new AgentDefinitions(
			home,
			() => text,
			async (path) => renameSync(path, join(root, ".Trash", basename(path))),
		),
		user: (file: string, raw: string) => write(join(home, "agents"), file, raw),
		local: (file: string, raw: string) => write(join(project, ".plume", "agents"), file, raw),
	};
}

test("parseAgent 读常见的几种 frontmatter 写法；没写 tools 的是全部工具，没写名字的用文件名", () => {
	const block = parseAgent(
		"---\nname: reviewer\ndescription: >\n  Reviews\n  diffs\ntools:\n  - read\n  - \"grep\"\nmodel: 'p/m'\navatar: cloud-violet\n---\nBe strict.\n",
		"/x/reviewer.md",
		"user",
	);
	assert.deepEqual(block, {
		name: "reviewer",
		description: "Reviews diffs",
		prompt: "Be strict.",
		tools: ["read", "grep"],
		model: "p/m",
		avatar: "cloud-violet",
		source: "user",
	});
	const flow = parseAgent('---\ndescription: "Finds: things"\ntools: [read, bash]\n---\nGo', "/x/finder.md", "workspace");
	assert.deepEqual(flow, { name: "finder", description: "Finds: things", prompt: "Go", tools: ["read", "bash"], source: "workspace" });
	assert.equal(parseAgent("Just a prompt", "/x/plain.md", "user")?.tools, "*");
});

test("parseAgent 读出嵌套的 output 结构和 schemaMode；读不出对象的 output 当没写", () => {
	const agent = parseAgent(
		"---\nname: checker\noutput:\n  type: object\n  required: [passed]\n  properties:\n    passed: { type: boolean }\n    failures:\n      type: array\n      items:\n        type: object\nschema-mode: strict\nschemaMode: permissive\ntools: [read]\n---\nCheck",
		"/x/checker.md",
		"user",
	);
	assert.deepEqual(agent?.output, {
		type: "object",
		required: ["passed"],
		properties: { passed: { type: "boolean" }, failures: { type: "array", items: { type: "object" } } },
	});
	assert.equal(agent?.schemaMode, "strict");
	assert.deepEqual(agent?.tools, ["read"]);
	const broken = parseAgent("---\nname: x\noutput: just text\nschemaMode: loose\n---\nGo", "/x/x.md", "user");
	assert.equal(broken?.output, undefined);
	assert.equal(broken?.schemaMode, undefined);
});

test("renderAgent 只换表单管的几个键，别的行原样留着；改内置的带上内置的模型和脸", () => {
	const draft = { name: "reviewer", description: "Reviews: diffs", prompt: "New prompt", tools: ["read"] };
	const raw = '---\nname: reviewer\ncolor: red # keep\ntools: "*"\n---\nOld prompt\n';
	assert.equal(
		renderAgent(draft, raw, undefined, text),
		'---\nname: reviewer\ncolor: red # keep\ntools: [read]\ndescription: "Reviews: diffs"\n---\nNew prompt\n',
	);
	const builtin = parseAgent("---\nname: explore\nmodel: p/m\navatar: drop-green\n---\nx", "/x/explore.md", "builtin")!;
	assert.equal(
		renderAgent({ ...draft, name: "explore", tools: "*" }, undefined, builtin, text),
		'---\nmodel: p/m\navatar: drop-green\nname: explore\ndescription: "Reviews: diffs"\ntools: "*"\n---\nNew prompt\n',
	);
	assert.throws(() => renderAgent(draft, "no front matter", undefined, text), new RegExp(text.defBadFront));
});

test("名单按项目 > 个人 > 内置取同名的那一份，改过的内置标出来", async (t) => {
	const f = fixture(t);
	f.user("explore.md", "---\nname: explore\ndescription: Mine\n---\nmine");
	f.user("helper.md", "---\nname: helper\ndescription: User helper\n---\nuser");
	f.local("helper.md", "---\nname: helper\ndescription: Project helper\n---\nproject");
	const personal = await f.definitions.list(null);
	const explore = personal.find((record) => record.definition.name === "explore")!;
	assert.equal(explore.scope, "user");
	assert.equal(explore.customized, true);
	assert.equal(personal.find((record) => record.definition.name === "helper")?.definition.description, "User helper");
	assert.equal(personal.find((record) => record.definition.name === "general")?.scope, "builtin");
	const scoped = await f.definitions.list(f.project);
	const helper = scoped.find((record) => record.definition.name === "helper")!;
	assert.equal(helper.scope, "project");
	assert.equal(helper.definition.source, "workspace");
	assert.equal(helper.definition.description, "Project helper");
});

test("新建、编辑、改内置、删除都落在文件上；过期的修订和重名都拒绝", async (t) => {
	const f = fixture(t);
	const draft = { name: "helper", description: "Helps", prompt: "Help out", tools: ["read"] as string[] | "*", avatar: "cloud-violet" };
	await f.definitions.save(f.project, { scope: "project", draft }, TOOLS);
	const file = join(f.project, ".plume", "agents", "helper.md");
	assert.match(readFileSync(file, "utf8"), /^---\nname: helper\ndescription: Helps\ntools: \[read\]\navatar: cloud-violet\n---\nHelp out\n$/);
	await assert.rejects(f.definitions.save(f.project, { scope: "user", draft }, TOOLS), new RegExp(text.defNameTaken));
	await assert.rejects(f.definitions.save(null, { scope: "user", draft: { ...draft, name: "Bad Name" } }, TOOLS), new RegExp(text.defBadName));
	await assert.rejects(
		f.definitions.save(null, { scope: "user", draft: { ...draft, name: "other", tools: ["nope"] } }, TOOLS),
		new RegExp(text.defUnknownTool.replace(".", "\\.")),
	);

	const record = (await f.definitions.list(f.project)).find((entry) => entry.definition.name === "helper")!;
	await f.definitions.save(f.project, { id: record.id, revision: record.revision, scope: "project", draft: { ...draft, prompt: "Edited" } }, TOOLS);
	assert.match(readFileSync(file, "utf8"), /Edited\n$/);
	await assert.rejects(
		f.definitions.save(f.project, { id: record.id, revision: record.revision, scope: "project", draft }, TOOLS),
		new RegExp(text.defModified),
	);

	// 改内置的：存成个人的一份，内置的模型和脸跟着走。
	const explore = (await f.definitions.list(null)).find((entry) => entry.definition.name === "explore")!;
	await f.definitions.save(null, { id: explore.id, revision: explore.revision, scope: "project", draft: { ...draft, name: "explore", tools: "*" } }, TOOLS);
	const custom = (await f.definitions.list(null)).find((entry) => entry.definition.name === "explore")!;
	assert.equal(custom.scope, "user");
	assert.equal(custom.customized, true);
	assert.equal(custom.definition.avatar, "cloud-violet");
	// 输出结构也跟着走：改了一句指令，它还是交回原来那种对象。
	assert.deepEqual(custom.definition.output, BUILTIN_AGENTS.find((agent) => agent.name === "explore")!.output);

	// 删除：文件进废纸篓，名单回到内置那一份；内置的删不了。
	await f.definitions.remove(null, custom.id, custom.revision);
	assert.equal(existsSync(join(f.home, "agents", "explore.md")), false);
	assert.deepEqual(readdirSync(join(f.root, ".Trash")), ["explore.md"]);
	const restored = (await f.definitions.list(null)).find((entry) => entry.definition.name === "explore")!;
	assert.equal(restored.scope, "builtin");
	await assert.rejects(f.definitions.remove(null, restored.id, restored.revision), new RegExp(text.defCannotRemove));
});

test("内置的几种按工具声明的种类挑工具，不点名：名字跟着工具表走，没有那种活的就少一样", () => {
	const tools = (names: Record<string, string>) => Object.entries(names).map(([name, kind]) => ({ name, plugin: "example.files", kind: kind as "view" }));
	const toolsOf = (table: ReturnType<typeof tools>) => Object.fromEntries(builtinAgents(table).map((agent) => [agent.name, agent.tools]));
	const basic = tools({
		read: "view",
		write: "create",
		edit: "modify",
		ls: "list",
		glob: "find",
		grep: "search",
		bash: "command",
		bash_output: "job",
		monitor: "watch",
	});
	assert.deepEqual(toolsOf(basic), {
		general: "*",
		explore: ["read", "glob", "grep", "ls", "bash", "bash_output"],
		review: ["read", "glob", "grep", "ls", "bash", "bash_output"],
		verify: ["read", "bash", "bash_output"],
		plan: ["read", "glob", "grep", "ls"],
		"plan-review": ["read", "glob", "grep", "ls", "bash"],
		simple: "*",
		reason: "*",
	});
	// 换一个插件提供读文件、跑命令：名字跟着它走；没有按名字找文件的，那一样就没有。
	const other = toolsOf(tools({ open_file: "view", rg: "search", sh: "command" }));
	assert.deepEqual(other.explore, ["open_file", "rg", "sh"]);
	assert.deepEqual(other.plan, ["open_file", "rg"]);
});
