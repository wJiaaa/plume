/**
 * write、edit 经本体 `ToolRun.files.change` 写文件时记下的改动：快照和撤销本身在 `packages/core/workspace/test/change-store.test.ts`。
 */

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { editTool } from "../../src/tools/edit.ts";
import { readTool } from "../../src/tools/read.ts";
import { writeTool } from "../../src/tools/write.ts";
import { withFiles } from "../files.ts";

async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "plume-changes-")));
	onTestFinished(() => rm(base, { recursive: true, force: true }));
	const cwd = join(base, "project"),
		dataDir = join(base, "data");
	await mkdir(cwd);
	await mkdir(dataDir);
	return { base, cwd, dataDir };
}

it("edit/write 在实际写入处记录，记的是本体给的改动标识和路径，结果不带原文", async () => {
	const { cwd, dataDir } = await fixture();
	const first = withFiles({ cwd, dataDir, sessionId: "session/不能作路径", state: new Map() });
	const written = await writeTool.execute({ path: "a.txt", content: "first\n" }, first);
	expect(written.isError).not.toBe(true);
	const second = withFiles({ cwd, dataDir, sessionId: "session/不能作路径", state: first.state });
	const edited = await editTool.execute({ path: "a.txt", old_string: "first", new_string: "second" }, second);
	expect(edited.isError).not.toBe(true);
	expect(written.details).not.toHaveProperty("before");
	expect(edited.details).not.toHaveProperty("after");
	const records = [await first.recorded(), await second.recorded()];
	expect(records).toMatchObject([{ paths: [join(cwd, "a.txt")] }, { paths: [join(cwd, "a.txt")] }]);
	const ids = records.flatMap((record) => record!.ids);
	const dir = join(dataDir, "changes", createHash("sha256").update("session/不能作路径").digest("hex"));
	expect((await readdir(dir)).sort()).toEqual(ids.map((id) => `${id}.json`).sort());
	expect((await first.changes.collect(first.sessionId, ids)).files).toMatchObject([{ path: join(cwd, "a.txt"), added: 1, removed: 0, canUndo: true }]);
	await first.changes.undo(first.sessionId, ids);
	await expect(lstat(join(cwd, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("拒绝审批不写也不留记录", async () => {
	const { cwd, dataDir } = await fixture();
	await writeFile(join(cwd, "a"), "after");
	const ctx = withFiles({ cwd, dataDir, state: new Map(), requestApproval: async () => "reject" });
	await readTool.execute({ path: "a" }, ctx);
	expect((await editTool.execute({ path: "a", old_string: "after", new_string: "bad" }, ctx)).isError).toBe(true);
	expect(await ctx.recorded()).toBeUndefined();
	expect(await readdir(dataDir)).toEqual([]);
});

it("审批期间仅权限被改动也不写，避免撤销时恢复成过时权限", async () => {
	const { cwd, dataDir } = await fixture();
	await writeFile(join(cwd, "a"), "before");
	await chmod(join(cwd, "a"), 0o755);
	const state = new Map();
	await readTool.execute({ path: "a" }, withFiles({ cwd, dataDir, state }));
	const ctx = withFiles({
		cwd,
		dataDir,
		state,
		requestApproval: async () => {
			await chmod(join(cwd, "a"), 0o600);
			return "once";
		},
	});
	const result = await writeTool.execute({ path: "a", content: "after" }, ctx);
	expect(result.isError).toBe(true);
	expect(await readFile(join(cwd, "a"), "utf8")).toBe("before");
	expect((await lstat(join(cwd, "a"))).mode & 0o777).toBe(0o600);
	expect(await ctx.recorded()).toBeUndefined();
});

it("快照保存失败明确说明文件已写入，不泄露私有记录路径", async () => {
	const { cwd, base } = await fixture();
	const badData = join(base, "not-a-directory");
	await writeFile(badData, "data");
	const result = await writeTool.execute(
		{ path: "a", content: "written" },
		withFiles({ cwd, dataDir: badData, scratchDir: join(base, "scratch"), state: new Map() }),
	);
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toMatch(/已写入|written/);
	expect(result.content[0]?.text).not.toContain(badData);
	expect(await readFile(join(cwd, "a"), "utf8")).toBe("written");
});
