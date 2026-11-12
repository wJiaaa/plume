/**
 * 工具经资源地址读写：read、ls 经本体（`ToolRun.files.read`）认地址，write、edit 只认 `scratch://`。
 * 地址本身的解析、路由和各个 scheme 的边界在本体 `packages/core/workspace/test/resources.test.ts` 里测。
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ResourceHandler } from "@plume/contract";
import { editTool } from "../../src/tools/edit.ts";
import { lsTool } from "../../src/tools/ls.ts";
import { readTool } from "../../src/tools/read.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import { writeTool } from "../../src/tools/write.ts";
import { withFiles } from "../files.ts";

let root: string;
let scratchDir: string;
let skillDir: string;

/** 一个只读、能列目录、给出位置的 scheme，代替别的插件登记的那种（技能插件的 `skill://`）。 */
const docsResource = (): ResourceHandler => ({
	scheme: "docs",
	describe: "`docs://<名字>` 一份文档",
	async resolve(url) {
		return { url: url.raw, content: "第一行\n第二行\n第三行", contentType: "text/plain" };
	},
	async list() {
		return [{ value: "docs://guide", description: "指南" }];
	},
	async locate(url) {
		return url.segments.length === 0 ? null : join(skillDir, ...url.segments);
	},
});

const toolCtx = () => withFiles({ cwd: root, sessionId: "s1", state: new Map(), scratchDir, handlers: [docsResource()] });
const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("");

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "plume-res-"));
	scratchDir = join(root, "scratch");
	skillDir = join(root, "skills", "pdf");
	await mkdir(join(skillDir, "references"), { recursive: true });
	await mkdir(scratchDir, { recursive: true });
	await writeFile(join(skillDir, "references", "03-guide.md"), "# 指南\n");
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

it("read 认地址：别处来的包进 resource 标签；没人认的 scheme 当路径报找不到", async () => {
	const c = toolCtx();
	const viaAddress = await readTool.execute({ path: "docs://guide" } as never, c);
	expect(textOf(viaAddress)).toBe("[docs://guide]\n第一行\n第二行\n第三行");

	const address = c.resources.keepArtifact("s1", "bash", "第一行\n第二行");
	const artifact = await readTool.execute({ path: address, offset: 2 } as never, c);
	expect(textOf(artifact)).toMatch(/^<resource url="artifact:\/\/a[0-9a-f]{12}" origin="bash 的原始输出">\n2→第二行\n<\/resource>$/);

	const unknown = await readTool.execute({ path: "acme://thing" } as never, c);
	expect(unknown.isError).toBe(true);
	expect(textOf(unknown)).toMatch(/File not found/);
});

it("write 经地址写进临时目录，写别的地址被拒", async () => {
	const ok = await writeTool.execute({ path: "scratch://from-tool.md", content: "内容" }, toolCtx());
	expect(ok.isError).toBeUndefined();
	expect(await readFile(join(scratchDir, "from-tool.md"), "utf8")).toBe("内容");
	const refused = await writeTool.execute({ path: "docs://guide", content: "改掉" }, toolCtx());
	expect(refused.isError).toBe(true);
	expect(textOf(refused)).toMatch(/只读/);
});

it("edit 认 scratch://：write 或 read 过同一个地址之后能改", async () => {
	const c = toolCtx();
	await writeTool.execute({ path: "scratch://probe.ts", content: "const size = 1;\n" }, c);
	const afterWrite = await editTool.execute({ path: "scratch://probe.ts", old_string: "1", new_string: "2" }, c);
	expect(afterWrite.isError, textOf(afterWrite)).toBeUndefined();
	expect(textOf(afterWrite)).toMatch(/^Edited scratch:\/\/probe\.ts:/);

	// 命令写出来的：还没看过，读一遍地址就好。
	await writeFile(join(scratchDir, "made-by-bash.ts"), "let x = 1;\n");
	const unread = await editTool.execute({ path: "scratch://made-by-bash.ts", old_string: "1", new_string: "2" }, c);
	expect(unread.isError).toBe(true);
	await readTool.execute({ path: "scratch://made-by-bash.ts" } as never, c);
	const afterRead = await editTool.execute({ path: "scratch://made-by-bash.ts", old_string: "1", new_string: "2" }, c);
	expect(afterRead.isError, textOf(afterRead)).toBeUndefined();
	expect(await readFile(join(scratchDir, "made-by-bash.ts"), "utf8")).toBe("let x = 2;\n");
});

it("write、edit 经临时目录里的软链出不去", async () => {
	const target = await mkdtemp(join(tmpdir(), "plume-scratch-write-out-"));
	try {
		await writeFile(join(target, "credentials"), "secret");
		await symlink(target, join(scratchDir, "write-out"));
		const written = await writeTool.execute({ path: "scratch://write-out/credentials", content: "overwritten" }, toolCtx());
		expect(written.isError).toBe(true);
		expect(textOf(written)).toMatch(/临时目录外面/);
		expect(await readFile(join(target, "credentials"), "utf8")).toBe("secret");
	} finally {
		await rm(join(scratchDir, "write-out"), { force: true });
		await rm(target, { recursive: true, force: true });
	}
});

it("ls 认地址给的位置：临时目录、别的 scheme 的目录；经软链出去的报原因", async () => {
	const c = toolCtx();
	await writeTool.execute({ path: "scratch://listed/page.html", content: "<h1>hi</h1>" }, c);
	const top = await lsTool.execute({ path: "scratch://" }, c);
	expect(top.isError, textOf(top)).toBeUndefined();
	expect(textOf(top)).toMatch(/^listed\/$/m);
	expect(textOf(await lsTool.execute({ path: "scratch://listed" }, c))).toMatch(/^page\.html {2}\(/m);
	expect(textOf(await lsTool.execute({ path: "docs://references" }, c))).toMatch(/03-guide\.md/);

	const target = await mkdtemp(join(tmpdir(), "plume-scratch-ls-out-"));
	try {
		await symlink(target, join(scratchDir, "ls-out"));
		const result = await lsTool.execute({ path: "scratch://ls-out" }, c);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/临时目录外面/);
	} finally {
		await rm(join(scratchDir, "ls-out"), { force: true });
		await rm(target, { recursive: true, force: true });
	}
});

it("没有登记表的环境（直接调工具）把地址当普通路径", async () => {
	const { resources: _resources, ...bare } = withFiles({ cwd: root, state: new Map() });
	const result = await readTool.execute({ path: "scratch://x" } as never, bare);
	expect(result.isError).toBe(true);
	expect(textOf(result)).toMatch(/File not found/);
});
