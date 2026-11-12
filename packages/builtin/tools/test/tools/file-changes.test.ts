import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@plume/contract";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { beginMutation, beginPrompt } from "../../src/tools/change-lock.ts";
import { createFileChangesService, readFileChange, recordFileChange, removeFileChanges } from "../../src/tools/file-changes.ts";
import { editTool } from "../../src/tools/edit.ts";
import { withTextFile } from "../../src/tools/file-write.ts";
import { readTool } from "../../src/tools/read.ts";
import { writeTool } from "../../src/tools/write.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";
import { setLocaleSource, words } from "../../src/messages.ts";
import { withFiles } from "../files.ts";

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
	setLocaleSource(() => "zh-CN");
});

async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "plume-changes-")));
	onTestFinished(() => rm(base, { recursive: true, force: true }));
	const cwd = join(base, "project"),
		dataDir = join(base, "data");
	await mkdir(cwd);
	await mkdir(dataDir);
	const ctx: ToolContext = withFiles({ cwd, dataDir, sessionId: "session/不能作路径", state: new Map() });
	const running: SessionSummary[] = [];
	const service = createFileChangesService(dataDir, { list: async () => running });
	const save = async (name: string, content: string) => withTextFile(ctx, name, async (file) => (await file.write(content)).changeId!);
	return { base, ctx, service, running, save };
}
const idOf = (result: ToolResult) => (result.details as { changeId: string }).changeId;

it("edit/write 在实际写入处记录，快照按会话哈希分目录、0600，结果不带原文", async () => {
	const { ctx, service } = await fixture();
	const first = await writeTool.execute({ path: "a.txt", content: "first\n" }, ctx);
	expect(first.isError).not.toBe(true);
	const second = await editTool.execute({ path: "a.txt", old_string: "first", new_string: "second" }, ctx);
	expect(second.isError).not.toBe(true);
	const ids = [idOf(first), idOf(second)];
	expect(ids.every(Boolean)).toBe(true);
	expect(first.details).not.toHaveProperty("before");
	expect(second.details).not.toHaveProperty("after");
	const dir = join(ctx.dataDir!, "changes", createHash("sha256").update(ctx.sessionId!).digest("hex"));
	expect((await readdir(dir)).sort()).toEqual(ids.map((id) => `${id}.json`).sort());
	expect((await lstat(join(dir, `${ids[0]}.json`))).mode & 0o777).toBe(0o600);
	expect(await readFileChange(ctx.dataDir!, ctx.sessionId!, ids[1]!)).toMatchObject({ before: "first\n", after: "second\n", source: "tool" });
	expect((await service.collect(ctx.sessionId!, ctx.cwd, ids)).files).toMatchObject([{ path: join(ctx.cwd, "a.txt"), added: 1, removed: 0, canUndo: true }]);
});

it("删除会话清理私有快照，迟到的后台观测不会重建它们", async () => {
	const { ctx, save } = await fixture();
	const id = await save("a", "after");
	await removeFileChanges(ctx.dataDir!, ctx.sessionId!, ctx.state);
	await expect(readFileChange(ctx.dataDir!, ctx.sessionId!, id)).rejects.toThrow();
	expect(await recordFileChange(ctx, join(ctx.cwd, "a"), "before", "after", "command")).toBeUndefined();
});

it("同一文件只算首次 before 到末次 after，重复标识去重，改回原样不列", async () => {
	const { ctx, service, save } = await fixture();
	await writeFile(join(ctx.cwd, "a"), "one\ntwo\n");
	const first = await save("a", "ONE\ntwo\n"),
		second = await save("a", "ONE\nTWO\n");
	const net = await service.collect(ctx.sessionId!, ctx.cwd, [first, second, first]);
	expect(net.files).toMatchObject([{ path: join(ctx.cwd, "a"), added: 2, removed: 2, canUndo: true }]);
	const third = await save("a", "one\ntwo\n");
	expect((await service.collect(ctx.sessionId!, ctx.cwd, [first, second, third])).files).toEqual([]);
});

it("多文件撤销保留权限，新建空文件也列出并安全删除，可以只撤销指定文件", async () => {
	const { ctx, service, save } = await fixture();
	await writeFile(join(ctx.cwd, "a"), "before");
	await chmod(join(ctx.cwd, "a"), 0o751);
	const first = await save("a", "after"),
		created = await save("empty", "");
	expect((await service.collect(ctx.sessionId!, ctx.cwd, [created])).files).toMatchObject([{ path: join(ctx.cwd, "empty"), canUndo: true }]);
	await service.undo(ctx.sessionId!, ctx.cwd, [first, created], "a");
	expect(await readFile(join(ctx.cwd, "a"), "utf8")).toBe("before");
	expect((await lstat(join(ctx.cwd, "a"))).mode & 0o777).toBe(0o751);
	expect(await readFile(join(ctx.cwd, "empty"), "utf8")).toBe("");
	await service.undo(ctx.sessionId!, ctx.cwd, [created]);
	await expect(lstat(join(ctx.cwd, "empty"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("旧结果、跨会话、非法 ID、伪造快照和快照软链都不补填或撤销", async () => {
	const { ctx, service, save, base } = await fixture();
	expect(await service.collect(ctx.sessionId!, ctx.cwd, [])).toEqual({ files: [], warnings: [] });
	const id = await save("a", "after");
	for (const bad of ["../secret", "not-an-id"]) {
		expect((await service.collect(ctx.sessionId!, ctx.cwd, [bad])).warnings).toHaveLength(1);
		await expect(service.undo(ctx.sessionId!, ctx.cwd, [bad])).rejects.toThrow();
	}
	expect((await service.collect("other", ctx.cwd, [id])).files).toEqual([]);
	expect((await service.collect(ctx.sessionId!, ctx.cwd, [id, "invalid"])).files[0]?.canUndo).toBe(false);
	const path = join(ctx.dataDir!, "changes", createHash("sha256").update(ctx.sessionId!).digest("hex"), `${id}.json`);
	const original = await readFile(path, "utf8");
	await writeFile(path, JSON.stringify({ ...JSON.parse(original), id: "mismatch" }));
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [id])).rejects.toThrow(words().undoInvalid);
	await rm(path);
	await writeFile(join(base, "record"), original);
	await symlink(join(base, "record"), path);
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [id])).rejects.toThrow(words().undoInvalid);
	expect(await readFile(join(ctx.cwd, "a"), "utf8")).toBe("after");
});

it("命令来源拒绝自动撤销，链中缺记录或穿插其他修改也拒绝", async () => {
	const { ctx, service, save } = await fixture();
	const command = await recordFileChange(ctx, join(ctx.cwd, "command"), "before", "after", "command");
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [command!])).rejects.toThrow(words().undoCommand);
	const first = await save("a", "first"),
		second = await save("a", "second"),
		third = await save("a", "third");
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [first, third])).rejects.toThrow(words().undoInterleaved);
	await writeFile(join(ctx.cwd, "a"), "external");
	const fourth = await save("a", "fourth");
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [first, second, third, fourth])).rejects.toThrow(words().undoInterleaved);
	await utimes(join(ctx.cwd, "a"), new Date(0), new Date(0));
	const fifth = await save("a", "fifth");
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [fourth, fifth])).rejects.toThrow(words().undoInterleaved);
});

it("内容相同但 inode、权限或 stat 变化仍拒绝，项目外和软链、目录均不写", async () => {
	const { ctx, service, save, base } = await fixture();
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
		await change(join(ctx.cwd, name));
		expect((await service.collect(ctx.sessionId!, ctx.cwd, [id])).files[0]?.canUndo).toBe(false);
		await expect(service.undo(ctx.sessionId!, ctx.cwd, [id])).rejects.toThrow();
	}
	const outsideId = await save(join(base, "outside"), "changed");
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [outsideId])).rejects.toThrow(words().undoOutside);
	expect(await readFile(join(base, "outside"), "utf8")).toBe("changed");
});

it("撤销前重新读快照和所有文件，多文件预检失败时没有部分写入", async () => {
	const { ctx, service, save } = await fixture();
	const first = await save("a", "after"),
		second = await save("b", "after");
	expect((await service.collect(ctx.sessionId!, ctx.cwd, [first, second])).files.every((file) => file.canUndo)).toBe(true);
	await writeFile(join(ctx.cwd, "b"), "later");
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [first, second])).rejects.toThrow();
	expect(await readFile(join(ctx.cwd, "a"), "utf8")).toBe("after");
	expect(await readFile(join(ctx.cwd, "b"), "utf8")).toBe("later");
});

it("第二个文件写回失败时尽力回滚，回滚保留可执行位", async () => {
	const { ctx, service, save } = await fixture();
	await writeFile(join(ctx.cwd, "a"), "before");
	await chmod(join(ctx.cwd, "a"), 0o751);
	await writeFile(join(ctx.cwd, "b"), "before");
	const ids = [await save("a", "after"), await save("b", "after")];
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(renameSync).mockImplementation((from, to) => {
		if (to === join(ctx.cwd, "b")) throw new Error("injected failure");
		fs.renameSync(from, to);
	});
	await expect(service.undo(ctx.sessionId!, ctx.cwd, ids)).rejects.toThrow("injected failure");
	expect(await readFile(join(ctx.cwd, "a"), "utf8")).toBe("after");
	expect((await lstat(join(ctx.cwd, "a"))).mode & 0o777).toBe(0o751);
	expect(await readFile(join(ctx.cwd, "b"), "utf8")).toBe("after");
});

it("Windows 上一时被拒的撤销会重试，而不是报成失败", async () => {
	// agent 刚写过这个文件，Windows 上扫描新文件的东西正开着它。
	const { ctx, service, save } = await fixture();
	await writeFile(join(ctx.cwd, "scanned.ts"), "before");
	const id = await save("scanned.ts", "after");
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	onTestFinished(() => {
		Object.defineProperty(process, "platform", platform);
	});
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	let refused = 0;
	vi.mocked(renameSync).mockImplementation((from, to) => {
		if (to === join(ctx.cwd, "scanned.ts") && refused < 2) {
			refused += 1;
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
		}
		fs.renameSync(from, to);
	});
	await service.undo(ctx.sessionId!, ctx.cwd, [id]);
	expect(refused, "前提：前两次改名被拒").toBe(2);
	expect(await readFile(join(ctx.cwd, "scanned.ts"), "utf8")).toBe("before");
});

it("预检之后再改文件会拒绝，部分失败回滚不覆盖后来的相同内容替换", async () => {
	const { ctx, service, save } = await fixture();
	await writeFile(join(ctx.cwd, "a"), "before");
	await writeFile(join(ctx.cwd, "b"), "before");
	const ids = [await save("a", "after"), await save("b", "after")];
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(renameSync).mockImplementation((from, to) => {
		if (to === join(ctx.cwd, "b")) {
			fs.renameSync(join(ctx.cwd, "a"), join(ctx.cwd, "saved"));
			fs.writeFileSync(join(ctx.cwd, "a"), "before");
			throw new Error("injected failure");
		}
		fs.renameSync(from, to);
	});
	await expect(service.undo(ctx.sessionId!, ctx.cwd, ids)).rejects.toThrow(words().undoFailed);
	expect(await readFile(join(ctx.cwd, "a"), "utf8")).toBe("before");
	vi.mocked(renameSync).mockReset();
	await writeFile(join(ctx.cwd, "c"), "before");
	const next = await save("c", "after"),
		actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(chmod).mockImplementation(async (path, mode) => {
		await actual.chmod(path, mode);
		await writeFile(join(ctx.cwd, "c"), "later");
	});
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [next])).rejects.toThrow();
	expect(await readFile(join(ctx.cwd, "c"), "utf8")).toBe("later");
});

it("互斥从预检覆盖到回滚，同时挡住工具写入、提示词和另一次撤销", async () => {
	const { ctx, save } = await fixture();
	const id = await save("a", "after");
	let resume!: () => void;
	const waiting = new Promise<SessionSummary[]>((resolve) => {
		resume = () => resolve([]);
	});
	const service = createFileChangesService(ctx.dataDir!, { list: () => waiting });
	const undo = service.undo(ctx.sessionId!, ctx.cwd, [id]);
	expect(beginPrompt()).toBeUndefined();
	expect(() => beginMutation()).toThrow(words().undoBusy);
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [id])).rejects.toThrow(words().undoBusy);
	expect((await writeTool.execute({ path: "blocked", content: "bad" }, ctx)).isError).toBe(true);
	resume();
	await undo;
	const release = beginPrompt()!;
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [id])).rejects.toThrow(words().undoRunning);
	release();
});

it("审批中的工具和同一或嵌套项目运行的任务都阻止撤销，其他项目不阻止", async () => {
	const { ctx, service, save, running, base } = await fixture();
	const id = await save("a", "after");
	const release = beginMutation();
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [id])).rejects.toThrow(words().undoRunning);
	release();
	await mkdir(join(ctx.cwd, "nested"));
	for (const cwd of [ctx.cwd, join(ctx.cwd, "nested"), base]) {
		running.splice(0, running.length, { id: "other", cwd, running: true } as SessionSummary);
		await expect(service.undo(ctx.sessionId!, ctx.cwd, [id])).rejects.toThrow(words().undoRunning);
	}
	const elsewhere = join(base, "elsewhere");
	await mkdir(elsewhere);
	running.splice(0, running.length, { id: "other", cwd: elsewhere, running: true } as SessionSummary);
	await service.undo(ctx.sessionId!, ctx.cwd, [id]);
});

it("没有数据目录的直接工具测试不记历史，拒绝审批也不留记录", async () => {
	const { ctx } = await fixture();
	const bare = { ...ctx, dataDir: undefined };
	expect(idOf(await writeTool.execute({ path: "a", content: "after" }, bare))).toBeUndefined();
	await readTool.execute({ path: "a" }, ctx);
	ctx.requestApproval = async () => "reject";
	expect((await editTool.execute({ path: "a", old_string: "after", new_string: "bad" }, ctx)).isError).toBe(true);
	expect(await readdir(ctx.dataDir!)).toEqual([]);
});

it("项目和数据目录经软链打开时返回真实绝对路径", async () => {
	const { ctx, service, save, base } = await fixture();
	const id = await save("a", "after");
	const linked = join(base, "linked"),
		linkedData = join(base, "linked-data");
	await symlink(ctx.cwd, linked);
	await symlink(ctx.dataDir!, linkedData);
	const aliased = createFileChangesService(linkedData, { list: async () => [] });
	expect((await service.collect(ctx.sessionId!, linked, [id])).files[0]?.path).toBe(join(ctx.cwd, "a"));
	await aliased.undo(ctx.sessionId!, linked, [id], "a");
	await expect(lstat(join(ctx.cwd, "a"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("审批期间仅权限被改动也不写，避免撤销时恢复成过时权限", async () => {
	const { ctx } = await fixture();
	await writeFile(join(ctx.cwd, "a"), "before");
	await chmod(join(ctx.cwd, "a"), 0o755);
	await readTool.execute({ path: "a" }, ctx);
	ctx.requestApproval = async () => {
		await chmod(join(ctx.cwd, "a"), 0o600);
		return "once";
	};
	const result = await writeTool.execute({ path: "a", content: "after" }, ctx);
	expect(result.isError).toBe(true);
	expect(await readFile(join(ctx.cwd, "a"), "utf8")).toBe("before");
	expect((await lstat(join(ctx.cwd, "a"))).mode & 0o777).toBe(0o600);
});

it("快照保存失败明确说明文件已写入，不泄露私有记录路径", async () => {
	const { ctx, base } = await fixture();
	const badData = join(base, "not-a-directory");
	await writeFile(badData, "data");
	const result = await writeTool.execute({ path: "a", content: "written" }, { ...ctx, dataDir: badData });
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toBe(words().changeSaveFailed);
	expect(result.content[0]?.text).not.toContain(badData);
	expect(await readFile(join(ctx.cwd, "a"), "utf8")).toBe("written");
});

it("面向用户的拒绝原因随界面语言切换", async () => {
	const { ctx, service } = await fixture();
	setLocaleSource(() => "en");
	const id = await recordFileChange(ctx, join(ctx.cwd, "a"), "before", "after", "command");
	expect((await service.collect(ctx.sessionId!, ctx.cwd, [id!])).files[0]?.undoReason).toMatch(/manual review/);
});

it("不能撤销的文件说得出是哪一类，快照读不出来的不归类", async () => {
	const { ctx, service, save, base } = await fixture();
	const command = await recordFileChange(ctx, join(ctx.cwd, "command"), "before", "after", "command");
	const first = await save("a", "first");
	await save("a", "second");
	const third = await save("a", "third"),
		edited = await save("b", "after"),
		outside = await save(join(base, "outside"), "changed"),
		kept = await save("c", "after");
	await writeFile(join(ctx.cwd, "b"), "later");
	const { files } = await service.collect(ctx.sessionId!, ctx.cwd, [command!, first, third, edited, outside, kept]);
	expect(Object.fromEntries(files.map((file) => [file.path, file.undoProblem ?? null]))).toEqual({
		[join(ctx.cwd, "command")]: "command",
		[join(ctx.cwd, "a")]: "interleaved",
		[join(ctx.cwd, "b")]: "modified",
		[join(base, "outside")]: "outside",
		[join(ctx.cwd, "c")]: null,
	});
	const [missing] = (await service.collect(ctx.sessionId!, ctx.cwd, [kept, "invalid"])).files;
	expect(missing).toMatchObject({ canUndo: false, undoReason: words().undoInvalid });
	expect(missing).not.toHaveProperty("undoProblem");
});
