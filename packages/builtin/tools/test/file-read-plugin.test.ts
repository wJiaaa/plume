import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalContent, ApprovalDecision, PluginContext, Services, ToolDefinition, ToolRun } from "@plume/contract";
import { expect, it, onTestFinished, vi } from "vitest";
import lspPlugin from "../../../../../plume-plugins/plugins/lsp/src/index.ts";
import { CodeIntelManager } from "../../../../../plume-plugins/plugins/lsp/src/manager.ts";
import type { CodeIntelBackend } from "../../../../../plume-plugins/plugins/lsp/src/types.ts";
import plugin from "../src/index.ts";
import { authorizeCommandReads } from "../src/tools/read-access.ts";
import { localSandbox } from "./sandbox.ts";

async function setup() {
	// 临时区本来就允许读取；独立放在家目录下，才能测到真正的项目读取边界。
	const base = await realpath(await mkdtemp(join(homedir(), ".plume-file-read-test-")));
	const cwd = join(base, "app"),
		shared = join(base, "shared"),
		outside = join(base, "outside");
	const dataDir = join(base, "data", "tools");
	await Promise.all([cwd, shared, outside, dataDir].map((path) => mkdir(path, { recursive: true })));
	await mkdir(join(outside, ".git"));
	for (const dir of [shared, outside]) await writeFile(join(dir, "core.ts"), "export const value = 1;\n");
	const effects: Array<() => void | Promise<void>> = [];
	const tools = new Map<string, ToolDefinition>();
	const services = new Map<string, unknown>([["sandbox", localSandbox]]);
	const context = {
		name: "plume.tools",
		dataDir,
		appDataDir: join(base, "data"),
		locale: () => "zh-CN",
		provide: (name: string, service: unknown) => services.set(name, service),
		use: (name: string) => services.get(name),
		tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) },
		hook() {},
		sessions: { onDeleted() {}, onStopped() {}, onEnded() {}, observe() {}, list: async () => [] },
		effect: (dispose: () => void | Promise<void>) => effects.push(dispose),
		log: { warn() {} },
	} as unknown as PluginContext;
	plugin.apply(context);
	lspPlugin.apply({ ...context, name: "plume.lsp" });
	const reads = services.get("file.read") as Services["file.read"];
	expect(reads).toBeDefined();
	const backend: CodeIntelBackend = {
		name: "test",
		extensions: [".ts"],
		available: async () => true,
		ready: () => true,
		start: async () => {},
		dispose: async () => {},
		references: async (path) => [{ path, line: 1, column: 14 }],
		definition: async (path) => [{ path, line: 1, column: 14 }],
		diagnostics: async () => [],
		rename: async (path, line, column, newText) => [{ path, line, column, endLine: line, endColumn: column + 5, newText }],
	};
	const acquire = vi.spyOn(CodeIntelManager.prototype, "acquire").mockImplementation(async (_file, root) => {
		expect(root).toBe(cwd);
		return backend;
	});
	onTestFinished(async () => {
		acquire.mockRestore();
		for (const dispose of effects.reverse()) await dispose();
		await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	const seen: ApprovalContent[] = [];
	let decision: ApprovalDecision = "reject";
	const run: ToolRun = {
		sessionId: "session",
		toolCallId: "call",
		cwd,
		projectRoots: [shared],
		scratchDir: join(base, "data", "scratch", "session"),
		signal: new AbortController().signal,
		progress() {},
		calls: [],
		permissionMode: async () => "auto",
		tools: () => [...tools.keys()].map((name) => ({ name, plugin: name === "lsp" ? "plume.lsp" : "plume.tools" })),
		ask: async (content) => {
			seen.push(content);
			return decision;
		},
	};
	const execute = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, run);
	return {
		base,
		cwd,
		shared,
		outside,
		reads,
		run,
		execute,
		seen,
		acquire,
		approve: () => {
			decision = "once";
		},
	};
}

it("file.read 接入真实 LSP 插件，四种查询和 read 放行附加源目录，写入和工作树边界不放宽", async () => {
	const { shared, reads, run, execute, seen, acquire } = await setup();
	const path = join(shared, "core.ts");
	expect(await reads.authorize(run, path)).toEqual({ ok: true, absolute: path });
	for (const operation of ["references", "definition", "diagnostics", "rename"]) {
		const result = await execute("lsp", { operation, path: "../shared/core.ts", symbol: "value", newName: "answer" });
		expect(result.isError, operation).toBeUndefined();
	}
	expect(acquire).toHaveBeenCalledTimes(4);
	expect((await execute("read", { path })).output).toContain("export const value = 1");
	expect(seen).toHaveLength(0);
	const written = await execute("write", { path, content: "changed" });
	expect(written.isError).toBe(true);
	expect(seen.at(-1)?.kind).toBe("write");
	expect(await readFile(path, "utf8")).toBe("export const value = 1;\n");
	seen.length = 0;
	run.projectRoots = [];
	const refused = await execute("lsp", { operation: "diagnostics", path });
	expect(refused.isError).toBe(true);
	expect(seen).toHaveLength(1);
	expect(acquire).toHaveBeenCalledTimes(4);
});

it("附加根自身是软链仍可读，根内软链逃逸要问人，指向密钥的软链仍按单文件审批", async () => {
	const { base, shared, outside, reads, run, execute, seen, acquire } = await setup();
	const alias = join(base, "source-link");
	await symlink(shared, alias, process.platform === "win32" ? "junction" : "dir");
	run.projectRoots = [alias];
	expect(await reads.authorize(run, join(alias, "core.ts"))).toEqual({ ok: true, absolute: join(shared, "core.ts") });
	expect((await execute("read", { path: join(alias, "core.ts") })).isError).toBeUndefined();
	expect((await execute("lsp", { operation: "diagnostics", path: join(alias, "core.ts") })).isError).toBeUndefined();
	expect(
		await authorizeCommandReads(`cat '${join(alias, "core.ts")}'`, {
			cwd: run.cwd,
			projectRoots: run.projectRoots,
			state: new Map(),
			requestApproval: run.ask,
		}),
	).toBeNull();
	expect(seen).toHaveLength(0);
	await symlink(outside, join(shared, "escape"), process.platform === "win32" ? "junction" : "dir");
	expect((await execute("lsp", { operation: "diagnostics", path: join(alias, "escape", "core.ts") })).isError).toBe(true);
	expect(seen.at(-1)).toMatchObject({ kind: "read", subject: `read:${outside}` });
	expect(acquire).toHaveBeenCalledTimes(1);
	const keys = join(shared, ".ssh"),
		key = join(keys, "id_fixture");
	await mkdir(keys);
	await writeFile(key, "test fixture only\n");
	const keyAlias = join(base, "key-source");
	await symlink(keys, keyAlias, process.platform === "win32" ? "junction" : "dir");
	run.projectRoots = [keyAlias];
	expect((await reads.authorize(run, join(keyAlias, "id_fixture"))).ok).toBe(false);
	expect(seen.at(-1)).toMatchObject({ kind: "read", subject: `read:${key}`, detail: key });
});

it("项目外查询可在批准后执行，LSP 和 read 使用同一个 read grant，拒绝时不触及后端", async () => {
	const { outside, execute, seen, acquire, approve } = await setup();
	const path = join(outside, "core.ts");
	const args = { operation: "references", path, symbol: "value" };
	expect((await execute("lsp", args)).isError).toBe(true);
	expect(acquire).not.toHaveBeenCalled();
	approve();
	expect((await execute("lsp", args)).isError).toBeUndefined();
	expect((await execute("read", { path })).isError).toBeUndefined();
	expect(seen).toHaveLength(3);
	expect(seen.every((request) => request.subject === `read:${outside}`)).toBe(true);
	expect(acquire).toHaveBeenCalledTimes(1);
});
