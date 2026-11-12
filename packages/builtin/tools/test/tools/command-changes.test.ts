import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunProcess, SandboxProcess, ToolRun } from "@plume/contract";
import { expect, it, onTestFinished } from "vitest";
import { bashOutputTool, bashTool } from "../../src/tools/bash.ts";
import { beforeCommand, afterCommand, withCommandChanges } from "../../src/tools/command-changes.ts";
import { beginUndo } from "../../src/tools/change-lock.ts";
import { createFileChangesService, readFileChange } from "../../src/tools/file-changes.ts";
import { setDataDir } from "../../src/tools/home.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";
import { words } from "../../src/messages.ts";
import { withFiles } from "../files.ts";

async function fixture(born = true) {
	const base = await realpath(await mkdtemp(join(tmpdir(), "plume-command-changes-")));
	onTestFinished(() => rm(base, { recursive: true, force: true }));
	const cwd = join(base, "project"),
		dataDir = join(base, "home", "tools");
	await mkdir(cwd);
	await mkdir(dataDir, { recursive: true });
	setDataDir(join(base, "home"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(cwd, "tracked"), "one\ntwo\n");
	if (born) {
		git("add", ".");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
	}
	const ctx: ToolContext = withFiles({ cwd, dataDir, sessionId: "session", state: new Map() });
	const service = createFileChangesService(dataDir, { list: async () => [] });
	return { base, ctx, git, service };
}

it("记录修改、新建、删除和命令前已有的脏文件，前后相同的不记", async () => {
	const { ctx, service } = await fixture();
	await writeFile(join(ctx.cwd, "dirty"), "before\n");
	const before = await beforeCommand(ctx);
	await writeFile(join(ctx.cwd, "dirty"), "after\n");
	await writeFile(join(ctx.cwd, "created"), "new\n");
	await rm(join(ctx.cwd, "tracked"));
	const ids = await afterCommand(ctx, before);
	const files = (await service.collect(ctx.sessionId!, ctx.cwd, ids)).files;
	expect(files.map((file) => file.path).sort()).toEqual(["created", "dirty", "tracked"].map((name) => join(ctx.cwd, name)));
	expect(files.every((file) => !file.canUndo)).toBe(true);
	const changes = await Promise.all(ids.map((id) => readFileChange(ctx.dataDir!, ctx.sessionId!, id)));
	expect(changes.find((change) => change.path.endsWith("/dirty"))).toMatchObject({ before: "before\n", after: "after\n", source: "command" });
	expect(changes.find((change) => change.path.endsWith("/tracked"))).toMatchObject({ before: "one\ntwo\n", after: null });
	expect(await afterCommand(ctx, await beforeCommand(ctx))).toEqual([]);
});

it("自动观测不读取环境文件、私钥或凭据，只报告未覆盖", async () => {
	for (const name of [".env", ".env.local", "server.key", ".aws/credentials"]) {
		const { ctx } = await fixture();
		if (name.includes("/")) await mkdir(join(ctx.cwd, ".aws"));
		await writeFile(join(ctx.cwd, name), "fake-test-credential");
		await expect(beforeCommand(ctx)).rejects.toThrow(words().changeSecret);
	}
});

it("CRLF 检出按工作区换行比较，不把每行都算成改动；未出生分支也可记录", async () => {
	const { ctx, git } = await fixture();
	await writeFile(join(ctx.cwd, ".gitattributes"), "tracked text eol=crlf\n");
	git("add", ".gitattributes");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "attributes");
	await rm(join(ctx.cwd, "tracked"));
	git("checkout-index", "-f", "--", "tracked");
	const before = await beforeCommand(ctx);
	await writeFile(join(ctx.cwd, "tracked"), "ONE\r\ntwo\r\n");
	const ids = await afterCommand(ctx, before);
	const record = await readFileChange(ctx.dataDir!, ctx.sessionId!, ids[0]!);
	expect(record.before).toBe("one\r\ntwo\r\n");
	expect(record.after).toBe("ONE\r\ntwo\r\n");
	const unborn = await fixture(false),
		snapshot = await beforeCommand(unborn.ctx);
	await writeFile(join(unborn.ctx.cwd, "tracked"), "changed");
	const changes = await afterCommand(unborn.ctx, snapshot);
	expect(await readFileChange(unborn.ctx.dataDir!, unborn.ctx.sessionId!, changes[0]!)).toMatchObject({ before: "one\ntwo\n", after: "changed" });
});

it("隔离 Git 视图不执行 fsmonitor、hooks、filter、外部 diff 或 textconv", async () => {
	const { ctx, git, base } = await fixture();
	const marker = join(base, "executed"),
		script = join(base, "driver");
	await writeFile(script, `#!/bin/sh\nprintf unsafe >> '${marker}'\ncat\n`);
	await chmod(script, 0o755);
	await mkdir(join(base, "hooks"));
	await writeFile(join(base, "hooks", "post-index-change"), `#!/bin/sh\nprintf hook >> '${marker}'\n`);
	await chmod(join(base, "hooks", "post-index-change"), 0o755);
	for (const [key, value] of [
		["core.fsmonitor", script],
		["core.hooksPath", join(base, "hooks")],
		["filter.bad.clean", script],
		["filter.bad.smudge", script],
		["filter.bad.process", script],
		["diff.external", script],
		["diff.bad.textconv", script],
		["remote.origin.uploadpack", script],
	])
		git("config", key!, value!);
	await writeFile(join(ctx.cwd, ".gitattributes"), "tracked filter=bad diff=bad\n");
	const before = await beforeCommand(ctx);
	await writeFile(join(ctx.cwd, "tracked"), "ONE\ntwo\n");
	expect(await afterCommand(ctx, before)).toHaveLength(1);
	await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("200 文件、单文件 2 MiB、总量 16 MiB、二进制和软链边界都受限制", async () => {
	const { ctx, base } = await fixture();
	for (let index = 0; index < 201; index++) await writeFile(join(ctx.cwd, `many-${index}`), "x");
	await expect(beforeCommand(ctx)).rejects.toThrow(words().changeManyBefore);
	for (let index = 0; index < 201; index++) await rm(join(ctx.cwd, `many-${index}`));
	await writeFile(join(ctx.cwd, "large"), "x".repeat(2 * 1024 * 1024 + 1));
	await expect(beforeCommand(ctx)).rejects.toThrow(words().changeLargeFile);
	await rm(join(ctx.cwd, "large"));
	await writeFile(join(ctx.cwd, "binary"), Buffer.from([0, 1, 2]));
	await expect(beforeCommand(ctx)).rejects.toThrow(words().changeBinary);
	await rm(join(ctx.cwd, "binary"));
	await writeFile(join(ctx.cwd, "invalid"), Buffer.from([0xc3, 0x28]));
	await expect(beforeCommand(ctx)).rejects.toThrow(words().changeBinary);
	await rm(join(ctx.cwd, "invalid"));
	await writeFile(join(base, "outside"), "outside");
	await symlink(join(base, "outside"), join(ctx.cwd, "link"));
	await expect(beforeCommand(ctx)).rejects.toThrow(words().changeLargeFile);
	await rm(join(ctx.cwd, "link"));
	for (let index = 0; index < 9; index++) await writeFile(join(ctx.cwd, `size-${index}`), "x".repeat(2 * 1024 * 1024));
	await expect(beforeCommand(ctx)).rejects.toThrow(words().changeLargeBefore);
});

class Process implements RunProcess {
	readonly pid = 1;
	readonly mode = "workspace-write" as const;
	denied() {
		return false;
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
const details = (result: ToolResult) => result.details as { id: string; jobId: string; changeIds: string[]; changeWarning?: string };

it("前台命令结果附带 ID；观测失败只加警告，不把成功命令改成失败", async () => {
	const { ctx } = await fixture();
	for (const binary of [false, true]) {
		const process = new Process();
		ctx.exec = exec(process);
		const result = await withCommandChanges(ctx, async (observed) => {
			await observed.exec!("command");
			await writeFile(join(ctx.cwd, "tracked"), binary ? Buffer.from([0, 1]) : "changed");
			process.exit();
			return { content: [{ type: "text", text: "success" }], isError: false };
		});
		expect(result.isError).toBe(false);
		expect(result.content[0]?.text).toBe("success");
		if (binary) {
			expect(details(result).changeWarning).toContain(words().changeBinary);
			expect(details(result).changeIds).toEqual([]);
		} else expect(details(result).changeIds).toHaveLength(1);
	}
	await writeFile(join(ctx.cwd, "tracked"), Buffer.from([0, 1]));
	const process = new Process();
	ctx.exec = exec(process);
	const result = await withCommandChanges(ctx, async (observed) => {
		await observed.exec!("command");
		process.exit();
		return { content: [{ type: "text", text: "success" }] };
	});
	expect(result.isError).toBeUndefined();
	expect(details(result).changeWarning).toContain(words().changeBinary);
});

it("后台命令和遗留进程结束前保护撤销，停止请求不提前放锁，结束记录经 bash_output 返回", async () => {
	const { ctx, service } = await fixture();
	const child = new Process();
	ctx.exec = exec(child);
	const started = await bashTool.execute({ command: "do-work", run_in_background: true }, ctx);
	const id = details(started).id;
	expect(details(started).changeWarning).toBe(words().changeBackground);
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [])).rejects.toThrow(words().undoRunning);
	await bashOutputTool.execute({ id, kill: true }, ctx);
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [])).rejects.toThrow(words().undoRunning);
	await writeFile(join(ctx.cwd, "tracked"), "changed");
	const lingering = new Process();
	child.exit(lingering);
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [])).rejects.toThrow(words().undoRunning);
	lingering.exit();
	const ended = await bashOutputTool.execute({ id }, ctx);
	expect(details(ended).changeIds).toHaveLength(1);
	const release = beginUndo();
	release();
});

it("前台命令转交遗留进程也不释放保护，启动失败会释放", async () => {
	const { ctx } = await fixture();
	const child = new Process(),
		lingering = new Process();
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	ctx.exec = exec(child, ready);
	const pending = bashTool.execute({ command: "do-work" }, ctx);
	await started;
	// bash 拿到进程以后才挂上退出的监听：真的进程退出是下一轮事件循环的事，这里等到那时再退。
	await new Promise((resolve) => setImmediate(resolve));
	child.exit(lingering);
	const result = await pending;
	expect(details(result).jobId).toBeTruthy();
	expect(() => beginUndo()).toThrow(words().undoRunning);
	lingering.exit();
	await bashOutputTool.execute({ id: details(result).jobId }, ctx);
	const release = beginUndo();
	release();
	for (const thrown of [false, true]) {
		const process = new Process();
		ctx.exec = thrown
			? async () => {
					throw new Error("no backend");
				}
			: exec(process);
		await withCommandChanges(ctx, async (observed) => {
			try {
				await observed.exec!("command");
			} catch {}
			if (!thrown) process.error();
			return { content: [{ type: "text", text: "failed" }], isError: true };
		});
		const release = beginUndo();
		release();
	}
});

it("命令后超过文件数或总量上限，不生成部分历史", async () => {
	const { ctx } = await fixture();
	const before = await beforeCommand(ctx);
	for (let index = 0; index < 201; index++) await writeFile(join(ctx.cwd, `many-${index}`), "x");
	await expect(afterCommand(ctx, before)).rejects.toThrow(words().changeManyAfter);
	for (let index = 0; index < 201; index++) await rm(join(ctx.cwd, `many-${index}`));
	for (let index = 0; index < 9; index++) await writeFile(join(ctx.cwd, `size-${index}`), "x".repeat(2 * 1024 * 1024));
	await expect(afterCommand(ctx, before)).rejects.toThrow(words().changeLargeAfter);
});

it("没有数据目录和非 Git 工作区都不编造命令历史", async () => {
	const { ctx, base } = await fixture();
	expect(await beforeCommand({ ...ctx, dataDir: undefined })).toBeNull();
	const outside = join(base, "outside");
	await mkdir(outside);
	expect(await beforeCommand({ ...ctx, cwd: outside })).toBeNull();
});

it("只读命令不拍快照、不占门闩，所以什么都不记；会写的命令照旧记下", async () => {
	const { ctx } = await fixture();
	// 假沙箱：不管命令是什么都改一个文件。只读命令照样改了，却不该被记下——它根本没拍快照。
	let undoBlocked: boolean | undefined;
	ctx.exec = async () => {
		const process = new Process();
		void writeFile(join(ctx.cwd, "tracked"), `changed ${Math.random()}\n`).then(() => {
			try {
				beginUndo()();
				undoBlocked = false;
			} catch {
				undoBlocked = true;
			}
			process.exit();
		});
		return process;
	};
	expect(details(await bashTool.execute({ command: "git log --oneline -5" }, ctx)).changeIds).toBeUndefined();
	expect(undoBlocked, "只读命令跑着时撤销不被挡").toBe(false);
	expect(details(await bashTool.execute({ command: "touch tracked" }, ctx)).changeIds).toHaveLength(1);
	expect(undoBlocked).toBe(true);
});
