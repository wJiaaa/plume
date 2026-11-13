/**
 * bash 请本体观测改动（`ToolRun.exec` 的 `recordChanges`）：哪些命令观测、观测期间门闩占到什么时候、后台命令的改动怎么经 bash_output 算进结果。
 * 对比和快照本身在 `packages/core/workspace/test/command-changes.test.ts`。
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunProcess, SandboxProcess, ToolRun } from "@plume/contract";
import { expect, it, onTestFinished } from "vitest";
import { text } from "../../../../core/agent/src/i18n.ts";
import { bashOutputTool, bashTool } from "../../src/tools/bash.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import { type TestContext, withFiles } from "../files.ts";

async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "plume-command-changes-")));
	onTestFinished(() => rm(base, { recursive: true, force: true }));
	const cwd = join(base, "project"),
		dataDir = join(base, "data");
	await mkdir(cwd);
	await mkdir(dataDir);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(cwd, "tracked"), "one\ntwo\n");
	git("add", ".");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
	return withFiles({ cwd, dataDir, sessionId: "session", state: new Map() });
}

/** 门闩占着没有：没有可撤的时，占着报「还有改动在进行」，空着报「没有可撤销的」。 */
async function undoBlocked(ctx: TestContext): Promise<boolean> {
	const error = await ctx.changes.undo(ctx.sessionId, []).then(
		() => undefined,
		(error: Error) => error.message,
	);
	if (error === text("changes.undoRunning")) return true;
	expect(error).toBe(text("changes.undoEmpty"));
	return false;
}

class Process implements RunProcess {
	readonly pid = 1;
	readonly mode = "workspace-write" as const;
	denied() {
		return undefined;
	}
	private readonly exits: ((code: number | null, signal?: string | null, lingering?: SandboxProcess) => void)[] = [];
	private readonly errors: ((error: Error) => void)[] = [];
	private readonly outputs: ((chunk: string) => void)[] = [];
	onExit(listener: (code: number | null, signal?: string | null, lingering?: SandboxProcess) => void) {
		this.exits.push(listener);
	}
	onError(listener: (error: Error) => void) {
		this.errors.push(listener);
	}
	onOutput(listener: (chunk: string) => void) {
		this.outputs.push(listener);
	}
	kill() {}
	exit(lingering?: SandboxProcess) {
		for (const listener of this.exits) listener(0, null, lingering);
	}
	error() {
		for (const listener of this.errors) listener(new Error("spawn failed"));
	}
}
function exec(process: Process, started: () => void = () => {}): ToolRun["exec"] {
	return async () => {
		started();
		return process;
	};
}
const details = (result: ToolResult) => result.details as { id: string; jobId: string };
/** bash 拿到进程以后才挂上退出的监听：真的进程退出是下一轮事件循环的事，这里等到那时再退。 */
const later = () => new Promise((resolve) => setImmediate(resolve));

it("会写的命令记下改了什么，只读命令不观测、跑着时不挡撤销", async () => {
	const ctx = await fixture();
	// 假沙箱：不管命令是什么都改一个文件。只读命令照样改了，却不该被记下——它根本没拍快照。
	let blocked: boolean | undefined;
	const run: ToolRun["exec"] = async () => {
		const process = new Process();
		void writeFile(join(ctx.cwd, "tracked"), `changed ${Math.random()}\n`).then(async () => {
			blocked = await undoBlocked(ctx);
			process.exit();
		});
		return process;
	};
	ctx.exec = run;
	await bashTool.execute({ command: "git log --oneline -5" }, ctx);
	expect(await ctx.recorded()).toBeUndefined();
	expect(blocked, "只读命令跑着时撤销不被挡").toBe(false);
	const next = ctx.nextCall();
	await bashTool.execute({ command: "touch tracked" }, next);
	expect(blocked).toBe(true);
	expect(await next.recorded()).toMatchObject({ paths: [join(ctx.cwd, "tracked")] });
	expect((await next.recorded())?.ids).toHaveLength(1);
	expect(await undoBlocked(ctx)).toBe(false);
});

it("观测失败只加警告，不把成功命令改成失败", async () => {
	const ctx = await fixture();
	ctx.exec = async () => {
		const process = new Process();
		void writeFile(join(ctx.cwd, "tracked"), Buffer.from([0, 1]))
			.then(later)
			.then(() => process.exit());
		return process;
	};
	const result = await bashTool.execute({ command: "make" }, ctx);
	expect(result.isError).not.toBe(true);
	expect((await ctx.recorded())?.warning).toContain(text("changes.binary"));
});

it("后台命令和遗留进程结束前保护撤销，停止请求不提前放锁，结束记录经 bash_output 返回", async () => {
	const ctx = await fixture();
	const child = new Process();
	ctx.exec = exec(child);
	const started = await bashTool.execute({ command: "do-work", run_in_background: true }, ctx);
	const id = details(started).id;
	expect((await ctx.recorded())?.warning).toBe(text("changes.background"));
	expect(await undoBlocked(ctx)).toBe(true);
	await bashOutputTool.execute({ id, kill: true }, ctx.nextCall());
	expect(await undoBlocked(ctx)).toBe(true);
	await writeFile(join(ctx.cwd, "tracked"), "changed");
	const lingering = new Process();
	child.exit(lingering);
	expect(await undoBlocked(ctx)).toBe(true);
	lingering.exit();
	const reading = ctx.nextCall();
	await bashOutputTool.execute({ id }, reading);
	expect((await reading.recorded())?.ids).toHaveLength(1);
	expect(await undoBlocked(ctx)).toBe(false);
});

it("前台命令转交遗留进程也不释放保护，启动失败会释放", async () => {
	const ctx = await fixture();
	const child = new Process(),
		lingering = new Process();
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	ctx.exec = exec(child, ready);
	const pending = bashTool.execute({ command: "do-work" }, ctx);
	await started;
	await later();
	child.exit(lingering);
	const result = await pending;
	expect(details(result).jobId).toBeTruthy();
	expect(await undoBlocked(ctx)).toBe(true);
	lingering.exit();
	// 宿主在这次调用答完时等记下的改动（`recorded`），门闩在记完以后放开。
	const reading = ctx.nextCall();
	await bashOutputTool.execute({ id: details(result).jobId }, reading);
	expect(await reading.recorded(), "什么都没改").toBeUndefined();
	expect(await undoBlocked(ctx)).toBe(false);
	for (const thrown of [false, true]) {
		const next = ctx.nextCall();
		const process = new Process();
		next.exec = thrown
			? async () => {
					throw new Error("no backend");
				}
			: async () => {
					void later().then(() => process.error());
					return process;
				};
		await bashTool.execute({ command: "do-work" }, next);
		expect(await undoBlocked(ctx)).toBe(false);
	}
});
