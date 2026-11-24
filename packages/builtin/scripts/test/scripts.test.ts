import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	NoticeLevel,
	PluginContext,
	PluginSessionStore,
	PluginSettings,
	ProjectInfo,
	SessionSummary,
	SessionWorktreeService,
	TerminalExecService,
	TerminalRunOptions,
	TerminalRunResult,
	WorktreeCreatedInfo,
} from "@plume/contract";
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptsApi } from "../src/api.ts";
import plugin, { STOP_ON_ARCHIVE_TAG } from "../src/index.ts";
import { readRepoScripts } from "../src/repo-file.ts";
import {
	DEFAULT_SETTINGS,
	deleteScriptFromList,
	effectiveScripts,
	filterImportableScripts,
	normalizeSettings,
	parseRepoScripts,
	primaryScript,
	slugifyScriptId,
	upsertScript,
} from "../src/store.ts";
import type { ScriptsSettings, SetupRunStatus } from "../src/types.ts";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("store 纯逻辑", () => {
	it("slugifyScriptId 生成唯一 slug，支持非 ASCII 名称回退", () => {
		expect(slugifyScriptId("Dev Server", [])).toBe("dev-server");
		expect(slugifyScriptId("Dev Server", ["dev-server"])).toBe("dev-server-2");
		expect(slugifyScriptId("Dev Server", ["dev-server", "dev-server-2"])).toBe("dev-server-3");
		expect(slugifyScriptId("启动服务", [])).toBe("script");
		expect(slugifyScriptId("启动服务", ["script"])).toBe("script-2");
	});

	it("upsertScript 维护 runOnWorktreeCreate 互斥与联动字段清理", () => {
		const r1 = upsertScript([], null, {
			name: "Setup",
			command: "pnpm install",
			icon: "configure",
			runOnWorktreeCreate: true,
			waitForSetup: true,
			previewUrl: "  ",
			autoOpenPreview: true,
		});
		expect(r1.script).toEqual({
			id: "setup",
			name: "Setup",
			command: "pnpm install",
			icon: "configure",
			runOnWorktreeCreate: true,
			waitForSetup: true,
		});

		const r2 = upsertScript(r1.scripts, null, {
			name: "Bootstrap",
			command: "npm ci",
			icon: "build",
			runOnWorktreeCreate: true,
			waitForSetup: false,
		});
		expect(r2.scripts[0]?.runOnWorktreeCreate).toBeUndefined();
		expect(r2.scripts[0]?.waitForSetup).toBeUndefined();
		expect(r2.scripts[1]?.runOnWorktreeCreate).toBe(true);

		// 删除与主脚本选择：跳过 setup 脚本优先选普通脚本。
		const r3 = upsertScript(r2.scripts, null, {
			name: "Dev",
			command: "pnpm dev",
			icon: "play",
			previewUrl: "http://localhost:5173",
			autoOpenPreview: true,
		});
		expect(primaryScript(r3.scripts)?.id).toBe("setup");
		expect(primaryScript(r3.scripts, "dev")?.id).toBe("dev");
		expect(deleteScriptFromList(r3.scripts, "setup").map((s) => s.id)).toEqual(["bootstrap", "dev"]);
		expect(primaryScript(deleteScriptFromList(r3.scripts, "setup"))?.id).toBe("dev");
	});

	it("effectiveScripts 在无项目覆盖时继承全局默认，normalizeSettings 去重并保持单 setup", () => {
		const normalized = normalizeSettings({
			globalScripts: [
				{ id: "a", name: "A", command: "echo a", icon: "play", runOnWorktreeCreate: true, waitForSetup: true },
				{ id: "b", name: "B", command: "echo b", icon: "unknown", runOnWorktreeCreate: true, waitForSetup: true },
			],
			byProject: {
				p1: [{ id: "dev", name: "Dev", command: "pnpm dev", icon: "play" }],
			},
		});
		expect(normalized.globalScripts[0]?.runOnWorktreeCreate).toBe(true);
		expect(normalized.globalScripts[1]?.runOnWorktreeCreate).toBeUndefined();
		expect(normalized.globalScripts[1]?.icon).toBe("play");
		expect(effectiveScripts(normalized, "p1").map((s) => s.id)).toEqual(["dev"]);
		expect(effectiveScripts(normalized, "p2").map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("parseRepoScripts 与 readRepoScripts 处理 missing / invalid / valid 与导入去重", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "plume-scripts-repo-"));
		expect(await readRepoScripts(tempDir)).toEqual({ status: "missing" });

		await mkdir(join(tempDir, ".plume"), { recursive: true });
		await writeFile(join(tempDir, ".plume", "scripts.json"), "{ invalid json");
		expect((await readRepoScripts(tempDir)).status).toBe("invalid");

		expect(parseRepoScripts(JSON.stringify({ scripts: [{ name: "Bad", command: "" }] })).status).toBe("invalid");
		expect(parseRepoScripts(JSON.stringify({ scripts: [{ name: "Bad", command: "echo 1", icon: "nope" }] })).status).toBe("invalid");

		await writeFile(
			join(tempDir, ".plume", "scripts.json"),
			JSON.stringify({
				scripts: [
					{ name: "Dev", command: "pnpm dev", icon: "play", stopOnArchive: true, previewUrl: "http://localhost:3000", autoOpenPreview: true },
					{ name: "Test", command: "pnpm test", icon: "test" },
					{ name: "Lint", command: "pnpm lint", icon: "lint" },
				],
			}),
		);
		const valid = await readRepoScripts(tempDir);
		expect(valid.status).toBe("valid");
		if (valid.status !== "valid") return;

		const existing = [
			{ id: "dev-local", name: "dev", command: "npm run dev", icon: "play" as const },
			{ id: "t", name: "Unit", command: "pnpm test", icon: "test" as const },
		];
		// 按名称（忽略大小写）与命令去重，只留下 Lint。
		const importable = filterImportableScripts(existing, valid.scripts);
		expect(importable.map((entry) => entry.name)).toEqual(["Lint"]);
	});
});

describe("plume.scripts 生命周期与服务联动", () => {
	async function loadPlugin(initial: ScriptsSettings = DEFAULT_SETTINGS) {
		let state: ScriptsSettings = normalizeSettings(initial as unknown as Record<string, unknown>);
		const sessions: SessionSummary[] = [
			{
				id: "s1",
				title: "Chat 1",
				cwd: "/repo/wt-1",
				project: "p1",
				createdAt: 0,
				updatedAt: 0,
				running: false,
				kind: "top",
			},
		];
		const projects: ProjectInfo[] = [{ id: "p1", name: "App", path: "/repo/main" }];
		const runs: TerminalRunOptions[] = [];
		const reveals: Array<[string, string]> = [];
		const closedTags: Array<[string, string]> = [];
		const notices: Array<{ sessionId: string; text: string; level?: NoticeLevel }> = [];
		const storeHistory: Array<SetupRunStatus | null> = [];
		const sessionStoreMap = new Map<string, SetupRunStatus | null>();
		let archivedHandler: ((id: string, archived: boolean) => void) | undefined;
		let deletedHandler: ((id: string) => void) | undefined;
		let worktreeHandler: ((info: WorktreeCreatedInfo) => void | Promise<void>) | undefined;
		let api: ScriptsApi | undefined;
		let nextRunResult: (options: TerminalRunOptions) => TerminalRunResult = () => ({ tab: "tab-1" });

		const terminalExec: TerminalExecService = {
			async run(options) {
				runs.push(options);
				return nextRunResult(options);
			},
			async reveal(sessionId, tab) {
				reveals.push([sessionId, tab]);
			},
			async closeByTag(sessionId, tag) {
				closedTags.push([sessionId, tag]);
			},
		};
		const worktree: SessionWorktreeService = {
			available: async () => true,
			requestFor: () => () => undefined,
			onCreated(listener) {
				worktreeHandler = listener;
				return () => {
					if (worktreeHandler === listener) worktreeHandler = undefined;
				};
			},
		};

		const settingsApi: PluginSettings<ScriptsSettings> = {
			get: () => state,
			async set(patch) {
				state = normalizeSettings({ ...state, ...patch } as unknown as Record<string, unknown>);
				return state;
			},
			onChange: () => () => undefined,
		};
		const sessionStoreApi: PluginSessionStore<SetupRunStatus | null> = {
			get: (id) => sessionStoreMap.get(id) ?? null,
			set: (id, value) => {
				sessionStoreMap.set(id, value);
				storeHistory.push(value);
			},
			update: (id, fn) => {
				const next = fn(sessionStoreMap.get(id) ?? null);
				sessionStoreMap.set(id, next);
				storeHistory.push(next);
			},
			delete: (id) => {
				sessionStoreMap.delete(id);
				storeHistory.push(null);
			},
		};

		const ctx = {
			name: plugin.name,
			locale: () => "zh-CN",
			log: { info() {}, warn() {}, error() {} },
			notice: (sessionId: string, text: string, level?: NoticeLevel) => void notices.push({ sessionId, text, ...(level ? { level } : {}) }),
			effect: () => undefined,
			serve: (served: ScriptsApi) => void (api = served),
			settings: async () => settingsApi,
			sessionStore: () => sessionStoreApi,
			use: (name: string) => (name === "terminal.exec" ? terminalExec : worktree),
			sessions: {
				get: async (id: string) => sessions.find((entry) => entry.id === id),
				projects: async () => projects,
				onArchived: (fn: (id: string, archived: boolean) => void) => void (archivedHandler = fn),
				onDeleted: (fn: (id: string) => void) => void (deletedHandler = fn),
			},
		} as unknown as PluginContext;

		await plugin.apply(ctx);
		return {
			api: api!,
			runs,
			reveals,
			closedTags,
			notices,
			storeHistory,
			setNextRunResult: (fn: (options: TerminalRunOptions) => TerminalRunResult) => {
				nextRunResult = fn;
			},
			triggerArchived: (id: string, archived: boolean) => archivedHandler?.(id, archived),
			triggerDeleted: (id: string) => deletedHandler?.(id),
			triggerWorktreeCreated: (info: WorktreeCreatedInfo) => worktreeHandler?.(info),
			getSettings: () => state,
		};
	}

	it("runScript 注入环境变量、区分 stopOnArchive 复用策略与标签，归档/删除时关闭带标记终端", async () => {
		const env = await loadPlugin({
			globalScripts: [],
			byProject: {
				p1: [
					{
						id: "dev",
						name: "Dev",
						command: "pnpm dev",
						icon: "play",
						stopOnArchive: true,
						previewUrl: "http://localhost:5173",
						autoOpenPreview: true,
					},
					{ id: "test", name: "Test", command: "pnpm test", icon: "test" },
				],
			},
		});

		const devOutcome = await env.api.runScript("s1", "dev");
		expect(devOutcome).toEqual({ tab: "tab-1", previewUrl: "http://localhost:5173" });
		expect(env.runs[0]).toMatchObject({
			sessionId: "s1",
			cwd: "/repo/wt-1",
			command: "pnpm dev",
			title: "Dev",
			tag: STOP_ON_ARCHIVE_TAG,
			reuseIdle: false,
			reveal: true,
			env: { PLUME_PROJECT_ROOT: "/repo/main", PLUME_WORKTREE_PATH: "/repo/wt-1" },
		});

		const testOutcome = await env.api.runScript("s1", "test");
		expect(testOutcome).toEqual({ tab: "tab-1", previewUrl: null });
		expect(env.runs[1]).toMatchObject({ reuseIdle: true });
		expect(env.runs[1]?.tag).toBeUndefined();

		// 取消归档不关终端；归档与删除触发 closeByTag。
		env.triggerArchived("s1", false);
		expect(env.closedTags).toEqual([]);
		env.triggerArchived("s1", true);
		env.triggerDeleted("s1");
		expect(env.closedTags).toEqual([
			["s1", STOP_ON_ARCHIVE_TAG],
			["s1", STOP_ON_ARCHIVE_TAG],
		]);
	});

	it("worktree onCreated 支持异步后台触发与同步 waitForSetup 等待（含状态推送与失败提示）", async () => {
		const env = await loadPlugin({
			globalScripts: [{ id: "setup", name: "Setup", command: "pnpm i", icon: "configure", runOnWorktreeCreate: true, waitForSetup: false }],
			byProject: {},
		});

		// 异步模式：不传 waitForExit、立即返回。
		await env.triggerWorktreeCreated({
			sessionId: "s1",
			projectId: "p1",
			projectRoot: "/repo/main",
			worktreePath: "/repo/wt-1",
			signal: new AbortController().signal,
		});
		expect(env.runs[0]).toMatchObject({
			cwd: "/repo/wt-1",
			reveal: false,
			reuseIdle: false,
			env: { PLUME_PROJECT_ROOT: "/repo/main", PLUME_WORKTREE_PATH: "/repo/wt-1" },
		});
		expect(env.runs[0]?.waitForExit).toBeUndefined();

		// 切换为同步等待，模拟非 0 退出码。
		await env.api.saveScript("p1", null, {
			name: "Sync Setup",
			command: "pnpm bootstrap",
			icon: "configure",
			runOnWorktreeCreate: true,
			waitForSetup: true,
		});
		let finish!: (res: { exitCode: number | null }) => void;
		env.setNextRunResult(() => ({
			tab: "tab-sync",
			completion: new Promise((resolve) => {
				finish = resolve;
			}),
		}));

		const waiting = env.triggerWorktreeCreated({
			sessionId: "s1",
			projectId: "p1",
			projectRoot: "/repo/main",
			worktreePath: "/repo/wt-1",
			signal: new AbortController().signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(env.storeHistory[0]).toEqual({ scriptName: "Sync Setup", tab: "tab-sync" });

		finish({ exitCode: 1 });
		await waiting;
		expect(env.storeHistory.at(-1)).toBeNull();
		expect(env.notices).toHaveLength(1);
		expect(env.notices[0]?.level).toBe("error");
		expect(env.notices[0]?.text).toContain("Sync Setup");
	});

	it("项目覆盖保存与重置回全局默认", async () => {
		const env = await loadPlugin({
			globalScripts: [{ id: "g", name: "Global", command: "echo g", icon: "play" }],
			byProject: {},
		});

		await env.api.saveScript("p1", null, { name: "Local", command: "echo l", icon: "build" });
		expect(env.getSettings().byProject.p1?.map((s) => s.name)).toEqual(["Global", "Local"]);

		await env.api.resetProject("p1");
		expect(env.getSettings().byProject.p1).toBeUndefined();
	});
});
