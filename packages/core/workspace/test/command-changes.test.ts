/**
 * 一条命令改了哪些文件（`command-changes.ts`）：命令前后对比 git 工作区里改动着的文件，记进快照。bash 怎么请本体观测、后台命令的改动
 * 怎么经 bash_output 算进结果在 plume.tools 的测试里。
 */

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProcess } from "@plume/contract";
import { expect, it, onTestFinished } from "vitest";
import { ChangeLock } from "../src/change-lock.ts";
import { ChangeStore } from "../src/change-store.ts";
import type { ChangeWords } from "../src/change-words.ts";
import { CommandChanges } from "../src/command-changes.ts";

const WORDS: ChangeWords = {
	undoBusy: "undo busy",
	undoRunning: "undo running",
	undoEmpty: "undo empty",
	undoInvalid: "undo invalid",
	undoCommand: "undo command",
	undoInterleaved: "undo interleaved",
	undoOutside: "undo outside",
	undoModified: "undo modified",
	undoFailed: "undo failed",
	changeMissing: "change missing",
	changeSaveFailed: "change save failed",
	changeWarning: (reason) => `not fully recorded: ${reason}`,
	changeLargeFile: "large file",
	changeBinary: "binary",
	changeSecret: "secret",
	changeManyBefore: "many before",
	changeManyAfter: "many after",
	changeLargeBefore: "large before",
	changeLargeAfter: "large after",
	changeBackground: "background",
	changeObserveFailed: "observe failed",
};

const SESSION = "session";

class Process implements SandboxProcess {
	readonly pid = 1;
	private readonly exits: ((code: number | null, signal?: string | null, lingering?: SandboxProcess) => void)[] = [];
	private readonly errors: ((error: Error) => void)[] = [];
	onExit(listener: (code: number | null, signal?: string | null, lingering?: SandboxProcess) => void) {
		this.exits.push(listener);
	}
	onError(listener: (error: Error) => void) {
		this.errors.push(listener);
	}
	onOutput() {}
	kill() {}
	exit(lingering?: SandboxProcess) {
		for (const listener of this.exits) listener(0, null, lingering);
	}
	error() {
		for (const listener of this.errors) listener(new Error("spawn failed"));
	}
}

async function fixture(born = true) {
	const base = await realpath(await mkdtemp(join(tmpdir(), "plume-command-changes-")));
	onTestFinished(() => rm(base, { recursive: true, force: true }));
	const cwd = join(base, "project"),
		dataDir = join(base, "data");
	await mkdir(cwd);
	await mkdir(dataDir);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(cwd, "tracked"), "one\ntwo\n");
	if (born) {
		git("add", ".");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
	}
	const lock = new ChangeLock(() => WORDS);
	const store = new ChangeStore(
		dataDir,
		lock,
		() => WORDS,
		async () => [],
	);
	const commands = new CommandChanges(dataDir, store, lock, () => WORDS);
	/** 跑一条「命令」：`action` 是它对工作区做的事，做完进程退出，交回记下的改动。 */
	const observe = async (action: () => Promise<void> = async () => {}, at = cwd) => {
		const observation = await commands.begin({ sessionId: SESSION, cwd: at });
		const process = new Process();
		observation.watch(process, () => {});
		await action();
		process.exit();
		return observation.read();
	};
	return { base, cwd, git, lock, store, commands, observe };
}

it("记录修改、新建、删除和命令前已有的脏文件，前后相同的不记", async () => {
	const { cwd, store, observe } = await fixture();
	await writeFile(join(cwd, "dirty"), "before\n");
	const record = await observe(async () => {
		await writeFile(join(cwd, "dirty"), "after\n");
		await writeFile(join(cwd, "created"), "new\n");
		await rm(join(cwd, "tracked"));
	});
	expect(record.warning).toBeUndefined();
	expect([...record.paths].sort()).toEqual(["created", "dirty", "tracked"].map((name) => join(cwd, name)));
	const files = (await store.collect(SESSION, cwd, record.ids)).files;
	expect(files.every((file) => !file.canUndo && file.undoProblem === "command")).toBe(true);
	const changes = await Promise.all(record.ids.map((id) => store.read(SESSION, id)));
	expect(changes.find((change) => change.path.endsWith("/dirty"))).toMatchObject({ before: "before\n", after: "after\n", source: "command" });
	expect(changes.find((change) => change.path.endsWith("/tracked"))).toMatchObject({ before: "one\ntwo\n", after: null });
	expect(await observe()).toEqual({ ids: [], paths: [] });
});

it("自动观测不读取环境文件、私钥或凭据，只报告未覆盖", async () => {
	for (const name of [".env", ".env.local", "server.key", ".aws/credentials"]) {
		const { cwd, observe } = await fixture();
		if (name.includes("/")) await mkdir(join(cwd, ".aws"));
		await writeFile(join(cwd, name), "fake-test-credential");
		const record = await observe(() => writeFile(join(cwd, "tracked"), "changed"));
		expect(record).toEqual({ ids: [], paths: [], warning: WORDS.changeWarning(WORDS.changeSecret) });
	}
});

it("CRLF 检出按工作区换行比较，不把每行都算成改动；未出生分支也可记录", async () => {
	const { cwd, git, store, observe } = await fixture();
	await writeFile(join(cwd, ".gitattributes"), "tracked text eol=crlf\n");
	git("add", ".gitattributes");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "attributes");
	await rm(join(cwd, "tracked"));
	git("checkout-index", "-f", "--", "tracked");
	const { ids } = await observe(() => writeFile(join(cwd, "tracked"), "ONE\r\ntwo\r\n"));
	expect(await store.read(SESSION, ids[0]!)).toMatchObject({ before: "one\r\ntwo\r\n", after: "ONE\r\ntwo\r\n" });
	const unborn = await fixture(false);
	const changed = await unborn.observe(() => writeFile(join(unborn.cwd, "tracked"), "changed"));
	expect(await unborn.store.read(SESSION, changed.ids[0]!)).toMatchObject({ before: "one\ntwo\n", after: "changed" });
});

it("隔离 Git 视图不执行 fsmonitor、hooks、filter、外部 diff 或 textconv", async () => {
	const { cwd, git, base, observe } = await fixture();
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
	await writeFile(join(cwd, ".gitattributes"), "tracked filter=bad diff=bad\n");
	expect((await observe(() => writeFile(join(cwd, "tracked"), "ONE\ntwo\n"))).ids).toHaveLength(1);
	await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("命令前 200 文件、单文件 2 MiB、总量 16 MiB、二进制和软链边界都只说明没记全", async () => {
	const { cwd, base, observe } = await fixture();
	const refused = async (reason: string) => expect(await observe()).toEqual({ ids: [], paths: [], warning: WORDS.changeWarning(reason) });
	for (let index = 0; index < 201; index++) await writeFile(join(cwd, `many-${index}`), "x");
	await refused(WORDS.changeManyBefore);
	for (let index = 0; index < 201; index++) await rm(join(cwd, `many-${index}`));
	await writeFile(join(cwd, "large"), "x".repeat(2 * 1024 * 1024 + 1));
	await refused(WORDS.changeLargeFile);
	await rm(join(cwd, "large"));
	await writeFile(join(cwd, "binary"), Buffer.from([0, 1, 2]));
	await refused(WORDS.changeBinary);
	await rm(join(cwd, "binary"));
	await writeFile(join(cwd, "invalid"), Buffer.from([0xc3, 0x28]));
	await refused(WORDS.changeBinary);
	await rm(join(cwd, "invalid"));
	await writeFile(join(base, "outside"), "outside");
	await symlink(join(base, "outside"), join(cwd, "link"));
	await refused(WORDS.changeLargeFile);
	await rm(join(cwd, "link"));
	for (let index = 0; index < 9; index++) await writeFile(join(cwd, `size-${index}`), "x".repeat(2 * 1024 * 1024));
	await refused(WORDS.changeLargeBefore);
});

it("命令后超过文件数或总量上限，不生成部分历史", async () => {
	const { cwd, observe } = await fixture();
	expect(
		await observe(async () => {
			for (let index = 0; index < 201; index++) await writeFile(join(cwd, `many-${index}`), "x");
		}),
	).toEqual({ ids: [], paths: [], warning: WORDS.changeWarning(WORDS.changeManyAfter) });
	for (let index = 0; index < 201; index++) await rm(join(cwd, `many-${index}`));
	expect(
		await observe(async () => {
			for (let index = 0; index < 9; index++) await writeFile(join(cwd, `size-${index}`), "x".repeat(2 * 1024 * 1024));
		}),
	).toEqual({ ids: [], paths: [], warning: WORDS.changeWarning(WORDS.changeLargeAfter) });
});

it("非 Git 工作区不编造命令历史", async () => {
	const { base, observe } = await fixture();
	const outside = join(base, "outside");
	await mkdir(outside);
	expect(await observe(() => writeFile(join(outside, "a"), "x"), outside)).toEqual({ ids: [], paths: [] });
});

it("进程和它留下的进程都退出前占着门闩、只说结束后才记；没起来的放开门闩", async () => {
	const { cwd, lock, commands } = await fixture();
	const observation = await commands.begin({ sessionId: SESSION, cwd });
	const child = new Process(),
		lingering = new Process();
	const adopted: SandboxProcess[] = [];
	observation.watch(child, (owned) => adopted.push(owned));
	expect(await observation.read()).toEqual({ ids: [], paths: [], warning: WORDS.changeBackground });
	expect(() => lock.beginUndo()).toThrow(WORDS.undoRunning);
	await writeFile(join(cwd, "tracked"), "changed");
	child.exit(lingering);
	expect(adopted).toEqual([lingering]);
	expect(() => lock.beginUndo()).toThrow(WORDS.undoRunning);
	lingering.exit();
	expect((await observation.read()).paths).toEqual([join(cwd, "tracked")]);
	lock.beginUndo()();
	for (const end of ["abandon", "error"] as const) {
		const next = await commands.begin({ sessionId: SESSION, cwd });
		const process = new Process();
		if (end === "abandon") next.abandon();
		else {
			next.watch(process, () => {});
			process.error();
		}
		lock.beginUndo()();
	}
});

it("撤销进行中不起观测", async () => {
	const { cwd, lock, commands } = await fixture();
	const release = lock.beginUndo();
	await expect(commands.begin({ sessionId: SESSION, cwd })).rejects.toThrow(WORDS.undoBusy);
	release();
});
