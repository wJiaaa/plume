import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalContent, ApprovalDecision, PluginContext, Services, ToolDefinition, ToolRun } from "@plume/contract";
import { expect, it, onTestFinished } from "vitest";
import plugin from "../src/index.ts";
import { authorizeCommandReads } from "../src/tools/read-access.ts";
import { localSandbox } from "./sandbox.ts";

/**
 * 别的插件经 file.read 读项目里的文件（LSP 插件的查询就是这样）：先 authorize，过了才去碰文件。
 * `touched` 记下真正碰到的路径，拒绝时它不该变。
 */
function probeTool(reads: Services["file.read"], touched: string[]): ToolDefinition {
	return {
		name: "probe",
		description: "经 file.read 读一个文件",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		async execute(args, run) {
			const authorized = await reads.authorize(run, String(args.path));
			if (!authorized.ok) return { output: authorized.message, isError: true };
			touched.push(authorized.absolute);
			return { output: authorized.absolute };
		},
	};
}

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
	const reads = services.get("file.read") as Services["file.read"];
	expect(reads).toBeDefined();
	const touched: string[] = [];
	tools.set("probe", probeTool(reads, touched));
	onTestFinished(async () => {
		for (const dispose of effects.reverse()) await dispose();
		await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	const seen: ApprovalContent[] = [];
	let decision: ApprovalDecision = "reject";
	const run: ToolRun = {
		sessionId: "session",
		session: { id: "session", kind: "top" },
		toolCallId: "call",
		cwd,
		projectRoots: [shared],
		scratchDir: join(base, "data", "scratch", "session"),
		signal: new AbortController().signal,
		progress() {},
		calls: [],
		permissionMode: async () => "auto",
		tools: () => [...tools.keys()].map((name) => ({ name, plugin: name === "probe" ? "test.probe" : "plume.tools" })),
		request: async () => ({ answered: false, reason: "declined" }),
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
		touched,
		approve: () => {
			decision = "once";
		},
	};
}

it("别的插件经 file.read 读附加源目录、read 也放行，写入和工作树边界不放宽", async () => {
	const { shared, reads, run, execute, seen, touched } = await setup();
	const path = join(shared, "core.ts");
	expect(await reads.authorize(run, path)).toEqual({ ok: true, absolute: path });
	expect((await execute("probe", { path: "../shared/core.ts" })).isError).toBeUndefined();
	expect(touched).toEqual([path]);
	expect((await execute("read", { path })).output).toContain("export const value = 1");
	expect(seen).toHaveLength(0);
	const written = await execute("write", { path, content: "changed" });
	expect(written.isError).toBe(true);
	expect(seen.at(-1)?.kind).toBe("write");
	expect(await readFile(path, "utf8")).toBe("export const value = 1;\n");
	seen.length = 0;
	run.projectRoots = [];
	const refused = await execute("probe", { path });
	expect(refused.isError).toBe(true);
	expect(seen).toHaveLength(1);
	expect(touched).toHaveLength(1);
});

it("附加根自身是软链仍可读，根内软链逃逸要问人，指向密钥的软链仍按单文件审批", async () => {
	const { base, shared, outside, reads, run, execute, seen, touched } = await setup();
	const alias = join(base, "source-link");
	await symlink(shared, alias, process.platform === "win32" ? "junction" : "dir");
	run.projectRoots = [alias];
	expect(await reads.authorize(run, join(alias, "core.ts"))).toEqual({ ok: true, absolute: join(shared, "core.ts") });
	expect((await execute("read", { path: join(alias, "core.ts") })).isError).toBeUndefined();
	expect((await execute("probe", { path: join(alias, "core.ts") })).isError).toBeUndefined();
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
	expect((await execute("probe", { path: join(alias, "escape", "core.ts") })).isError).toBe(true);
	expect(seen.at(-1)).toMatchObject({ kind: "read", subject: `read:${outside}` });
	expect(touched).toHaveLength(1);
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

it("项目外的文件批准后才读，别的插件和 read 问的是同一种 read 授权，拒绝时不碰文件", async () => {
	const { outside, execute, seen, touched, approve } = await setup();
	const path = join(outside, "core.ts");
	expect((await execute("probe", { path })).isError).toBe(true);
	expect(touched).toHaveLength(0);
	approve();
	expect((await execute("probe", { path })).isError).toBeUndefined();
	expect((await execute("read", { path })).isError).toBeUndefined();
	expect(seen).toHaveLength(3);
	expect(seen.every((request) => request.subject === `read:${outside}`)).toBe(true);
	expect(touched).toHaveLength(1);
});
