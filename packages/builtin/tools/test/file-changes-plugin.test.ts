import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChangesService, HookLayer, PluginContext, PromptSubmit, SessionSummary } from "@plume/contract";
import { expect, it, onTestFinished } from "vitest";
import plugin from "../src/index.ts";
import { beginMutation, beginUndo, waitForChangesIdle } from "../src/tools/change-lock.ts";
import { words } from "../src/messages.ts";

it("提供 file.changes，撤销期间拒绝新轮，尚未完成的提示词钩子阻止撤销", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "plume-tools-plugin-")));
	onTestFinished(() => rm(base, { recursive: true, force: true }));
	const dataDir = join(base, "home", "tools"),
		cwd = join(base, "project");
	await mkdir(dataDir, { recursive: true });
	await mkdir(cwd);
	let service!: FileChangesService, prompt!: HookLayer<"prompt.submit">;
	let unblock!: () => void;
	const list = new Promise<SessionSummary[]>((resolve) => {
		unblock = () => resolve([]);
	});
	plugin.apply({
		name: "plume.tools",
		dataDir,
		appDataDir: join(base, "home"),
		locale: () => "zh-CN",
		provide(name: string, value: unknown) {
			if (name === "file.changes") service = value as FileChangesService;
		},
		hook(name: string, layer: unknown) {
			if (name === "prompt.submit") prompt = layer as HookLayer<"prompt.submit">;
		},
		tools: { register() {} },
		use: () => ({
			run() {
				throw new Error("unused");
			},
			looksDenied: () => false,
		}),
		sessions: { list: () => list, onDeleted() {}, onStopped() {}, observe() {} },
		effect() {},
		log: { warn() {} },
	} as unknown as PluginContext);
	expect(service).toBeDefined();
	expect(prompt).toBeDefined();
	const input = { sessionId: "session", cwd } as PromptSubmit;
	const undo = service.undo("session", cwd, []);
	expect(await prompt(input, async () => ({ block: false }))).toEqual({ block: true, reason: words().undoBusy });
	expect(() => beginMutation()).toThrow(words().undoBusy);
	unblock();
	await expect(undo).rejects.toThrow(words().undoEmpty);
	let proceed!: () => void;
	const wait = new Promise<void>((resolve) => {
		proceed = resolve;
	});
	const submitted = prompt(input, async () => {
		await wait;
		return { block: false };
	});
	expect(() => beginUndo()).toThrow(words().undoRunning);
	proceed();
	expect(await submitted).toEqual({ block: false });
	const release = beginUndo();
	release();
	await expect(
		prompt(input, async () => {
			throw new Error("hook failed");
		}),
	).rejects.toThrow("hook failed");
	const afterFailure = beginUndo();
	afterFailure();
});

it("插件停用等待旧的文件操作和命令保护释放", async () => {
	const release = beginMutation();
	let finished = false;
	const idle = waitForChangesIdle().then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	release();
	await idle;
	expect(finished).toBe(true);
});
