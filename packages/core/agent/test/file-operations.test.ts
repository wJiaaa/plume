import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { operateSessionFile, uniqueFileName, validFileName } from "../src/file-operations.ts";

const temporary: string[] = [];
async function workspace() {
	const dir = await mkdtemp(join(tmpdir(), "plume-file-ops-"));
	temporary.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("文件树操作", () => {
	it("新建、同名保护、副本、移动和整批删除保持内容", async () => {
		const cwd = await workspace();
		expect((await operateSessionFile(cwd, { type: "create", directory: cwd, name: "folder", kind: "directory" })).ok).toBe(true);
		const source = join(cwd, "note.md");
		expect(await operateSessionFile(cwd, { type: "create", directory: cwd, name: "note.md", kind: "file" })).toMatchObject({ ok: true, path: source });
		await writeFile(source, "keep me");
		expect((await operateSessionFile(cwd, { type: "create", directory: cwd, name: "note.md", kind: "file" })).code).toBe("exists");
		const free = await operateSessionFile(cwd, { type: "unique", directory: cwd, name: "note.md" });
		expect(free.path).toBe(join(cwd, "note copy.md"));
		expect((await operateSessionFile(cwd, { type: "copy", from: source, to: free.path! })).ok).toBe(true);
		const moved = join(cwd, "folder", "note.md");
		expect(await operateSessionFile(cwd, { type: "rename", from: source, to: moved })).toMatchObject({ ok: true, path: moved });
		expect(await readFile(moved, "utf8")).toBe("keep me");
		expect(await readFile(free.path!, "utf8")).toBe("keep me");
		expect(await operateSessionFile(cwd, { type: "remove", paths: [join(cwd, "folder"), moved] })).toMatchObject({ ok: true, paths: [join(cwd, "folder")] });
	});

	it("只在明确替换时覆盖目标，且不能把文件夹覆盖到其祖先", async () => {
		const cwd = await workspace();
		const from = join(cwd, "from.txt");
		const to = join(cwd, "to.txt");
		await writeFile(from, "new");
		await writeFile(to, "old");
		expect((await operateSessionFile(cwd, { type: "copy", from, to })).code).toBe("exists");
		expect(await readFile(to, "utf8")).toBe("old");
		expect((await operateSessionFile(cwd, { type: "copy", from, to, overwrite: true })).ok).toBe(true);
		expect(await readFile(to, "utf8")).toBe("new");
		await mkdir(join(cwd, "parent", "child"), { recursive: true });
		expect((await operateSessionFile(cwd, { type: "rename", from: join(cwd, "parent", "child"), to: join(cwd, "parent"), overwrite: true })).code).toBe(
			"descendant",
		);
		expect((await operateSessionFile(cwd, { type: "copy", from: join(cwd, "parent"), to: join(cwd, "parent", "child", "copy") })).code).toBe("descendant");
	});

	it("项目额外源目录可操作，越界、根目录和逃逸软链不能修改", async () => {
		const cwd = await workspace();
		const extra = await workspace();
		const outside = await workspace();
		await writeFile(join(outside, "keep"), "safe");
		expect((await operateSessionFile(cwd, { type: "create", directory: extra, name: "yes", kind: "file" }, [extra])).ok).toBe(true);
		await symlink(outside, join(cwd, "escape"));
		for (const directory of [outside, join(cwd, "escape"), join(cwd, "..", "elsewhere")]) {
			expect((await operateSessionFile(cwd, { type: "create", directory, name: "no", kind: "file" }, [extra])).ok).toBe(false);
		}
		expect((await operateSessionFile(cwd, { type: "remove", paths: [cwd] }, [extra])).ok).toBe(false);
		expect((await operateSessionFile(cwd, { type: "remove", paths: [extra] }, [extra])).ok).toBe(false);
		expect((await operateSessionFile(cwd, { type: "remove", paths: [join(cwd, "escape")] })).ok).toBe(false);
		expect(await readFile(join(outside, "keep"), "utf8")).toBe("safe");
	});

	it("删除整批先校验，废纸篓部分失败报告已经移走的路径", async () => {
		const cwd = await workspace();
		const outside = await workspace();
		const a = join(cwd, "a");
		const b = join(cwd, "b");
		await writeFile(a, "a");
		await writeFile(b, "b");
		expect((await operateSessionFile(cwd, { type: "remove", paths: [a, outside] })).ok).toBe(false);
		expect(await readFile(a, "utf8")).toBe("a");
		const result = await operateSessionFile(cwd, { type: "trash", paths: [a, b] }, [], async (path) => {
			if (path.endsWith("/b")) throw new Error("trash failed");
			await rm(path);
		});
		expect(result).toMatchObject({ ok: false, paths: [a], error: "trash failed" });
		expect(await readFile(b, "utf8")).toBe("b");
	});

	it("外部拖入只复制，冲突自动取副本名，并禁止递归复制", async () => {
		const cwd = await workspace();
		const outside = await workspace();
		const source = join(outside, "report.md");
		await writeFile(source, "import");
		await writeFile(join(cwd, "report.md"), "existing");
		expect(await operateSessionFile(cwd, { type: "import", sources: [source], directory: cwd })).toMatchObject({ ok: true, path: join(cwd, "report copy.md") });
		expect(await readFile(source, "utf8")).toBe("import");
		expect(await readFile(join(cwd, "report.md"), "utf8")).toBe("existing");
		await mkdir(join(cwd, "nested"));
		expect((await operateSessionFile(cwd, { type: "import", sources: [cwd], directory: join(cwd, "nested") })).ok).toBe(false);
	});

	it("并发新建只允许一个请求成功", async () => {
		const cwd = await workspace();
		const results = await Promise.all(Array.from({ length: 4 }, () => operateSessionFile(cwd, { type: "create", directory: cwd, name: "one", kind: "file" })));
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => result.code === "exists")).toHaveLength(3);
	});

	it("替换复制失败时恢复目标，而不是先删除旧数据", async () => {
		if (process.platform === "win32") return;
		const cwd = await workspace();
		const from = join(cwd, "from");
		const to = join(cwd, "to");
		await mkdir(from);
		await writeFile(to, "old content");
		// Unix socket 不能复制，用它触发真正的文件系统失败。
		const socket = createServer();
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.listen(join(from, "socket"), resolve);
		});
		try {
			expect((await operateSessionFile(cwd, { type: "copy", from, to, overwrite: true })).ok).toBe(false);
			expect(await readFile(to, "utf8")).toBe("old content");
			expect((await readdir(cwd)).some((name) => name.startsWith(".plume-replace-"))).toBe(false);
		} finally {
			await new Promise<void>((resolve) => socket.close(() => resolve()));
		}
	});

	it("系统别名路径仍保留界面使用的拼写", async () => {
		const cwd = await workspace();
		const alias = join(await workspace(), "alias");
		await symlink(await realpath(cwd), alias);
		const made = await operateSessionFile(alias, { type: "create", directory: alias, name: "note", kind: "file" });
		// 会话根目录本身允许系统别名，里面的逃逸链接仍受真实路径限制。
		expect(made).toMatchObject({ ok: true, path: join(alias, "note") });
	});
});

it("命名与副本序号按平台，点文件不被切成扩展名", () => {
	expect(validFileName("report:1", "darwin")).toBe(true);
	expect(validFileName("report:1", "win32")).toBe(false);
	for (const name of ["", "..", "x/y", "x\\y", " x", "x\0", "a".repeat(256)]) expect(validFileName(name)).toBe(false);
	expect(uniqueFileName([".env", ".env copy"], ".env")).toBe(".env copy 2");
	expect(uniqueFileName(["archive.tar.gz"], "archive.tar.gz")).toBe("archive.tar copy.gz");
});
