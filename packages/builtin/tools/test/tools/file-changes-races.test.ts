import { renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createFileChangesService } from "../../src/tools/file-changes.ts";
import { withTextFile } from "../../src/tools/file-write.ts";
import type { ToolContext } from "../../src/tools/types.ts";
import { words } from "../../src/messages.ts";

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

async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "plume-change-races-")));
	onTestFinished(() => rm(base, { recursive: true, force: true }));
	const cwd = join(base, "project"),
		dataDir = join(base, "data");
	await mkdir(cwd);
	await mkdir(dataDir);
	const ctx: ToolContext = { cwd, dataDir, sessionId: "session", state: new Map() };
	const service = createFileChangesService(dataDir, { list: async () => [] });
	const save = (name: string, content: string) => withTextFile(ctx, name, async (file) => (await file.write(content)).changeId!);
	return { ctx, service, save, base };
}

it("回滚新文件时采用独占创建，不覆盖期间被人重新创建的文件", async () => {
	const { ctx, service, save } = await fixture();
	const first = await save("new", "agent");
	await writeFile(join(ctx.cwd, "other"), "before");
	const second = await save("other", "after");
	vi.mocked(renameSync).mockImplementation(() => {
		writeFileSync(join(ctx.cwd, "new"), "user");
		throw new Error("injected failure");
	});
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [first, second])).rejects.toThrow(words().undoFailed);
	expect(await readFile(join(ctx.cwd, "new"), "utf8")).toBe("user");
	expect(await readFile(join(ctx.cwd, "other"), "utf8")).toBe("after");
});

it("已撤销删除的新文件在后续文件失败时能安全恢复", async () => {
	const { ctx, service, save } = await fixture();
	const first = await save("new", "agent");
	await writeFile(join(ctx.cwd, "other"), "before");
	const second = await save("other", "after");
	vi.mocked(renameSync).mockImplementation(() => {
		throw new Error("injected failure");
	});
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [first, second])).rejects.toThrow("injected failure");
	expect(await readFile(join(ctx.cwd, "new"), "utf8")).toBe("agent");
});

it("父目录被换成项目外的软链，撤销不跟随到外部", async () => {
	const { ctx, service, save, base } = await fixture();
	await mkdir(join(ctx.cwd, "nested"));
	const id = await save("nested/a", "agent");
	await rename(join(ctx.cwd, "nested"), join(base, "moved"));
	await mkdir(join(base, "outside"));
	await writeFile(join(base, "outside", "a"), "user");
	await symlink(join(base, "outside"), join(ctx.cwd, "nested"));
	await expect(service.undo(ctx.sessionId!, ctx.cwd, [id])).rejects.toThrow(words().undoOutside);
	expect(await readFile(join(base, "outside", "a"), "utf8")).toBe("user");
});

it("锁覆盖异步回滚，不能在回滚暂存期间再撤销", async () => {
	const { ctx, service, save } = await fixture();
	await writeFile(join(ctx.cwd, "a"), "before");
	await writeFile(join(ctx.cwd, "b"), "before");
	const ids = [await save("a", "after"), await save("b", "after")];
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(renameSync).mockImplementation((from, to) => {
		if (to === join(ctx.cwd, "b")) throw new Error("injected failure");
		fs.renameSync(from, to);
	});
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	let calls = 0;
	vi.mocked(chmod).mockImplementation(async (path, mode) => {
		if (++calls === 3) await expect(service.undo(ctx.sessionId!, ctx.cwd, ids)).rejects.toThrow(words().undoBusy);
		await actual.chmod(path, mode);
	});
	await expect(service.undo(ctx.sessionId!, ctx.cwd, ids)).rejects.toThrow("injected failure");
	expect(calls).toBe(3);
});
