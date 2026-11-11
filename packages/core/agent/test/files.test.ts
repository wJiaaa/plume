import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { operateSessionFile } from "../src/file-operations.ts";
import { createAgent } from "../src/index.ts";
import { locateSessionFiles, readListedFile, readSessionFile, readSessionFileBytes, listSessionDirectory, sessionFilePath } from "../src/files.ts";

let dir: string;
let cwd: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-files-"));
	cwd = join(dir, "workspace");
	await mkdir(join(cwd, "src", "deep"), { recursive: true });
	await mkdir(join(cwd, "node_modules", "lib"), { recursive: true });
	await writeFile(join(cwd, "src", "deep", "approvals.ts"), "export const a = 1;\n");
	await writeFile(join(cwd, "node_modules", "lib", "approvals.ts"), "依赖里的同名文件\n");
	await writeFile(join(cwd, "readme.md"), "# 你好\n");
	await writeFile(join(dir, "secret.txt"), "目录外\n");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

it("读到工作目录里的文字文件，相对路径按工作目录解析", async () => {
	const read = await readSessionFile(cwd, "readme.md");
	expect(read).toMatchObject({ text: "# 你好\n", truncated: false, bytes: Buffer.byteLength("# 你好\n") });
	expect(read?.binary).toBeUndefined();
	expect(typeof read?.modifiedAt).toBe("number");
	expect((await readSessionFile(cwd, join(cwd, "src", "deep", "approvals.ts")))?.text).toBe("export const a = 1;\n");
});

it("含 NUL 字节的当二进制，只报大小", async () => {
	await writeFile(join(cwd, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
	expect(await readSessionFile(cwd, "logo.png")).toMatchObject({ text: "", binary: true, bytes: 4, truncated: false });
});

it("超过读取上限只读开头", async () => {
	await writeFile(join(cwd, "big.log"), "a".repeat(600 * 1024));
	const read = await readSessionFile(cwd, "big.log");
	expect(read?.truncated).toBe(true);
	expect(read?.text.length).toBe(512 * 1024);
	expect(read?.bytes).toBe(600 * 1024);
});

it("目录外的路径不读：绝对路径、`..`、软链逃逸、文件夹、不存在的", async () => {
	await symlink(join(dir, "secret.txt"), join(cwd, "link.txt"));
	await symlink(dir, join(cwd, "up"));
	expect(await readSessionFile(cwd, join(dir, "secret.txt"))).toBeNull();
	expect(await readSessionFile(cwd, "../secret.txt")).toBeNull();
	expect(await readSessionFile(cwd, "link.txt")).toBeNull();
	expect(await readSessionFile(cwd, "up/secret.txt")).toBeNull();
	expect(await readSessionFile(cwd, "src")).toBeNull();
	expect(await readSessionFile(cwd, "missing.txt")).toBeNull();
	expect(await readSessionFile(cwd, "\\\\evil\\share\\a.png")).toBeNull();
});

it("提示词标出来源的文件在目录外也只读给：只认清单里那几个原路径，相对路径、软链借道、清单外的都不给", async () => {
	const memory = join(dir, "memory", "learned.md");
	await mkdir(join(dir, "memory"));
	await writeFile(memory, "- 记下的\n");
	await writeFile(join(dir, "memory", "MEMORY.md"), "清单外\n");
	await symlink(join(dir, "secret.txt"), join(dir, "memory", "alias.md"));
	const listed = [memory, join(dir, "memory", "missing.md")];
	expect(await readListedFile(listed, memory)).toMatchObject({ text: "- 记下的\n", truncated: false });
	expect(await readListedFile(listed, join(dir, "memory", "MEMORY.md"))).toBeNull();
	expect(await readListedFile(listed, join(dir, "secret.txt"))).toBeNull();
	expect(await readListedFile(listed, join(dir, "memory", "alias.md"))).toBeNull();
	expect(await readListedFile(listed, "learned.md")).toBeNull();
	expect(await readListedFile(listed, join(dir, "memory", "missing.md"))).toBeNull();
	expect(await readListedFile([join(dir, "memory")], join(dir, "memory"))).toBeNull();
	expect(await readListedFile([], memory)).toBeNull();
});

it("按路径发文件：只给工作目录里的文件，给的是解析过软链的真实路径", async () => {
	await symlink(join(dir, "secret.txt"), join(cwd, "link.txt"));
	expect(await sessionFilePath(cwd, "readme.md")).toBe(await realpath(join(cwd, "readme.md")));
	expect(await sessionFilePath(cwd, join(cwd, "src", "deep", "approvals.ts"))).toBe(await realpath(join(cwd, "src", "deep", "approvals.ts")));
	expect(await sessionFilePath(cwd, "../secret.txt")).toBeNull();
	expect(await sessionFilePath(cwd, join(dir, "secret.txt"))).toBeNull();
	expect(await sessionFilePath(cwd, "link.txt")).toBeNull();
	expect(await sessionFilePath(cwd, "src")).toBeNull();
	expect(await sessionFilePath(cwd, "missing.txt")).toBeNull();
});

it("找文件：按原样拼得上的直接给，裸文件名在目录里按结尾找，跳过 node_modules", async () => {
	expect(await locateSessionFiles(cwd, "readme.md")).toEqual([join(cwd, "readme.md")]);
	expect(await locateSessionFiles(cwd, "approvals.ts")).toEqual([join(cwd, "src", "deep", "approvals.ts")]);
	expect(await locateSessionFiles(cwd, "deep/approvals.ts")).toEqual([join(cwd, "src", "deep", "approvals.ts")]);
	expect(await locateSessionFiles(cwd, "src/")).toEqual([`${join(cwd, "src")}/`]);
	expect(await locateSessionFiles(cwd, "nothing.ts")).toEqual([]);
});

it("找文件：通配符、走出目录的 `..`、绝对路径都不找", async () => {
	expect(await locateSessionFiles(cwd, "*.ts")).toEqual([]);
	expect(await locateSessionFiles(cwd, "../secret.txt")).toEqual([]);
	expect(await locateSessionFiles(cwd, join(dir, "secret.txt"))).toEqual([]);
});

it("服务按会话的工作目录读和找；没有这个会话时什么都不给", async () => {
	const agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "model.json"), plugins: [], log: () => undefined });
	try {
		const session = await agent.service.createSession({ cwd });
		expect((await agent.service.readFile(session.id, "readme.md"))?.text).toBe("# 你好\n");
		expect(await agent.service.locateFiles(session.id, "approvals.ts")).toEqual([join(cwd, "src", "deep", "approvals.ts")]);
		expect(await agent.service.readFile("missing", "readme.md")).toBeNull();
		expect(await agent.service.locateFiles("missing", "approvals.ts")).toEqual([]);
		expect(await agent.filePath(session.id, "readme.md")).toBe(await realpath(join(cwd, "readme.md")));
		expect(await agent.filePath("missing", "readme.md")).toBeNull();
		const controller = new AbortController();
		const events = agent.service.watch({ signal: controller.signal });
		const pending = events.next();
		const moved = await agent.service.fileOperation(session.id, { type: "rename", from: "readme.md", to: "renamed.md" });
		expect((await pending).value).toEqual({ type: "fileMoved", from: join(cwd, "readme.md"), to: join(cwd, "renamed.md") });
		expect(moved).toMatchObject({ ok: true, path: join(cwd, "renamed.md") });
		controller.abort();
		await events.return();
	} finally {
		await agent.shutdown();
	}
});

it("文档完整读取守目录、版本和取消边界", async () => {
	const { readSessionFileBytes } = await import("../src/files.ts");
	const signal = new AbortController().signal;
	const view = await readSessionFile(cwd, "readme.md");
	expect(Buffer.from(await readSessionFileBytes(cwd, "readme.md", view!.modifiedAt, signal)).toString()).toBe("# 你好\n");
	await expect(readSessionFileBytes(cwd, "../secret.txt", undefined, signal)).rejects.toThrow();
	await expect(readSessionFileBytes(cwd, "readme.md", 0, signal)).rejects.toThrow();
	const cancelled = new AbortController();
	cancelled.abort();
	await expect(readSessionFileBytes(cwd, "readme.md", undefined, cancelled.signal)).rejects.toThrow();
});

it("目录按文件夹优先列出，不列软链，不能越界", async () => {
	const { listSessionDirectory } = await import("../src/files.ts");
	await symlink(dir, join(cwd, "outside"));
	const entries = await listSessionDirectory(cwd, cwd);
	expect(entries.some((entry) => entry.name === "outside")).toBe(false);
	expect(entries[0]?.isDirectory).toBe(true);
	await expect(listSessionDirectory(cwd, dir)).rejects.toThrow();
});

it("SQLite 文档快照包含尚未 checkpoint 的 WAL 提交", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { readSessionFileBytes } = await import("../src/files.ts");
	const path = join(cwd, "live.sqlite");
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items (name TEXT); INSERT INTO items VALUES ('latest')");
		const bytes = await readSessionFileBytes(cwd, path, undefined, new AbortController().signal);
		const copy = join(dir, "snapshot.db");
		await writeFile(copy, bytes);
		const snapshot = new DatabaseSync(copy, { readOnly: true });
		try {
			expect(snapshot.prepare("SELECT name FROM items").get()?.name).toBe("latest");
		} finally {
			snapshot.close();
		}
	} finally {
		db.close();
	}
});

it("源目录可以预览、列目录和改名；未登记目录、软链逃逸和根目录改名仍拒绝", async () => {
	const source = join(dir, "source");
	await mkdir(source);
	await writeFile(join(source, "a.txt"), "额外源文件");
	await symlink(join(dir, "secret.txt"), join(source, "escape.txt"));
	expect(await readSessionFile(cwd, join(source, "a.txt"))).toBeNull();
	expect((await readSessionFile(cwd, join(source, "a.txt"), [source]))?.text).toBe("额外源文件");
	expect(Buffer.from(await readSessionFileBytes(cwd, join(source, "a.txt"), undefined, new AbortController().signal, [source])).toString()).toBe("额外源文件");
	expect((await listSessionDirectory(cwd, source, [source])).map((entry) => entry.name)).toEqual(["a.txt"]);
	expect(await sessionFilePath(cwd, join(source, "escape.txt"), [source])).toBeNull();
	expect(await readSessionFile(cwd, "../secret.txt", [source])).toBeNull();
	expect(await operateSessionFile(cwd, { type: "rename", from: source, to: join(dir, "renamed") }, [source])).toMatchObject({ ok: false });
	expect(await operateSessionFile(cwd, { type: "rename", from: join(source, "a.txt"), to: join(source, "b.txt") }, [source])).toMatchObject({ ok: true });
});

it("@ 文件候选包含全部项目源目录，第二个源用绝对路径；任意 cwd 不扩大读取范围", async () => {
	const other = join(dir, "other");
	await mkdir(other);
	await writeFile(join(other, "notes.md"), "参考");
	const agent = await createAgent({ dataDir: join(dir, "mention-data"), settingsFile: join(dir, "mention-model.json"), plugins: [], log: () => {} });
	try {
		const project = await agent.service.createProject("多源项目", cwd, [cwd, other]);
		const entries = await agent.service.mentionFiles({ project: project.id }, undefined);
		expect(entries.find((entry) => entry.name === "readme.md")?.path).toBe("readme.md");
		expect(entries.find((entry) => entry.name === "notes.md")).toMatchObject({ path: join(other, "notes.md"), origin: "other" });
		expect(await agent.service.mentionFiles({ cwd: dir }, undefined)).toEqual([]);
		const session = await agent.service.createSession({ project: project.id });
		expect(await agent.service.mentionFiles({}, session.id)).toEqual(entries);
	} finally {
		await agent.shutdown();
	}
});
