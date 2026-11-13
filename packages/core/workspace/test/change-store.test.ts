/**
 * 改动快照、撤销和它们的门闩（`change-store.ts`、`text-file.ts`、`change-lock.ts`）。写文件的工具怎么用它们在 plume.tools 的测试里，
 * 经工具调用记到结果上、撤回时连文件一起退在 `packages/core/agent/test/run-files.test.ts`、`agent.test.ts`。
 */

import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ChangeLock } from "../src/change-lock.ts";
import { ChangeStore } from "../src/change-store.ts";
import type { ChangeWords } from "../src/change-words.ts";
import { TextFiles } from "../src/text-file.ts";

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return { ...fs, chmod: vi.fn(fs.chmod) };
});
afterEach(() => {
	vi.mocked(renameSync).mockReset();
	vi.mocked(chmod).mockReset();
});

const WORDS: ChangeWords = {
	undoBusy: "undo busy",
	undoRunning: "undo running",
	undoEmpty: "undo empty",
	undoInvalid: "undo invalid",
	undoCommand: "undo command: manual review",
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

const SESSION = "session/不能作路径";

async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "plume-changes-")));
	onTestFinished(() => rm(base, { recursive: true, force: true }));
	const cwd = join(base, "project"),
		dataDir = join(base, "data");
	await mkdir(cwd);
	await mkdir(dataDir);
	const running: string[] = [];
	const lock = new ChangeLock(() => WORDS);
	const store = new ChangeStore(
		dataDir,
		lock,
		() => WORDS,
		async () => running,
	);
	const files = new TextFiles(store, lock, () => WORDS);
	const scope = { cwd, scratchDirs: [], dataDir, sessionId: SESSION };
	const save = async (name: string, content: string) => (await files.change(scope, name, async (file) => (await file.write(content)).changeId))!;
	return { base, cwd, dataDir, lock, store, files, scope, running, save };
}

it("在实际写入处记录，快照按会话哈希分目录、0600", async () => {
	const { cwd, dataDir, store, save } = await fixture();
	const ids = [await save("a.txt", "first\n"), await save("a.txt", "second\n")];
	const dir = join(dataDir, "changes", createHash("sha256").update(SESSION).digest("hex"));
	expect((await readdir(dir)).sort()).toEqual(ids.map((id) => `${id}.json`).sort());
	expect((await lstat(join(dir, `${ids[0]}.json`))).mode & 0o777).toBe(0o600);
	expect(await store.read(SESSION, ids[1]!)).toMatchObject({ before: "first\n", after: "second\n", source: "tool" });
	expect((await store.collect(SESSION, cwd, ids)).files).toMatchObject([{ path: join(cwd, "a.txt"), added: 1, removed: 0, canUndo: true }]);
});

it("删除会话清理私有快照，迟到的后台观测不会重建它们", async () => {
	const { cwd, store, save } = await fixture();
	const id = await save("a", "after");
	await store.forget(SESSION);
	await expect(store.read(SESSION, id)).rejects.toThrow();
	expect(await store.record(SESSION, join(cwd, "a"), "before", "after", "command")).toBeUndefined();
});

it("同一文件只算首次 before 到末次 after，重复标识去重，改回原样不列", async () => {
	const { cwd, store, save } = await fixture();
	await writeFile(join(cwd, "a"), "one\ntwo\n");
	const first = await save("a", "ONE\ntwo\n"),
		second = await save("a", "ONE\nTWO\n");
	const net = await store.collect(SESSION, cwd, [first, second, first]);
	expect(net.files).toMatchObject([{ path: join(cwd, "a"), added: 2, removed: 2, canUndo: true }]);
	const third = await save("a", "one\ntwo\n");
	expect((await store.collect(SESSION, cwd, [first, second, third])).files).toEqual([]);
});

it("多文件撤销保留权限，新建空文件也列出并安全删除，可以只撤销指定文件", async () => {
	const { cwd, store, save } = await fixture();
	await writeFile(join(cwd, "a"), "before");
	await chmod(join(cwd, "a"), 0o751);
	const first = await save("a", "after"),
		created = await save("empty", "");
	expect((await store.collect(SESSION, cwd, [created])).files).toMatchObject([{ path: join(cwd, "empty"), canUndo: true }]);
	await store.undo(SESSION, cwd, [first, created], "a");
	expect(await readFile(join(cwd, "a"), "utf8")).toBe("before");
	expect((await lstat(join(cwd, "a"))).mode & 0o777).toBe(0o751);
	expect(await readFile(join(cwd, "empty"), "utf8")).toBe("");
	await store.undo(SESSION, cwd, [created]);
	await expect(lstat(join(cwd, "empty"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("旧结果、跨会话、非法 ID、伪造快照和快照软链都不补填或撤销", async () => {
	const { cwd, dataDir, store, save, base } = await fixture();
	expect(await store.collect(SESSION, cwd, [])).toEqual({ files: [], warnings: [] });
	const id = await save("a", "after");
	for (const bad of ["../secret", "not-an-id"]) {
		expect((await store.collect(SESSION, cwd, [bad])).warnings).toHaveLength(1);
		await expect(store.undo(SESSION, cwd, [bad])).rejects.toThrow();
	}
	expect((await store.collect("other", cwd, [id])).files).toEqual([]);
	expect((await store.collect(SESSION, cwd, [id, "invalid"])).files[0]?.canUndo).toBe(false);
	const path = join(dataDir, "changes", createHash("sha256").update(SESSION).digest("hex"), `${id}.json`);
	const original = await readFile(path, "utf8");
	await writeFile(path, JSON.stringify({ ...JSON.parse(original), id: "mismatch" }));
	await expect(store.undo(SESSION, cwd, [id])).rejects.toThrow(WORDS.undoInvalid);
	await rm(path);
	await writeFile(join(base, "record"), original);
	await symlink(join(base, "record"), path);
	await expect(store.undo(SESSION, cwd, [id])).rejects.toThrow(WORDS.undoInvalid);
	expect(await readFile(join(cwd, "a"), "utf8")).toBe("after");
});

it("命令来源拒绝自动撤销，链中缺记录或穿插其他修改也拒绝", async () => {
	const { cwd, store, save } = await fixture();
	const command = await store.record(SESSION, join(cwd, "command"), "before", "after", "command");
	await expect(store.undo(SESSION, cwd, [command!])).rejects.toThrow(WORDS.undoCommand);
	const first = await save("a", "first"),
		second = await save("a", "second"),
		third = await save("a", "third");
	await expect(store.undo(SESSION, cwd, [first, third])).rejects.toThrow(WORDS.undoInterleaved);
	await writeFile(join(cwd, "a"), "external");
	const fourth = await save("a", "fourth");
	await expect(store.undo(SESSION, cwd, [first, second, third, fourth])).rejects.toThrow(WORDS.undoInterleaved);
	await utimes(join(cwd, "a"), new Date(0), new Date(0));
	const fifth = await save("a", "fifth");
	await expect(store.undo(SESSION, cwd, [fourth, fifth])).rejects.toThrow(WORDS.undoInterleaved);
});

it("内容相同但 inode、权限或 stat 变化仍拒绝，项目外和软链、目录均不写", async () => {
	const { cwd, store, save, base } = await fixture();
	for (const change of [
		async (path: string) => {
			await rename(path, `${path}.old`);
			await writeFile(path, "after");
		},
		async (path: string) => {
			await chmod(path, 0o700);
		},
		async (path: string) => {
			await utimes(path, new Date(0), new Date(0));
		},
		async (path: string) => {
			await rm(path);
			await symlink(join(base, "outside"), path);
		},
		async (path: string) => {
			await rm(path);
			await mkdir(path);
		},
	]) {
		const name = `file-${Math.random()}`,
			id = await save(name, "after");
		await writeFile(join(base, "outside"), "after");
		await change(join(cwd, name));
		expect((await store.collect(SESSION, cwd, [id])).files[0]?.canUndo).toBe(false);
		await expect(store.undo(SESSION, cwd, [id])).rejects.toThrow();
	}
	const outsideId = await save(join(base, "outside"), "changed");
	await expect(store.undo(SESSION, cwd, [outsideId])).rejects.toThrow(WORDS.undoOutside);
	expect(await readFile(join(base, "outside"), "utf8")).toBe("changed");
});

it("撤销前重新读快照和所有文件，多文件预检失败时没有部分写入", async () => {
	const { cwd, store, save } = await fixture();
	const first = await save("a", "after"),
		second = await save("b", "after");
	expect((await store.collect(SESSION, cwd, [first, second])).files.every((file) => file.canUndo)).toBe(true);
	await writeFile(join(cwd, "b"), "later");
	await expect(store.undo(SESSION, cwd, [first, second])).rejects.toThrow();
	expect(await readFile(join(cwd, "a"), "utf8")).toBe("after");
	expect(await readFile(join(cwd, "b"), "utf8")).toBe("later");
});

it("第二个文件写回失败时尽力回滚，回滚保留可执行位", async () => {
	const { cwd, store, save } = await fixture();
	await writeFile(join(cwd, "a"), "before");
	await chmod(join(cwd, "a"), 0o751);
	await writeFile(join(cwd, "b"), "before");
	const ids = [await save("a", "after"), await save("b", "after")];
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(renameSync).mockImplementation((from, to) => {
		if (to === join(cwd, "b")) throw new Error("injected failure");
		fs.renameSync(from, to);
	});
	await expect(store.undo(SESSION, cwd, ids)).rejects.toThrow("injected failure");
	expect(await readFile(join(cwd, "a"), "utf8")).toBe("after");
	expect((await lstat(join(cwd, "a"))).mode & 0o777).toBe(0o751);
	expect(await readFile(join(cwd, "b"), "utf8")).toBe("after");
});

it("Windows 上一时被拒的撤销会重试，而不是报成失败", async () => {
	// agent 刚写过这个文件，Windows 上扫描新文件的东西正开着它。
	const { cwd, store, save } = await fixture();
	await writeFile(join(cwd, "scanned.ts"), "before");
	const id = await save("scanned.ts", "after");
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	onTestFinished(() => {
		Object.defineProperty(process, "platform", platform);
	});
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	let refused = 0;
	vi.mocked(renameSync).mockImplementation((from, to) => {
		if (to === join(cwd, "scanned.ts") && refused < 2) {
			refused += 1;
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
		}
		fs.renameSync(from, to);
	});
	await store.undo(SESSION, cwd, [id]);
	expect(refused, "前提：前两次改名被拒").toBe(2);
	expect(await readFile(join(cwd, "scanned.ts"), "utf8")).toBe("before");
});

it("预检之后再改文件会拒绝，部分失败回滚不覆盖后来的相同内容替换", async () => {
	const { cwd, store, save } = await fixture();
	await writeFile(join(cwd, "a"), "before");
	await writeFile(join(cwd, "b"), "before");
	const ids = [await save("a", "after"), await save("b", "after")];
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(renameSync).mockImplementation((from, to) => {
		if (to === join(cwd, "b")) {
			fs.renameSync(join(cwd, "a"), join(cwd, "saved"));
			fs.writeFileSync(join(cwd, "a"), "before");
			throw new Error("injected failure");
		}
		fs.renameSync(from, to);
	});
	await expect(store.undo(SESSION, cwd, ids)).rejects.toThrow(WORDS.undoFailed);
	expect(await readFile(join(cwd, "a"), "utf8")).toBe("before");
	vi.mocked(renameSync).mockReset();
	await writeFile(join(cwd, "c"), "before");
	const next = await save("c", "after"),
		actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(chmod).mockImplementation(async (path, mode) => {
		await actual.chmod(path, mode);
		await writeFile(join(cwd, "c"), "later");
	});
	await expect(store.undo(SESSION, cwd, [next])).rejects.toThrow();
	expect(await readFile(join(cwd, "c"), "utf8")).toBe("later");
});

it("互斥从预检覆盖到回滚，同时挡住写文件、发一问和另一次撤销", async () => {
	const { cwd, dataDir, lock, files, scope, save } = await fixture();
	const id = await save("a", "after");
	let resume!: () => void;
	const waiting = new Promise<string[]>((resolve) => {
		resume = () => resolve([]);
	});
	const store = new ChangeStore(
		dataDir,
		lock,
		() => WORDS,
		() => waiting,
	);
	const undo = store.undo(SESSION, cwd, [id]);
	expect(lock.beginPrompt()).toBeUndefined();
	expect(() => lock.beginMutation()).toThrow(WORDS.undoBusy);
	await expect(store.undo(SESSION, cwd, [id])).rejects.toThrow(WORDS.undoBusy);
	await expect(files.change(scope, "blocked", async (file) => file.write("bad"))).rejects.toThrow(WORDS.undoBusy);
	resume();
	await undo;
	const release = lock.beginPrompt()!;
	await expect(store.undo(SESSION, cwd, [id])).rejects.toThrow(WORDS.undoRunning);
	release();
	// 发一问失败了也放开。
	lock.beginUndo()();
});

it("进行中的改动和同一或嵌套项目运行的会话都阻止撤销，其他项目不阻止", async () => {
	const { cwd, lock, store, save, running, base } = await fixture();
	const id = await save("a", "after");
	const release = lock.beginMutation();
	await expect(store.undo(SESSION, cwd, [id])).rejects.toThrow(WORDS.undoRunning);
	release();
	await mkdir(join(cwd, "nested"));
	for (const other of [cwd, join(cwd, "nested"), base]) {
		running.splice(0, running.length, other);
		await expect(store.undo(SESSION, cwd, [id])).rejects.toThrow(WORDS.undoRunning);
	}
	const elsewhere = join(base, "elsewhere");
	await mkdir(elsewhere);
	running.splice(0, running.length, elsewhere);
	await store.undo(SESSION, cwd, [id]);
});

it("项目和数据目录经软链打开时返回真实绝对路径", async () => {
	const { cwd, dataDir, store, save, base } = await fixture();
	const id = await save("a", "after");
	const linked = join(base, "linked"),
		linkedData = join(base, "linked-data");
	await symlink(cwd, linked);
	await symlink(dataDir, linkedData);
	const aliased = new ChangeStore(
		linkedData,
		new ChangeLock(() => WORDS),
		() => WORDS,
		async () => [],
	);
	expect((await store.collect(SESSION, linked, [id])).files[0]?.path).toBe(join(cwd, "a"));
	await aliased.undo(SESSION, linked, [id], "a");
	await expect(lstat(join(cwd, "a"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("快照保存失败明确说明文件已写入，不泄露私有记录路径", async () => {
	const { cwd, base, lock } = await fixture();
	const badData = join(base, "not-a-directory");
	await writeFile(badData, "data");
	const store = new ChangeStore(
		badData,
		lock,
		() => WORDS,
		async () => [],
	);
	const files = new TextFiles(store, lock, () => WORDS);
	const failed = files.change({ cwd, scratchDirs: [], dataDir: badData, sessionId: SESSION }, "a", async (file) => file.write("written"));
	await expect(failed).rejects.toThrow(WORDS.changeSaveFailed);
	await expect(failed).rejects.not.toThrow(badData);
	expect(await readFile(join(cwd, "a"), "utf8")).toBe("written");
});

it("不能撤销的文件说得出是哪一类，快照读不出来的不归类", async () => {
	const { cwd, store, save, base } = await fixture();
	const command = await store.record(SESSION, join(cwd, "command"), "before", "after", "command");
	const first = await save("a", "first");
	await save("a", "second");
	const third = await save("a", "third"),
		edited = await save("b", "after"),
		outside = await save(join(base, "outside"), "changed"),
		kept = await save("c", "after");
	await writeFile(join(cwd, "b"), "later");
	const { files } = await store.collect(SESSION, cwd, [command!, first, third, edited, outside, kept]);
	expect(Object.fromEntries(files.map((file) => [file.path, file.undoProblem ?? null]))).toEqual({
		[join(cwd, "command")]: "command",
		[join(cwd, "a")]: "interleaved",
		[join(cwd, "b")]: "modified",
		[join(base, "outside")]: "outside",
		[join(cwd, "c")]: null,
	});
	const [missing] = (await store.collect(SESSION, cwd, [kept, "invalid"])).files;
	expect(missing).toMatchObject({ canUndo: false, undoReason: WORDS.undoInvalid });
	expect(missing).not.toHaveProperty("undoProblem");
	expect((await store.collect(SESSION, cwd, [command!])).files[0]?.undoReason).toBe(WORDS.undoCommand);
});

it("回滚新文件时采用独占创建，不覆盖期间被人重新创建的文件", async () => {
	const { cwd, store, save } = await fixture();
	const first = await save("new", "agent");
	await writeFile(join(cwd, "other"), "before");
	const second = await save("other", "after");
	vi.mocked(renameSync).mockImplementation(() => {
		writeFileSync(join(cwd, "new"), "user");
		throw new Error("injected failure");
	});
	await expect(store.undo(SESSION, cwd, [first, second])).rejects.toThrow(WORDS.undoFailed);
	expect(await readFile(join(cwd, "new"), "utf8")).toBe("user");
	expect(await readFile(join(cwd, "other"), "utf8")).toBe("after");
});

it("已撤销删除的新文件在后续文件失败时能安全恢复", async () => {
	const { cwd, store, save } = await fixture();
	const first = await save("new", "agent");
	await writeFile(join(cwd, "other"), "before");
	const second = await save("other", "after");
	vi.mocked(renameSync).mockImplementation(() => {
		throw new Error("injected failure");
	});
	await expect(store.undo(SESSION, cwd, [first, second])).rejects.toThrow("injected failure");
	expect(await readFile(join(cwd, "new"), "utf8")).toBe("agent");
});

it("父目录被换成项目外的软链，撤销不跟随到外部", async () => {
	const { cwd, store, save, base } = await fixture();
	await mkdir(join(cwd, "nested"));
	const id = await save("nested/a", "agent");
	await rename(join(cwd, "nested"), join(base, "moved"));
	await mkdir(join(base, "outside"));
	await writeFile(join(base, "outside", "a"), "user");
	await symlink(join(base, "outside"), join(cwd, "nested"));
	await expect(store.undo(SESSION, cwd, [id])).rejects.toThrow(WORDS.undoOutside);
	expect(await readFile(join(base, "outside", "a"), "utf8")).toBe("user");
});

it("锁覆盖异步回滚，不能在回滚暂存期间再撤销", async () => {
	const { cwd, store, save } = await fixture();
	await writeFile(join(cwd, "a"), "before");
	await writeFile(join(cwd, "b"), "before");
	const ids = [await save("a", "after"), await save("b", "after")];
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(renameSync).mockImplementation((from, to) => {
		if (to === join(cwd, "b")) throw new Error("injected failure");
		fs.renameSync(from, to);
	});
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	let calls = 0;
	vi.mocked(chmod).mockImplementation(async (path, mode) => {
		if (++calls === 3) await expect(store.undo(SESSION, cwd, ids)).rejects.toThrow(WORDS.undoBusy);
		await actual.chmod(path, mode);
	});
	await expect(store.undo(SESSION, cwd, ids)).rejects.toThrow("injected failure");
	expect(calls).toBe(3);
});
