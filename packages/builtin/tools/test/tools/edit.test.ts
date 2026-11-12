/**
 * 经 `editTool.execute` 端到端测 edit。
 *
 * 不拆开测各个部件：最容易坏的是接缝——读过的记录、过期检查、改完重新记下（同一轮第二次编辑靠它）。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { editTool } from "../../src/tools/edit.ts";
import { readTool } from "../../src/tools/read.ts";
import { writeTool } from "../../src/tools/write.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";
import { withFiles } from "../files.ts";

type ApprovalContent = Parameters<NonNullable<ToolContext["requestApproval"]>>[0];

const FIVE = "alpha\nbravo\ncharlie\ndelta\necho\n";

async function tempDir(root: string, prefix: string): Promise<string> {
	const dir = await mkdtemp(join(root, prefix));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function fixture(content = FIVE): Promise<{ dir: string; file: string; ctx: ToolContext }> {
	const dir = await tempDir(tmpdir(), "plume-edit-");
	const file = join(dir, "sample.txt");
	await writeFile(file, content, "utf8");
	return { dir, file, ctx: withFiles({ cwd: dir, state: new Map() }) };
}

/** 先读，和模型必须做的一样。 */
async function read(ctx: ToolContext, file: string, args: Record<string, unknown> = {}) {
	return await readTool.execute({ path: file, ...args } as never, ctx);
}

const textOf = (res: ToolResult) => res.content.map((part) => part.text).join("");

it("read 的结果头部是路径，每行带行号", async () => {
	const { file, ctx } = await fixture();
	const text = textOf(await read(ctx, file));
	expect(text).toMatch(/^\[sample\.txt\]\n/);
	expect(text).toMatch(/1→alpha/);
	expect(text).toMatch(/5→echo/);
});

it("唯一的匹配被替换", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	const res = await editTool.execute({ path: file, old_string: "bravo", new_string: "BRAVO" }, ctx);
	expect(res.isError, textOf(res)).toBeUndefined();
	expect(await readFile(file, "utf8")).toBe("alpha\nBRAVO\ncharlie\ndelta\necho\n");
});

it("很长的一行里换一个词，不用重打整行", async () => {
	// 一段一行的 LaTeX 里换一个词，只给那个词前后几个字，整行其余部分一个字不能动。
	const line = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
	const { file, ctx } = await fixture(`intro\n${line}\noutro\n`);
	await read(ctx, file);
	const res = await editTool.execute({ path: file, old_string: "word117 word118", new_string: "word117 swapped" }, ctx);
	expect(res.isError, textOf(res)).toBeUndefined();
	expect(await readFile(file, "utf8")).toBe(`intro\n${line.replace("word117 word118", "word117 swapped")}\noutro\n`);
});

it("new_string 照字面写入，`$` 序列也一样", async () => {
	// `String.replace` 会把替换串里的 `$$`、`$&`、`` $` ``、`$'` 当模式，shell 和模板代码会被改写。
	const { file, ctx } = await fixture("alpha\nPLACEHOLDER\ncharlie\n");
	await read(ctx, file);
	const literal = "echo $$ and $& and $` and $' and $1";
	const res = await editTool.execute({ path: file, old_string: "PLACEHOLDER", new_string: literal }, ctx);
	expect(res.isError).toBeUndefined();
	expect(await readFile(file, "utf8")).toBe(`alpha\n${literal}\ncharlie\n`);
});

it("同一轮多次编辑，每次看到的都是上一次留下的文件", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	const first = await editTool.execute({ path: file, old_string: "alpha", new_string: "ALPHA" }, ctx);
	expect(textOf(first), "结果里带回改后的样子，省掉一次重读").toMatch(/Now reads:\n1→ALPHA/);
	const second = await editTool.execute({ path: file, old_string: "echo", new_string: "ECHO" }, ctx);
	expect(second.isError, textOf(second)).toBeUndefined();
	expect(await readFile(file, "utf8")).toBe("ALPHA\nbravo\ncharlie\ndelta\nECHO\n");
});

it("读过之后被改过的文件不编辑", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	// 读和编辑之间别人动了文件。同一毫秒内大小不变的改动会漏掉，见 `changedSince`。
	await writeFile(file, "alpha\nbravo\ncharlie\ndelta\nECHO!\n", "utf8");
	const res = await editTool.execute({ path: file, old_string: "bravo", new_string: "BRAVO" }, ctx);
	expect(res.isError).toBe(true);
	expect(textOf(res)).toMatch(/changed since you read it/);
	expect(await readFile(file, "utf8"), "文件不能被动过").toBe("alpha\nbravo\ncharlie\ndelta\nECHO!\n");
});

it("文件里没有的文本被拒，并提示行号前缀", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	const res = await editTool.execute({ path: file, old_string: "foxtrot", new_string: "BRAVO" }, ctx);
	expect(res.isError).toBe(true);
	expect(textOf(res)).toMatch(/not found[\s\S]*line-number prefix/);
});

it("有歧义的匹配要更多上下文，replace_all 全换", async () => {
	const { file, ctx } = await fixture("dup\ndup\n");
	await read(ctx, file);
	const res = await editTool.execute({ path: file, old_string: "dup", new_string: "x" }, ctx);
	expect(res.isError).toBe(true);
	expect(textOf(res)).toMatch(/appears 2 times[\s\S]*surrounding text/);
	const all = await editTool.execute({ path: file, old_string: "dup", new_string: "x", replace_all: true }, ctx);
	expect(all.isError, textOf(all)).toBeUndefined();
	expect(await readFile(file, "utf8")).toBe("x\nx\n");
});

it("没先读就编辑被拒", async () => {
	const { file, ctx } = await fixture();
	const res = await editTool.execute({ path: file, old_string: "bravo", new_string: "x" }, ctx);
	expect(res.isError).toBe(true);
	expect(textOf(res)).toMatch(/Read .* before editing/);
});

it("没给 old_string 的编辑被拒，不去猜", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	const res = await editTool.execute({ path: file, new_string: "x" } as never, ctx);
	expect(res.isError).toBe(true);
	expect(await readFile(file, "utf8")).toBe(FIVE);
});

it("工作区外明确交过来的文件读得到，改它照样要问", async () => {
	// 放在家目录下而不是临时目录：临时目录本来就可读，拿它当「工作区外」测不出边界。
	const externalDir = await tempDir(homedir(), ".plume-test-external-");
	const externalFile = join(externalDir, "external.txt");
	await writeFile(externalFile, FIVE, "utf8");

	const workspaceDir = await tempDir(tmpdir(), "plume-ws-");
	const ctxWithoutAllowed: ToolContext = withFiles({ cwd: workspaceDir, state: new Map() });
	const ctxWithAllowed: ToolContext = withFiles({ ...ctxWithoutAllowed, allowedPaths: [externalFile] });

	// 没有 allowedPaths、也没人可问：拒绝。
	const deniedRead = await readTool.execute({ path: externalFile } as never, ctxWithoutAllowed);
	expect(deniedRead.isError).toBe(true);
	expect(textOf(deniedRead)).toMatch(/没有可以询问的人/);

	const readRes = await readTool.execute({ path: externalFile } as never, ctxWithAllowed);
	expect(readRes.isError).toBeUndefined();

	// 附件是「看看这个」，不是「可以改它」：附件给的是读的许可，不替人答改不改。
	const asked: string[] = [];
	const editRes = await editTool.execute(
		{ path: externalFile, old_string: "bravo", new_string: "BRAVO_EXTERNAL" },
		withFiles({ ...ctxWithAllowed, allowedPaths: [externalFile], requestApproval: async (request) => (asked.push(request.subject ?? ""), "reject") }),
	);
	expect(asked.length, "附件给的是读的许可，改它照样要问").toBe(1);
	expect(editRes.isError).toBe(true);
	expect(await readFile(externalFile, "utf8"), "人拒绝了，文件一个字都不该被动过").toBe(FIVE);
});

it("附件也不是覆写它的许可", async () => {
	// `write` 和 `edit` 是同一条边界上的两个入口，堵一个不堵另一个等于没堵。
	const externalDir = await tempDir(tmpdir(), "plume-external-");
	const externalFile = join(externalDir, "external.txt");
	await writeFile(externalFile, FIVE, "utf8");
	const workspaceDir = await tempDir(tmpdir(), "plume-ws-");
	const asked: string[] = [];
	const ctx: ToolContext = withFiles({
		cwd: workspaceDir,
		state: new Map(),
		allowedPaths: [externalFile],
		requestApproval: async (request) => (asked.push(request.subject ?? ""), "reject"),
	});

	// 先读：`write` 对已存在的文件要求先读过，不读会撞上另一条规则而不是边界本身。
	await readTool.execute({ path: externalFile } as never, ctx);
	const written = await writeTool.execute({ path: externalFile, content: "OVERWRITTEN" } as never, ctx);

	expect(asked.length, "附件给的是读的许可，覆写它照样要问").toBe(1);
	expect(written.isError).toBe(true);
	expect(await readFile(externalFile, "utf8"), "人拒绝了，文件一个字都不该被动过").toBe(FIVE);
});

/*
 * 工作区外的写走同一张审批卡，人点了允许就写到那里。直接报越界的话，模型会改用 `cat > … <<EOF`，
 * 卡片上就没有 diff。
 */
it("工作区外的写要问，允许后写到那里", async () => {
	const externalDir = await tempDir(homedir(), ".plume-test-external-");
	const target = join(externalDir, "notes", "summary.md");
	const workspaceDir = await tempDir(tmpdir(), "plume-ws-");
	const requests: ApprovalContent[] = [];
	const ctx: ToolContext = withFiles({
		cwd: workspaceDir,
		state: new Map(),
		requestApproval: async (request) => (requests.push(request), "once"),
	});

	const written = await writeTool.execute({ path: target, content: "hello\n" } as never, ctx);
	expect(written.isError, JSON.stringify(written.content)).toBeUndefined();
	expect(await readFile(target, "utf8")).toBe("hello\n");
	expect(requests.length).toBe(1);
	expect(requests[0]?.title, "卡片上要写出完整的外部路径，不是一个相对名字").toBe(`Create ${target}`);
	expect(requests[0]?.detail ?? "", "卡片上要有 diff").toMatch(/\+hello/);

	const edited = await editTool.execute({ path: target, old_string: "hello", new_string: "bye" } as never, ctx);
	expect(edited.isError, JSON.stringify(edited.content)).toBeUndefined();
	expect(await readFile(target, "utf8")).toBe("bye\n");
	expect(requests.length).toBe(2);
});

it("刚写的文件同一轮里能直接编辑，不用先空读一次", async () => {
	const dir = await tempDir(tmpdir(), "plume-write-edit-");
	const ctx: ToolContext = withFiles({ cwd: dir, state: new Map() });
	const created = await writeTool.execute({ path: "Sample.ts", content: "export const answer = 1;\n" } as never, ctx);
	expect(created.isError, textOf(created)).toBeUndefined();
	const edited = await editTool.execute({ path: "Sample.ts", old_string: "answer = 1", new_string: "answer = 2" }, ctx);
	expect(edited.isError, textOf(edited)).toBeUndefined();
	expect(await readFile(join(dir, "Sample.ts"), "utf8")).toBe("export const answer = 2;\n");
});
