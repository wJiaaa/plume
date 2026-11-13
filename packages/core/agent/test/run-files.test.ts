/**
 * 本体替工具读写：`ToolRun.files` 的读边界和问人（卡片画什么、拒绝了怎么告诉模型）、写文件和这次调用记下的改动、命令观测、撤回时连文件退，
 * `ctx.resources`、`ctx.workspace`。
 *
 * 判定本身（哪里不问、批准覆盖多大，快照和撤销的校验）在 `packages/core/workspace/test/`；这里只看接到过闸、调用结果上以后。
 * 外面的目录放在借来的家目录下：临时目录本来可读，放那里测不出「要问」。
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ApprovalContent, ApprovalDecision, Plugin, RunProcess, ToolResultMessage, ToolRun } from "@plume/contract";
import { DECLINED } from "../src/declined.ts";
import { PluginHost } from "../src/host.ts";
import { text } from "../src/i18n.ts";
import { type CallFiles, Workspace } from "../src/run-files.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	// 家目录下的新目录：临时区本来就允许读，放那里测不到项目边界。
	const base = await realpath(await mkdtemp(join(homedir(), ".plume-run-files-test-")));
	cleanups.push(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	const cwd = join(base, "app"),
		shared = join(base, "shared"),
		outside = join(base, "outside"),
		data = join(base, "data");
	await Promise.all([cwd, shared, outside, data].map((path) => mkdir(path, { recursive: true })));
	await mkdir(join(outside, ".git"));
	for (const dir of [cwd, shared, outside]) await writeFile(join(dir, "core.ts"), "export const value = 1;\n");
	const workspace = new Workspace(data, { list: async () => [], messages: async () => [] }, () => []);
	const asked: ApprovalContent[] = [];
	const answers: ApprovalDecision[] = [];
	const alive: string[] = [];
	const call = (extra: Partial<CallFiles> = {}): CallFiles => ({
		sessionId: "s",
		cwd,
		scratchDir: join(data, "scratch", "s"),
		signal: new AbortController().signal,
		shell: async () => ({ kind: "posix", label: "bash", sandbox: "workspace-write" }),
		ask: async (content) => {
			asked.push(content);
			return answers.shift() ?? "reject";
		},
		alive: (what) => void alive.push(what),
		...extra,
	});
	return { base, cwd, shared, outside, data, workspace, asked, answers, alive, call };
}

it("工作区里的不问，交回绝对路径；每次读先查调用还在不在", async () => {
	const { cwd, workspace, asked, alive, call } = await setup();
	expect(await workspace.call(call()).files.read("core.ts")).toEqual({ ok: true, path: join(cwd, "core.ts") });
	expect(asked).toHaveLength(0);
	expect(alive).toEqual(["ToolRun.files.read"]);
});

it("项目外的经过闸问，卡片写文件名、路径和批准覆盖的项目；批了才交回", async () => {
	const { outside, workspace, asked, answers, call } = await setup();
	const path = join(outside, "core.ts");
	answers.push("once");
	expect(await workspace.call(call()).files.read(path)).toEqual({ ok: true, path });
	expect(asked).toEqual([
		{
			kind: "view",
			title: "读取当前项目之外的位置：core.ts",
			detail: path,
			reason: `批准后，这个会话读取 ${outside} 里的文件不再询问。`,
			subject: `read:${outside}`,
		},
	]);
});

it("人拒绝了：交给模型的话说清是哪个路径，叫它别绕", async () => {
	const { outside, workspace, call } = await setup();
	const path = join(outside, "core.ts");
	expect(await workspace.call(call()).files.read(path)).toEqual({ ok: false, message: `用户拒绝了这次读取：${path}。${DECLINED}` });
});

it("没人可问时拒绝而不是放行", async () => {
	const { outside, workspace, call } = await setup();
	const path = join(outside, "core.ts");
	const { ask: _ask, ...noAsk } = call();
	expect(await workspace.call(noAsk).files.read(path)).toEqual({
		ok: false,
		message: `读取当前项目之外的位置需要用户批准，而这个会话没有可以询问的人：${path}`,
	});
});

it("密钥只批这一个文件，卡片说明同目录的还会再问；经链接也认得出", async () => {
	const { base, shared, workspace, asked, call } = await setup();
	const keys = join(shared, ".ssh"),
		key = join(keys, "id_fixture");
	await mkdir(keys);
	await writeFile(key, "test fixture only\n");
	const alias = join(base, "key-source");
	await symlink(keys, alias, process.platform === "win32" ? "junction" : "dir");
	const result = await workspace.call(call({ projectRoots: [alias] })).files.read(join(alias, "id_fixture"));
	expect(result.ok).toBe(false);
	expect(asked).toEqual([
		{
			kind: "view",
			title: "读取本机密钥文件：id_fixture",
			detail: key,
			reason: "密钥按文件单独批准；同一目录下的其他密钥仍会再问一次。",
			subject: `read:${key}`,
		},
	]);
});

it("同一个项目的其他源码目录、拖进来的文件不问；源码目录自身是链接也一样，里面链出去的照问", async () => {
	const { base, shared, outside, workspace, asked, call } = await setup();
	const files = workspace.call(call({ projectRoots: [shared], allowedPaths: [join(outside, "core.ts")] })).files;
	expect(await files.read("../shared/core.ts")).toEqual({ ok: true, path: join(shared, "core.ts") });
	expect(await files.read(join(outside, "core.ts"))).toEqual({ ok: true, path: join(outside, "core.ts") });

	const alias = join(base, "source-link");
	await symlink(shared, alias, process.platform === "win32" ? "junction" : "dir");
	const viaAlias = workspace.call(call({ projectRoots: [alias] })).files;
	expect(await viaAlias.read(join(alias, "core.ts"))).toEqual({ ok: true, path: join(shared, "core.ts") });
	expect(await viaAlias.readCommand(`cat '${join(alias, "core.ts")}'`)).toEqual({ ok: true });
	expect(asked).toHaveLength(0);

	await symlink(outside, join(shared, "escape"), process.platform === "win32" ? "junction" : "dir");
	expect((await viaAlias.read(join(alias, "escape", "core.ts"))).ok).toBe(false);
	expect(asked.at(-1)).toMatchObject({ kind: "view", subject: `read:${outside}` });
});

it("一行命令写明的路径按同一个边界判，用这次调用的 shell 拆", async () => {
	const { outside, workspace, asked, alive, call } = await setup();
	const refused = await workspace.call(call()).files.readCommand(`cat '${join(outside, "core.ts")}'`);
	expect(refused).toEqual({ ok: false, message: `用户拒绝了这次读取：${join(outside, "core.ts")}。${DECLINED}` });
	expect(asked).toHaveLength(1);
	expect(alive).toEqual(["ToolRun.files.readCommand"]);
	expect(await workspace.call(call()).files.readCommand("cat core.ts && ls")).toEqual({ ok: true });
});

it("资源地址不问人：scratch:// 交回文件，带行范围、别的 scheme 交回读到的；目录交回位置", async () => {
	const { data, workspace, asked, call } = await setup();
	const scratch = join(data, "scratch", "s");
	await mkdir(join(scratch, "notes"), { recursive: true });
	await writeFile(join(scratch, "notes", "a.md"), "一\n二\n三\n");
	const files = workspace.call(call()).files;
	expect(await files.read("scratch://notes/a.md")).toEqual({ ok: true, path: join(scratch, "notes", "a.md") });
	expect(await files.read("scratch://notes/a.md:2-3")).toMatchObject({ ok: true, resource: { content: "二\n三" } });
	expect(await files.read("scratch://notes", { directory: true })).toEqual({ ok: true, path: join(scratch, "notes") });
	expect(await files.read("scratch://../x")).toMatchObject({ ok: false, message: expect.stringMatching(/临时目录外面/) });
	// 没人登记的 scheme 照路径判：在工作区里，交回那个（不存在的）路径，由工具报找不到。
	expect(await files.read("acme://thing")).toMatchObject({ ok: true, path: expect.stringContaining("acme:") });

	const address = workspace.resources.keepArtifact("s", "bash", "完整输出");
	expect(await files.read(address)).toMatchObject({ ok: true, resource: { content: "完整输出", origin: "bash 的原始输出" } });
	workspace.forget("s");
	expect((await files.read(address)).ok).toBe(false);
	expect(asked).toHaveLength(0);
});

it("插件登记的 scheme 只读：塞了 write 也不算可写；撤下以后不再认", async () => {
	const { workspace, call } = await setup();
	const written: string[] = [];
	const undo = workspace.resources.register({
		scheme: "docs",
		describe: "`docs://<名字>` 一份文档",
		resolve: async (url: { raw: string }) => ({ url: url.raw, content: "正文", contentType: "text/plain" }),
		write: async (_url: unknown, content: string) => void written.push(content),
	} as never);
	expect(workspace.resources.list().find((entry) => entry.scheme === "docs")).toMatchObject({ writable: false });
	expect(workspace.resources.list().find((entry) => entry.scheme === "scratch")).toMatchObject({ writable: true });
	expect(await workspace.call(call()).files.read("docs://guide")).toMatchObject({ ok: true, resource: { content: "正文" } });
	undo();
	expect(workspace.resources.list().map((entry) => entry.scheme)).not.toContain("docs");
	expect(written).toEqual([]);
});

it("插件停用时本体替它撤下登记的 scheme", async () => {
	const dir = await mkdtemp(join(homedir(), ".plume-run-files-host-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const docs: Plugin = {
		name: "test.docs",
		apply(ctx) {
			ctx.resources.register({ scheme: "docs", describe: "文档", resolve: async (url) => ({ url: url.raw, content: "正文", contentType: "text/plain" }) });
		},
	};
	const host = new PluginHost({
		dataDir: dir,
		appDataDir: dir,
		log: () => {},
		notice: () => {},
		model: {
			complete: async () => "",
			usage: async () => ({ requests: [], providerNames: {}, archived: [] }),
			findImageModel: async () => ({ reason: "none", candidates: [] }),
			image: async () => ({ ok: false, failure: { summary: "" } }),
		},
	});
	cleanups.push(() => host.dispose());
	await host.load([{ key: "docs", load: async () => docs }]);
	expect(host.workspace.resources.list().map((entry) => entry.scheme)).toContain("docs");
	await host.setEnabled(docs.name, false);
	expect(host.workspace.resources.list().map((entry) => entry.scheme)).not.toContain("docs");
	// 重新启用能再登记同一个 scheme。
	await host.setEnabled(docs.name, true);
	expect(host.workspace.resources.list().map((entry) => entry.scheme)).toContain("docs");
});

it.skipIf(process.platform === "win32")("ctx.workspace.files：git 认的文件，不执行仓库配置的程序；不是仓库时是 null", async () => {
	const { base, data, workspace } = await setup();
	const repo = join(base, "repo");
	await mkdir(join(repo, "src"), { recursive: true });
	await writeFile(join(repo, ".gitignore"), "ignored/\n");
	await writeFile(join(repo, "src", "a.ts"), "a");
	await mkdir(join(repo, "ignored"));
	await writeFile(join(repo, "ignored", "b.ts"), "b");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["add", "-A"], { cwd: repo });
	// 沙箱里的命令能写 `.git/config`：宿主上读 index 时执行 fsmonitor，就是逃出沙箱。
	const marker = join(base, "fsmonitor-ran");
	const hook = join(base, "fsmonitor.sh");
	await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
	await chmod(hook, 0o755);
	execFileSync("git", ["config", "core.fsmonitor", hook], { cwd: repo });

	const listed = await workspace.workspace.files(repo);
	expect(listed?.map((path) => path.slice(repo.length + 1)).sort()).toEqual([".gitignore", join("src", "a.ts")]);
	expect(existsSync(marker), "fsmonitor 不该在宿主上跑").toBe(false);
	expect(await workspace.workspace.files(data)).toBeNull();
});

/** 一条假命令：测试自己决定它什么时候退出。 */
class FakeProcess implements RunProcess {
	readonly mode = "workspace-write" as const;
	private readonly exits: ((code: number | null) => void)[] = [];
	denied() {
		return false;
	}
	onOutput() {}
	onExit(listener: (code: number | null) => void) {
		this.exits.push(listener);
	}
	onError() {}
	kill() {}
	exit() {
		for (const listener of this.exits) listener(0);
	}
}

it("change 交回现在的内容，写下以后记进这次调用；不写就不记，写边界和只读的调用都拒绝", async () => {
	const { cwd, data, workspace, alive, call } = await setup();
	const access = workspace.call(call());
	expect(access.files.resolve("src/a.ts")).toBe(join(cwd, "src/a.ts"));
	const done = await access.files.change("new.ts", async (current) => {
		expect(current).toEqual({ path: join(cwd, "new.ts"), text: null, stamp: null });
		return { text: "one\n", value: 7 };
	});
	expect(done).toMatchObject({ value: 7, path: join(cwd, "new.ts"), written: { size: 4 } });
	expect(await readFile(join(cwd, "new.ts"), "utf8")).toBe("one\n");
	const recorded = await access.recorded();
	expect(recorded).toMatchObject({ paths: [join(cwd, "new.ts")] });
	expect(recorded?.ids).toHaveLength(1);
	expect(alive).toEqual(["ToolRun.files.change"]);

	const idle = workspace.call(call());
	const kept = await idle.files.change("core.ts", async (current) => ({ value: current.text }));
	expect(kept).toEqual({ value: "export const value = 1;\n", path: join(cwd, "core.ts") });
	expect(await idle.recorded()).toBeUndefined();

	await expect(idle.files.change(join(data, "settings.json"), async () => ({ text: "{}", value: null }))).rejects.toThrow(/Plume's own data directory/);
	const readOnly = workspace.call(call({ readOnly: true })).files;
	await expect(readOnly.change("core.ts", async () => ({ text: "bad", value: null }))).rejects.toThrow(/may not change files/);
	expect(await readOnly.write("scratch://notes.md", "bad")).toMatchObject({ ok: false });
	expect(await readFile(join(cwd, "core.ts"), "utf8")).toBe("export const value = 1;\n");
});

it("write 经地址写：scratch:// 写进会话的临时目录、交回文件；不是地址的不写", async () => {
	const { data, workspace, call } = await setup();
	const files = workspace.call(call()).files;
	expect(await files.write("scratch://notes/plan.md", "# 计划\n")).toEqual({ ok: true, path: join(data, "scratch", "s", "notes", "plan.md") });
	expect(await readFile(join(data, "scratch", "s", "notes", "plan.md"), "utf8")).toBe("# 计划\n");
	expect(await files.write("notes.md", "x")).toMatchObject({ ok: false });
});

it("revert 认结果上本体记下的改动：演算、全部退回；有改动没记全时一个文件都不写", async () => {
	const { cwd, workspace, call } = await setup();
	const access = workspace.call(call());
	await access.files.change("core.ts", async () => ({ text: "changed\n", value: null }));
	await access.files.change("added.ts", async () => ({ text: "new\n", value: null }));
	const changes = (await access.recorded())!;
	const result = (extra: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
		role: "toolResult",
		toolCallId: "c",
		toolName: "anything",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 1,
		...extra,
	});
	const real = await realpath(cwd);
	expect(await workspace.revert("s", cwd, [result({ changes }), result()], false)).toEqual({
		files: [
			{ path: join(real, "core.ts"), added: 1, removed: 1, problem: null },
			{ path: join(real, "added.ts"), added: 1, removed: 0, problem: null },
		],
		unrecorded: false,
	});
	// 工具自己在 details 里写的不认。
	expect(await workspace.revert("s", cwd, [result({ details: { changeIds: changes.ids } })], false)).toEqual({ files: [], unrecorded: false });
	const partial = [result({ changes }), result({ changes: { ids: [], paths: [], warning: "too many files" } })];
	expect((await workspace.revert("s", cwd, partial, false)).unrecorded).toBe(true);
	await expect(workspace.revert("s", cwd, partial, true)).rejects.toThrow(text("changes.unrecorded"));
	expect(await readFile(join(cwd, "core.ts"), "utf8")).toBe("changed\n");
	await workspace.revert("s", cwd, [result({ changes })], true);
	expect(await readFile(join(cwd, "core.ts"), "utf8")).toBe("export const value = 1;\n");
	expect(existsSync(join(cwd, "added.ts"))).toBe(false);
});

it.skipIf(process.platform === "win32")(
	"带 recordChanges 的命令由本体观测：结束前只说结束后才记，之后的调用经 includeChanges 算进来；别的会话的进程不认",
	async () => {
		const { cwd, workspace, call } = await setup();
		const git = (...args: string[]) => execFileSync("git", args, { cwd });
		git("init", "-q");
		git("add", ".");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
		const process = new FakeProcess();
		const exec: ToolRun["exec"] = async () => process;
		const first = workspace.call(call());
		await first.exec(exec)("touch core.ts", { recordChanges: true });
		expect(await first.recorded()).toEqual({ ids: [], paths: [], warning: text("changes.background") });
		await writeFile(join(cwd, "core.ts"), "by command\n");
		process.exit();
		const other = workspace.call(call({ sessionId: "other" }));
		other.files.includeChanges(process);
		expect(await other.recorded()).toBeUndefined();
		const later = workspace.call(call());
		later.files.includeChanges(process);
		const recorded = await later.recorded();
		expect(recorded?.paths).toEqual([join(cwd, "core.ts")]);
		expect(recorded?.ids).toHaveLength(1);
		// 不带 recordChanges 的原样交给沙箱，什么都不记。
		const plain = workspace.call(call());
		let options: unknown;
		await plain.exec(async (_command, given) => {
			options = given;
			return new FakeProcess();
		})("ls", { cwd });
		expect(options).toEqual({ cwd });
		expect(await plain.recorded()).toBeUndefined();
	},
);
