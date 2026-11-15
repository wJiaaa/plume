import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HookLayer, ModelContext, PluginContext } from "@plume/contract";
import plugin from "../src/index.ts";
import { INSTRUCTION_BYTE_LIMIT, isIsolatedWorktree, loadMagpieInstructions, loadProjectInstructions } from "../src/instructions.ts";
import { BUILTIN_PERSONAS, buildPromptSections, type SystemPromptInput } from "../src/system.ts";

/** 宿主把段拼成整段系统提示词的方式：段与段之间空一行。 */
const joinSections = (sections: { text: string }[]) =>
	sections
		.map((section) => section.text)
		.filter(Boolean)
		.join("\n\n");

let dir: string;

/** 插件要的 ctx 里，这几个测试用不到、但 apply 时要有的几样。 */
/** 工具表里跑命令的那件按声明的种类认（`kind: "command"`），叫什么都行。 */
const fakeContext = () => ({
	dataDir: join(dir, "data"),
	appDataDir: dir,
	log: { warn() {} },
	locale: () => "zh-CN",
	serve() {},
	trash: (path: string) => rm(path),
	sessions: { onDeleted() {}, get: async () => undefined },
	tools: { list: () => [{ name: "bash", plugin: "test.files", kind: "command" }] },
});

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-prompt-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const base: SystemPromptInput = {
	cwd: "/work/app",
	platform: "darwin",
	shell: { kind: "posix", label: "zsh" },
	modelName: "Test Model",
	permissionMode: "auto",
	isGitRepo: true,
	projectInstructions: [],
	persona: BUILTIN_PERSONAS.general,
};

describe("系统提示词的段", () => {
	it("按顺序给出本体的段，没有项目指令时没有那一段", () => {
		const sections = buildPromptSections(base);
		expect(sections.map((section) => section.id)).toEqual(["identity", "guidelines", "boundaries", "environment", "workspace"]);
		const prompt = joinSections(sections);
		expect(prompt.startsWith("You are Plume, an agent that works directly on the user's computer")).toBe(true);
		expect(prompt).toContain("Environment:\n- Platform: darwin\n- Shell: zsh\n- Git repository: yes\n- Model: Test Model");
		expect(prompt.endsWith("Current working directory: /work/app")).toBe(true);
		// 日期不进系统提示词，前缀才缓存得住。
		expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});

	it('Windows 的 shell 连写法一起说，只在工具表里有跑命令的工具（`kind: "command"`）时，不认它叫什么', () => {
		const environment = (input: Partial<SystemPromptInput>) =>
			buildPromptSections({ ...base, platform: "win32", ...input }).find((section) => section.id === "environment")?.text;
		const bash = [{ name: "sh", kind: "command" as const }];
		// Windows PowerShell 5.1 没有 `&&`：不说的话模型写的第一条 `cd x && npm i` 就是语法错误。
		const legacy = environment({ shell: { kind: "powershell", label: "Windows PowerShell 5.1" }, tools: bash });
		expect(legacy).toContain("- Shell: Windows PowerShell 5.1\n- Commands run in Windows PowerShell 5.1, not bash: write PowerShell.");
		expect(legacy).toContain("`&&` and `||` do not exist in this version");
		const seven = environment({ shell: { kind: "powershell", label: "PowerShell 7" }, tools: bash });
		expect(seven).toContain("Commands run in PowerShell 7, not bash");
		expect(seven).not.toContain("do not exist in this version");
		expect(environment({ shell: { kind: "posix", label: "Git Bash" }, tools: bash })).toContain("write paths with forward slashes");
		// 没有跑命令的工具时只点名，不教写法；Unix 的 shell 什么都不用多说。
		expect(environment({ shell: { kind: "powershell", label: "PowerShell 7" }, tools: [] })).not.toContain("Commands run in");
		expect(environment({ shell: { kind: "powershell", label: "PowerShell 7" }, tools: [{ name: "bash" }] })).not.toContain("Commands run in");
		expect(buildPromptSections({ ...base, tools: bash }).find((section) => section.id === "environment")?.text).not.toContain("Commands run in");
	});

	it("项目的别的源码目录：写、改文件要先问人，按种类点名这一轮写、改文件的工具，没有就不点名", () => {
		const workspace = (tools: SystemPromptInput["tools"]) =>
			buildPromptSections({ ...base, projectRoots: ["/work/app", "/work/lib"], tools }).find((section) => section.id === "workspace")?.text;
		const basic = [
			{ name: "read", kind: "view" as const },
			{ name: "write", kind: "create" as const },
			{ name: "edit", kind: "modify" as const },
		];
		expect(workspace(basic)).toContain(
			"This project also covers these folders — read, search and list them without asking:\n- /work/lib\nUse absolute paths there; a relative path resolves against the working directory. Writing there is not free: write and edit ask the user first, as for any path outside the working directory.",
		);
		expect(workspace([{ name: "patch", kind: "modify" }])).toContain("Writing there is not free: patch asks the user first,");
		expect(workspace([{ name: "read", kind: "view" }])).toContain("Writing there is not free: writing or editing a file there asks the user first,");
	});

	it("工作区外怎么说跟着权限模式走：要批准的两档说要批准，完全访问说哪里都不问（计划模式下只说读），项目其他目录也不再说写要先问", () => {
		const prompt = (input: Partial<SystemPromptInput>) => joinSections(buildPromptSections({ ...base, projectRoots: ["/work/app", "/work/lib"], ...input }));
		for (const permissionMode of ["ask", "auto"] as const) {
			const text = prompt({ permissionMode });
			expect(text).toContain("Reading or writing outside the workspace asks the user for approval");
			expect(text).toContain("Writing there is not free:");
			expect(text).not.toContain("Full access is on");
		}
		const full = prompt({ permissionMode: "full" });
		expect(full).toContain(
			"Full access is on: reading and writing anywhere on this machine — other projects, other workspaces, the user's own configuration — needs no approval",
		);
		// 完全访问下本体直接放行，「要批准」「写要先问」都是假话。
		expect(full).not.toContain("asks the user for approval");
		expect(full).not.toContain("Writing there is not free");
		const planning = prompt({ permissionMode: "full", readOnly: true });
		expect(planning).toContain("Full access is on: reading anywhere on this machine");
		expect(planning).not.toContain("reading and writing anywhere");
	});

	it("取证用的改动去哪改，跟着工作区走", () => {
		const guidelines = (input: Partial<SystemPromptInput>) => buildPromptSections({ ...base, ...input }).find((section) => section.id === "guidelines")?.text;
		expect(guidelines({})).toContain("`git worktree add`");
		expect(guidelines({ isolatedWorktree: true })).toContain("this directory is already an isolated copy");
		expect(guidelines({ isGitRepo: false })).toContain("copy what you need somewhere outside the project");
	});

	it("个性化：语气和全局指令各一段，排在环境之后；专业语气、空指令不占段", () => {
		const sections = buildPromptSections({
			...base,
			tone: "concise",
			customInstructions: "  Reply in haiku.  ",
			projectInstructions: [{ path: "/work/app/AGENTS.md", content: "x" }],
		});
		expect(sections.map((section) => section.id)).toEqual([
			"identity",
			"guidelines",
			"boundaries",
			"environment",
			"tone",
			"userInstructions",
			"projectInstructions",
			"workspace",
		]);
		// 宿主按类别认人写的指令（上下文用量、使用统计），别的插件按类别找身份、准则，都不认段名。
		expect(sections.map((section) => section.category)).toEqual([
			"identity",
			"guidelines",
			undefined,
			undefined,
			undefined,
			"instructions",
			"conventions",
			undefined,
		]);
		expect(sections[4]?.text).toMatch(/^Tone and Style: Be extremely concise/);
		expect(sections[5]?.text).toBe(
			"<global_user_instructions>\nUser's global personal instructions across all projects and chats:\nReply in haiku.\n</global_user_instructions>",
		);
		expect(buildPromptSections({ ...base, tone: "professional", customInstructions: " \n" }).map((section) => section.id)).toEqual([
			"identity",
			"guidelines",
			"boundaries",
			"environment",
			"workspace",
		]);
	});

	it("项目指令按路径包起来，路径里的特殊字符转义", () => {
		const sections = buildPromptSections({ ...base, projectInstructions: [{ path: "/work/a&b/AGENTS.md", content: "Use pnpm." }] });
		expect(sections.map((section) => section.id)).toEqual(["identity", "guidelines", "boundaries", "environment", "projectInstructions", "workspace"]);
		expect(sections[4]?.text).toContain('<project_instructions path="/work/a&amp;b/AGENTS.md">\nUse pnpm.\n</project_instructions>');
		// 每份指令标上来源：路径原样，字数是包着标签的那一截。
		const wrapped = '<project_instructions path="/work/a&amp;b/AGENTS.md">\nUse pnpm.\n</project_instructions>';
		expect(sections[4]?.files).toEqual([{ path: "/work/a&b/AGENTS.md", chars: wrapped.length }]);
	});
});

describe("项目指令", () => {
	it("从工作目录收到仓库根，每层一份，同一层 PLUME.md 先于 AGENTS.md 先于 CLAUDE.md，从远到近排", async () => {
		const repo = join(dir, "repo");
		const pkg = join(repo, "packages", "api");
		await mkdir(join(repo, ".git"), { recursive: true });
		await mkdir(pkg, { recursive: true });
		await writeFile(join(dir, "AGENTS.md"), "仓库外的，不该读到");
		await writeFile(join(repo, "AGENTS.md"), "root agents");
		await writeFile(join(repo, "CLAUDE.md"), "root claude");
		await writeFile(join(pkg, "PLUME.md"), "pkg plume");
		await writeFile(join(pkg, "AGENTS.md"), "pkg agents");
		expect(await loadProjectInstructions(pkg)).toEqual([
			{ path: join(repo, "AGENTS.md"), content: "root agents" },
			{ path: join(pkg, "PLUME.md"), content: "pkg plume" },
		]);
	});

	it("不在 git 仓库里只读工作目录自己；空文件跳过，换同一层的下一份", async () => {
		const cwd = join(dir, "plain");
		await mkdir(cwd);
		await writeFile(join(dir, "AGENTS.md"), "上一层的，不该读到");
		await writeFile(join(cwd, "AGENTS.md"), "  \n");
		await writeFile(join(cwd, "CLAUDE.md"), "claude");
		expect(await loadProjectInstructions(cwd)).toEqual([{ path: join(cwd, "CLAUDE.md"), content: "claude" }]);
	});

	it("裸文件先于标准目录，单数 .agent 先于复数 .agents，每层仍只取一份", async () => {
		await mkdir(join(dir, ".git"));
		await mkdir(join(dir, ".agent"));
		await mkdir(join(dir, ".agents"));
		await writeFile(join(dir, ".agent", "AGENTS.md"), "singular");
		await writeFile(join(dir, ".agents", "AGENTS.md"), "plural");
		expect(await loadProjectInstructions(dir)).toEqual([{ path: join(dir, ".agent", "AGENTS.md"), content: "singular" }]);
		await writeFile(join(dir, "CLAUDE.md"), "native");
		expect(await loadProjectInstructions(dir)).toEqual([{ path: join(dir, "CLAUDE.md"), content: "native" }]);
	});

	it("标准目录也向上收到仓库根，按根到工作目录排列，每次重读磁盘", async () => {
		const repo = join(dir, "repo");
		const pkg = join(repo, "packages", "api");
		await mkdir(join(repo, ".git"), { recursive: true });
		await mkdir(join(repo, ".agents"));
		await mkdir(join(pkg, ".agents"), { recursive: true });
		await mkdir(join(dir, ".agents"));
		await writeFile(join(dir, ".agents", "AGENTS.md"), "outside");
		await writeFile(join(repo, ".agents", "AGENTS.md"), "root");
		await writeFile(join(pkg, ".agents", "AGENTS.md"), "child");
		expect(await loadProjectInstructions(pkg)).toEqual([
			{ path: join(repo, ".agents", "AGENTS.md"), content: "root" },
			{ path: join(pkg, ".agents", "AGENTS.md"), content: "child" },
		]);
		await writeFile(join(pkg, ".agents", "AGENTS.md"), "updated");
		expect((await loadProjectInstructions(pkg)).at(-1)?.content).toBe("updated");
	});

	it("太长的截断，并说出完整文件在哪", async () => {
		await mkdir(join(dir, ".git"));
		await writeFile(join(dir, "AGENTS.md"), "中".repeat(INSTRUCTION_BYTE_LIMIT));
		const [file] = await loadProjectInstructions(dir);
		expect(Buffer.byteLength(file?.content ?? "", "utf8")).toBeLessThan(INSTRUCTION_BYTE_LIMIT + 300);
		expect(file?.content).not.toContain("�");
		expect(file?.content).toContain(`[Instructions truncated at 100 KiB. Read the complete file at ${JSON.stringify(join(dir, "AGENTS.md"))}`);
	});

	it("只有 gitdir 指向 worktrees 的才算隔离副本", async () => {
		expect(await isIsolatedWorktree(dir)).toBe(false);
		await writeFile(join(dir, ".git"), "gitdir: /repo/.git/modules/sub\n");
		expect(await isIsolatedWorktree(dir)).toBe(false);
		await writeFile(join(dir, ".git"), "gitdir: /repo/.git/worktrees/fix\n");
		expect(await isIsolatedWorktree(dir)).toBe(true);
	});
});

describe("Magpie 共享指令", () => {
	it("每轮现读、去掉 BOM，和人自己的全局指令合成一段；删掉后只剩自己的；过长的只放开头", async () => {
		let layer: HookLayer<"model.context"> | undefined;
		const warnings: string[] = [];
		plugin.apply({
			...fakeContext(),
			hook: (_name: string, fn: HookLayer<"model.context">) => void (layer = fn),
			log: { warn: (message: string) => warnings.push(message) },
		} as unknown as PluginContext);
		const instructions = async () => {
			const context = await layer!(
				{
					sessionId: "s",
					session: { id: "s", kind: "top" },
					cwd: dir,
					model: { id: "m", name: "M" },
					permissionMode: "full",
					personalization: { tone: "professional", customInstructions: "个人规则" },
					systemPrompt: "",
					sections: [],
					messages: [],
					tools: [],
				} as unknown as ModelContext,
				async (next) => next,
			);
			return context.sections.find((section) => section.id === "userInstructions")?.text ?? "";
		};
		const path = join(dir, "magpie", "AGENTS.md");
		await mkdir(join(dir, "magpie"));
		await writeFile(path, "\uFEFF共享规则第一版");
		expect(await instructions()).toContain("共享规则第一版\n\n个人规则");
		await writeFile(path, "共享规则第二版");
		expect(await instructions()).toContain("共享规则第二版");
		await rm(path);
		const own = await instructions();
		expect(own).not.toContain("共享规则");
		expect(own).toContain("个人规则");
		await writeFile(path, "x".repeat(110 * 1024));
		expect((await loadMagpieInstructions(dir, { warn: (message) => void warnings.push(message) })).length).toBe(100 * 1024);
		expect(warnings).toHaveLength(1);
	});
});

describe("点名哪个 shell", () => {
	/** 跑一遍 plume.prompt 的 model.context 层，取环境那一段。 */
	async function environmentFor(input: Partial<ModelContext>): Promise<string> {
		let layer: HookLayer<"model.context"> | undefined;
		plugin.apply({ ...fakeContext(), hook: (_name: string, fn: HookLayer<"model.context">) => void (layer = fn) } as unknown as PluginContext);
		const context = await layer!(
			{
				sessionId: "s",
				session: { id: "s", kind: "top" },
				cwd: dir,
				scratchDir: join(dir, "scratch"),
				model: { id: "m", name: "M" },
				permissionMode: "full",
				shell: { kind: "posix", label: "Git Bash", sandbox: "danger-full-access" },
				personalization: { tone: "professional", customInstructions: "" },
				systemPrompt: "",
				sections: [],
				messages: [],
				tools: [{ name: "bash", description: "", parameters: {} }],
				...input,
			} as ModelContext,
			async (next) => next,
		);
		return context.sections.find((section) => section.id === "environment")?.text ?? "";
	}

	it("照本体给的 `ModelContext.shell` 点名，不自己按权限模式选（哪一档对应哪个 shell 在本体测）", async () => {
		expect(await environmentFor({})).toContain("- Shell: Git Bash");
		expect(await environmentFor({ shell: { kind: "powershell", label: "Windows PowerShell 5.1", sandbox: "read-only" } })).toMatch(
			/- Shell: Windows PowerShell 5\.1\n- Commands run in Windows PowerShell 5\.1, not bash/,
		);
	});
});
