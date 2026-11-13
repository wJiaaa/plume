/**
 * edit / write 落盘时的安全性：读过的记录、审批期间文件被换、并发、链接、换行和编码。
 *
 * 这些都是「改错了文件或改丢了别人的改动」的路，结果要么照常写对，要么一个字节都不动。
 */

import { mkdtemp, readFile, writeFile, rm, mkdir, rename, symlink, link, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, it, onTestFinished } from "vitest";
import { editTool } from "../../src/tools/edit.ts";
import { readTool } from "../../src/tools/read.ts";
import { writeTool } from "../../src/tools/write.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";
import { withFiles } from "../files.ts";

const text = (result: ToolResult) => result.content.map((part) => part.text).join("\n");

async function fixture(content = "a\nb\nc\nd\n") {
	const cwd = await mkdtemp(join(tmpdir(), "plume-edit-safety-"));
	onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	const path = join(cwd, "sample.txt");
	await writeFile(path, content);
	const ctx: ToolContext = withFiles({ cwd, state: new Map() });
	return { cwd, path, ctx };
}

/** `Promise.withResolvers` 在 ES2024 才有，这里的 lib 是 ES2023。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => (resolve = done));
	return { promise, resolve };
}

it("模型自己要的窗口，窗口外也能改", async () => {
	const { path, ctx } = await fixture("a\nb\nc\nd\n");
	await readTool.execute({ path, offset: 1, limit: 2 }, ctx);
	// 不记哪几行显示过，只看最近一次读是不是没要求就被截短了。
	expect((await editTool.execute({ path, old_string: "c\nd", new_string: "C\nD" }, ctx)).isError).not.toBe(true);
	expect(await readFile(path, "utf8")).toBe("a\nb\nC\nD\n");
});

it("编辑结果带回改动处现在的样子，下一次编辑不用先重读", async () => {
	const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
	const { path, ctx } = await fixture(original);
	await readTool.execute({ path }, ctx);
	const shown = text(await editTool.execute({ path, old_string: "line 3\n", new_string: "line 3\nx1\nx2\n" }, ctx));
	// 改动处加上下各一行。
	expect(shown).toMatch(/^3→line 3\n4→x1\n5→x2\n6→line 4$/m);
	expect(shown, "离改动远的行不回显").not.toMatch(/line 10/);
});

it("改动太大时只给新行号范围，不把整段回显", async () => {
	const { path, ctx } = await fixture("a\nb\n");
	await readTool.execute({ path }, ctx);
	const payload = Array.from({ length: 80 }, (_, i) => `n${i}\n`).join("");
	const shown = text(await editTool.execute({ path, old_string: "a\n", new_string: `a\n${payload}` }, ctx));
	expect(shown).toMatch(/Changed regions now at lines 1-82/);
	expect(shown).not.toMatch(/n40/);
});

it("读过的记录过期了就拒绝编辑，重读后才行", async () => {
	const { path, ctx } = await fixture();
	await readTool.execute({ path }, ctx);
	const changed = "USER\na\nb\nc\nd\n";
	await writeFile(path, changed);
	expect((await editTool.execute({ path, old_string: "USER", new_string: "bad" }, ctx)).isError).toBe(true);
	expect(await readFile(path, "utf8")).toBe(changed);
	await readTool.execute({ path }, ctx);
	expect((await editTool.execute({ path, old_string: "a\n", new_string: "A\n" }, ctx)).isError).not.toBe(true);
});

it("替换串里的 $ 表达式照字面保留", async () => {
	const { path, ctx } = await fixture("OLD");
	await readTool.execute({ path }, ctx);
	const replacement = "$& $$ $` $'";
	expect((await editTool.execute({ path, old_string: "OLD", new_string: replacement }, ctx)).isError).not.toBe(true);
	expect(await readFile(path, "utf8")).toBe(replacement);
});

it("重叠的匹配算有歧义，除非明确 replace_all", async () => {
	const { path, ctx } = await fixture("aaa");
	await readTool.execute({ path }, ctx);
	expect((await editTool.execute({ path, old_string: "aa", new_string: "X" }, ctx)).isError).toBe(true);
	expect(await readFile(path, "utf8")).toBe("aaa");
	expect((await editTool.execute({ path, old_string: "aa", new_string: "X", replace_all: true }, ctx)).isError).not.toBe(true);
	expect(await readFile(path, "utf8")).toBe("Xa");
});

it("编辑保留 CRLF 和缺失的末尾换行", async () => {
	const { path, ctx } = await fixture("a\r\nb\r\nc");
	await readTool.execute({ path }, ctx);
	expect((await editTool.execute({ path, old_string: "b\nc", new_string: "B\nc\nD" }, ctx)).isError).not.toBe(true);
	expect(await readFile(path, "utf8")).toBe("a\r\nB\r\nc\r\nD");
});

it("审批期间路径被换成内容相同的另一个文件：不写", async () => {
	const { path, ctx, cwd } = await fixture();
	await readTool.execute({ path }, ctx);
	ctx.requestApproval = async () => {
		await rename(path, join(cwd, "original.txt"));
		await writeFile(path, "a\nb\nc\nd\n");
		return "once";
	};
	expect((await editTool.execute({ path, old_string: "a", new_string: "A" }, ctx)).isError).toBe(true);
	expect(await readFile(path, "utf8")).toBe("a\nb\nc\nd\n");
});

it("并发的 edit 和 write 排同一个文件队列，两处改动都保留", async () => {
	const { path, ctx } = await fixture();
	await readTool.execute({ path }, ctx);
	const entered = deferred(),
		release = deferred();
	let approvals = 0;
	ctx.requestApproval = async () => {
		if (++approvals === 1) {
			entered.resolve();
			await release.promise;
		}
		return "once";
	};
	const first = writeTool.execute({ path, content: "a\nb\nc\nwritten\n" }, ctx);
	await entered.promise;
	const second = editTool.execute({ path, old_string: "a", new_string: "A" }, ctx);
	release.resolve();
	const results = await Promise.all([first, second]);
	expect(
		results.every((result) => !result.isError),
		results.map(text).join("\n"),
	).toBe(true);
	expect(await readFile(path, "utf8")).toBe("A\nb\nc\nwritten\n");
});

it("读一张图片不等于可以按文本编辑或覆写它", async () => {
	// Plume 的 read 读图片直接报错，不记读过；这里守的是 edit/write 照样不放行。
	const { cwd, ctx } = await fixture();
	const path = join(cwd, "image.png"),
		bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
	await writeFile(path, bytes);
	await readTool.execute({ path }, ctx);
	expect((await editTool.execute({ path, old_string: "PNG", new_string: "bad" }, ctx)).isError).toBe(true);
	expect((await writeTool.execute({ path, content: "bad" }, ctx)).isError).toBe(true);
	expect(await readFile(path)).toEqual(bytes);
});

it("抽字读出的文档和不合法的 UTF-8 不能当文本覆写", async () => {
	const { cwd, ctx } = await fixture();
	const document = zipSync({
		"word/document.xml": strToU8(
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>TEXT</w:t></w:r></w:p></w:body></w:document>',
		),
	});
	for (const [name, bytes] of [
		["sample.docx", document],
		["invalid.txt", Buffer.from([0xc3, 0x28])],
	] as const) {
		const path = join(cwd, name);
		await writeFile(path, bytes);
		const read = await readTool.execute({ path }, ctx);
		if (name.endsWith("docx")) {
			expect(read.isError).not.toBe(true);
			expect(text(read)).toMatch(/TEXT/);
		}
		expect((await writeTool.execute({ path, content: "bad" }, ctx)).isError).toBe(true);
		expect((await editTool.execute({ path, old_string: "TEXT", new_string: "bad" }, ctx)).isError).toBe(true);
		expect(await readFile(path)).toEqual(Buffer.from(bytes));
	}
});

it.skipIf(process.platform === "win32")("同一文件的别名共享读过的记录，写不能借链接逃出工作区", async () => {
	const { cwd, path, ctx: outer } = await fixture();
	const project = join(cwd, "project");
	await mkdir(project);
	const inside = join(project, "inside.txt");
	await writeFile(inside, "before");
	await symlink(inside, join(project, "alias.txt"));
	const ctx = withFiles({ ...outer, cwd: project });
	await readTool.execute({ path: "alias.txt" }, ctx);
	expect((await editTool.execute({ path: inside, old_string: "before", new_string: "after" }, ctx)).isError).not.toBe(true);
	await symlink(path, join(project, "escape.txt"));
	await readTool.execute({ path: "escape.txt" }, ctx);
	// 工作区外本身可以写（要问），但借一个看起来在工作区里的名字写出去不行：审批卡上只会写着这个名字。
	const escaped = await editTool.execute({ path: "escape.txt", old_string: "a", new_string: "bad" }, ctx);
	expect(escaped.isError).toBe(true);
	expect(text(escaped)).toMatch(/is a link to .*outside the workspace/);
	expect(await readFile(path, "utf8")).toBe("a\nb\nc\nd\n");
});

it("硬链接共用一个队列，保留 inode，另一个会话过期的编辑被拒", async () => {
	const { cwd, path, ctx } = await fixture();
	const alias = join(cwd, "hard.txt");
	await link(path, alias);
	if (process.platform !== "win32") await chmod(path, 0o755);
	const before = await stat(path);
	const other: ToolContext = { ...ctx, state: new Map() };
	await readTool.execute({ path }, ctx);
	await readTool.execute({ path: alias }, other);
	const entered = deferred(),
		release = deferred();
	ctx.requestApproval = async () => {
		entered.resolve();
		await release.promise;
		return "once";
	};
	const first = editTool.execute({ path, old_string: "a", new_string: "first" }, ctx);
	await entered.promise;
	let secondFinished = false;
	const second = editTool.execute({ path: alias, old_string: "b", new_string: "second" }, other).then((result) => {
		secondFinished = true;
		return result;
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(secondFinished).toBe(false);
	} finally {
		release.resolve();
	}
	expect((await first).isError).not.toBe(true);
	expect((await second).isError).toBe(true);
	expect(await readFile(alias, "utf8")).toBe("first\nb\nc\nd\n");
	const after = await stat(alias);
	expect(after.ino).toBe(before.ino);
	expect(after.mode).toBe(before.mode);
});

it("审批期间内容变了、或新文件被别人建了：不覆写", async () => {
	const { cwd, path, ctx } = await fixture();
	await readTool.execute({ path }, ctx);
	ctx.requestApproval = async () => {
		await writeFile(path, "external");
		return "once";
	};
	expect((await editTool.execute({ path, old_string: "a", new_string: "A" }, ctx)).isError).toBe(true);
	expect(await readFile(path, "utf8")).toBe("external");
	const created = join(cwd, "new.txt");
	ctx.requestApproval = async () => {
		await writeFile(created, "external");
		return "once";
	};
	expect((await writeTool.execute({ path: created, content: "bad" }, ctx)).isError).toBe(true);
	expect(await readFile(created, "utf8")).toBe("external");
});

it("拒绝和取消不动字节，并释放队列", async () => {
	const { path, ctx } = await fixture();
	await readTool.execute({ path }, ctx);
	ctx.requestApproval = async () => "reject";
	expect((await editTool.execute({ path, old_string: "a", new_string: "A" }, ctx)).isError).toBe(true);
	// 取消信号是一次调用的（`ToolRun.signal`），换一次调用。
	const controller = new AbortController();
	const cancelled = withFiles({
		...ctx,
		signal: controller.signal,
		requestApproval: async () => {
			controller.abort();
			return "once";
		},
	});
	expect((await writeTool.execute({ path, content: "bad" }, cancelled)).isError).toBe(true);
	expect(await readFile(path, "utf8")).toBe("a\nb\nc\nd\n");
	const next = withFiles({ ...ctx, requestApproval: undefined });
	expect((await editTool.execute({ path, old_string: "a", new_string: "A" }, next)).isError).not.toBe(true);
});

it("空的 old_string 指向 write；把全部换成空，文件剩零字节", async () => {
	const { path, ctx } = await fixture("first\nsecond");
	await readTool.execute({ path }, ctx);
	expect(text(await editTool.execute({ path, old_string: "", new_string: "x" }, ctx))).toMatch(/use `write`/);
	expect((await editTool.execute({ path, old_string: "first\nsecond", new_string: "" }, ctx)).isError).not.toBe(true);
	expect((await stat(path)).size).toBe(0);
});
