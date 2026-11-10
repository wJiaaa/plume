import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAllowedTools } from "../src/allowed-tools.ts";
import { formatCatalogue, formatInvocation, loadSkills, parseFrontmatter, personalDir, skillSources } from "../src/loader.ts";

const DESCRIPTION = "Fill in PDF forms and extract their text when the user hands you a PDF file.";

test("frontmatter：YAML 读得出来；没闭合时整个文件当正文；YAML 坏了带上解析器的原话", () => {
	const parsed = parseFrontmatter(`---\nname: pdf\ndescription: >\n  ${DESCRIPTION}\nmetadata:\n  version: 2\n---\n\n正文\n`);
	assert.ok(!("invalid" in parsed));
	assert.equal(parsed.frontmatter.name, "pdf");
	assert.equal(parsed.frontmatter.description, `${DESCRIPTION}\n`);
	assert.equal(parsed.body, "正文\n");
	assert.deepEqual(parseFrontmatter("---\ndescription: x\n正文"), { frontmatter: {}, body: "---\ndescription: x\n正文", unclosed: true });
	const broken = parseFrontmatter("---\ndescription: [unclosed\n---\n正文");
	assert.ok("invalid" in broken && broken.invalid.length > 0);
});

test("读目录：名字缺省取目录名，同名时先出现的赢，缺描述、坏名字报出来，描述太短只提醒", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-skills-test-"));
	try {
		const first = join(root, "first");
		const second = join(root, "second");
		const write = async (dir: string, name: string, text: string) => {
			await mkdir(join(dir, name), { recursive: true });
			await writeFile(join(dir, name, "SKILL.md"), text);
		};
		await write(first, "pdf", `---\ndescription: ${DESCRIPTION}\ndisable-model-invocation: true\n---\n用 \${CLAUDE_SKILL_DIR}/fill.py 填表`);
		await write(first, "short", "---\nname: short\ndescription: 太短\n---\n正文");
		await write(second, "pdf", `---\nname: pdf\ndescription: ${DESCRIPTION}\n---\n被遮蔽的`);
		await write(second, "nodesc", "---\nname: nodesc\n---\n正文");
		await write(second, "Bad", `---\nname: Bad Name\ndescription: ${DESCRIPTION}\n---\n正文`);
		await mkdir(join(second, "no-skill-file"), { recursive: true });

		const sources = [
			{ dir: first, scope: "workspace" as const },
			{ dir: second, scope: "user" as const },
		];
		const { skills, diagnostics } = await loadSkills(sources, { tools: [] });
		assert.deepEqual(
			skills.map((skill) => [skill.name, skill.scope, skill.manualOnly]),
			[
				["pdf", "workspace", true],
				["short", "workspace", false],
			],
		);
		assert.deepEqual(
			diagnostics.map((item) => [item.problem, item.warning ?? false]),
			[
				["badName", false],
				["noDescription", false],
				["shadowed", false],
				["shortDescription", true],
			],
		);
		assert.equal(diagnostics.find((item) => item.problem === "shadowed")?.detail, join(first, "pdf", "SKILL.md"));

		const pdf = skills[0];
		assert.ok(pdf);
		assert.equal(
			formatInvocation(pdf, " 第一页 "),
			`<skill name="pdf" dir="${join(first, "pdf")}">\nFile references inside this skill are relative to ${join(first, "pdf")}.\n\n用 ${join(first, "pdf")}/fill.py 填表\n</skill>\n\n第一页`,
		);
		// 手动调用的不进目录。
		assert.equal(formatCatalogue([pdf]), "");
		assert.match(formatCatalogue(skills), /<available_skills>\n- short: 太短\n<\/available_skills>/);

		// 点过「改用那个」：排在后面的那个赢，先出现的反过来被盖住。
		const preferred = await loadSkills(sources, { tools: [], preferred: { pdf: join(second, "pdf", "SKILL.md") } });
		assert.equal(preferred.skills.find((skill) => skill.name === "pdf")?.content, "被遮蔽的");
		assert.equal(preferred.diagnostics.find((item) => item.problem === "shadowed")?.path, join(first, "pdf", "SKILL.md"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("allowed-tools：三种写法都认，名字按登记的工具对，范围按整个工具放行，对不上的留着照样限制", () => {
	const known = ["read", "edit", "bash", "web_fetch", "task"];
	assert.deepEqual(readAllowedTools(undefined, known), { problems: [] });
	assert.deepEqual(readAllowedTools("Read, WebFetch Bash(git add *)", known), {
		tools: ["read", "web_fetch", "bash"],
		problems: [{ kind: "scoped", items: ["Bash(git add *)"], widened: ["bash"] }],
	});
	assert.deepEqual(readAllowedTools(["MultiEdit", "Agent(a, b)", "NotebookEdit", "mcp__github__search", "mcp__linear", 3], known), {
		tools: ["edit", "task", "NotebookEdit", "mcp__github__search", "mcp__linear"],
		problems: [
			{ kind: "strays", items: ["3"] },
			{ kind: "scoped", items: ["Agent(a, b)"], widened: ["task"] },
			{ kind: "unmatched", items: ["NotebookEdit"] },
			{ kind: "serverWide", items: ["mcp__linear"] },
		],
	});
	// 改名的目标没登记就不算对上：`todo_write` 来自插件，没装时 `TaskCreate` 报出来。
	assert.deepEqual(readAllowedTools("TaskCreate", known).problems, [{ kind: "unmatched", items: ["TaskCreate"] }]);
	assert.deepEqual(readAllowedTools({ a: 1 }, known), { problems: [{ kind: "notList", items: ['{"a":1}'] }] });
});

test("插件带来的技能：排在个人的后面、共用目录的前面，带着插件名；插件根目录指插件目录", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-skills-plugin-"));
	try {
		const plugin = { label: "Git", root: join(root, "git") };
		const sources = skillSources(undefined, [plugin]);
		assert.deepEqual(
			sources.map((source) => source.scope),
			["user", "plugin", "user"],
		);
		assert.equal(sources[0]?.dir, personalDir());
		assert.equal(sources[1]?.dir, join(plugin.root, "skills"));

		await mkdir(join(plugin.root, "skills", "commit"), { recursive: true });
		await writeFile(
			join(plugin.root, "skills", "commit", "SKILL.md"),
			`---\ndescription: ${DESCRIPTION}\n---\n跑 \${CLAUDE_PLUGIN_ROOT}/dist/hook.js，读 \${CLAUDE_SKILL_DIR}/notes.md`,
		);
		const { skills } = await loadSkills([sources[1]!], { tools: [] });
		assert.equal(skills.length, 1);
		const skill = skills[0]!;
		assert.deepEqual([skill.name, skill.scope, skill.plugin], ["commit", "plugin", plugin]);
		assert.match(formatInvocation(skill), new RegExp(`跑 ${plugin.root}/dist/hook.js，读 ${skill.dir}/notes.md`));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
