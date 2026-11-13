/**
 * read 读图片：图交给模型，原样不缩放；太大的照实说，不当成读到了。BMP 照样交出（模型收不收由宿主发请求时换）。
 */

import { mkdtempSync, rmSync, truncateSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { ToolRun } from "@plume/contract";
import { readTool } from "../../src/tools/read.ts";
import { readRecord } from "../../src/tools/read-state.ts";
import { toDefinition, type ToolContext, type ToolResult } from "../../src/tools/types.ts";
import { withFiles } from "../files.ts";

const dir = mkdtempSync(join(tmpdir(), "plume-read-image-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("");
/** 一个 1×1 的 PNG。 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

it("PNG 原样交给模型，details 记下路径、大小、类型，并记作读过", async () => {
	writeFileSync(join(dir, "dot.png"), PNG);
	const ctx: ToolContext = withFiles(withFiles({ cwd: dir, state: new Map() }));
	const result = await readTool.execute({ path: "dot.png" }, ctx);
	expect(result.isError).toBeUndefined();
	expect(result.content).toEqual([]);
	expect(result.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
	expect(result.details).toEqual({
		kind: "image",
		path: "dot.png",
		bytes: PNG.length,
		mimeType: "image/png",
		fileView: { path: join(dir, "dot.png"), verbatim: true },
	});
	// 看过，但没读成文字：有记录、没时间戳，edit 照样要求先按文字读。
	const record = readRecord(ctx, realpathSync(join(dir, "dot.png")));
	expect(record).toBeDefined();
	expect(record?.stamp).toBeUndefined();
});

it("经工具表交出去时图跟在结果后面", async () => {
	writeFileSync(join(dir, "dot.jpg"), PNG);
	const { files, projectFiles, resources } = withFiles({ cwd: dir, state: new Map() });
	const definition = toDefinition(readTool, { state: () => new Map(), resources: resources!, workspace: { files: projectFiles, git: async () => null } });
	const run = {
		sessionId: "s",
		cwd: dir,
		scratchDir: join(dir, "scratch"),
		signal: new AbortController().signal,
		tools: () => [],
		files,
	} as unknown as ToolRun;
	const output = await definition.execute({ path: "dot.jpg" }, run);
	expect(output).toMatchObject({ output: "", images: [{ data: PNG.toString("base64"), mimeType: "image/jpeg" }] });
});

it("超过 5 MB 的图不读", async () => {
	const big = join(dir, "big.png");
	writeFileSync(big, "");
	truncateSync(big, 5 * 1024 * 1024 + 1);
	const result = await readTool.execute({ path: "big.png" }, withFiles({ cwd: dir, state: new Map() }));
	expect(result.isError).toBe(true);
	expect(textOf(result)).toBe("Image is 5.0 MB, above the 5 MB limit.");
	expect(result.images).toBeUndefined();
});

it("BMP 和别的图一样交出去", async () => {
	const bmp = Buffer.from("BM\0\0\0\0");
	writeFileSync(join(dir, "old.bmp"), bmp);
	const ctx: ToolContext = withFiles(withFiles({ cwd: dir, state: new Map() }));
	const result = await readTool.execute({ path: "old.bmp" }, ctx);
	expect(result.isError).toBeUndefined();
	expect(result.images).toEqual([{ data: bmp.toString("base64"), mimeType: "image/bmp" }]);
	expect(readRecord(ctx, realpathSync(join(dir, "old.bmp")))).toBeDefined();
});
