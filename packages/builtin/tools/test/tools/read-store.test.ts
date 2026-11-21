/**
 * 读过的记录存盘：重启（换一份内存里的状态，从同一个数据目录装回来）以后，改刚读过的文件不用重读；读完以后被改过的照样拦下。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { editTool } from "../../src/tools/edit.ts";
import { readTool } from "../../src/tools/read.ts";
import { readStore } from "../../src/tools/read-store.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import { withFiles } from "../files.ts";

const textOf = (res: ToolResult) => res.content.map((part) => part.text).join("");

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "plume-read-store-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const dataDir = join(dir, "data");
	const file = join(dir, "sample.txt");
	await writeFile(file, "alpha\nbravo\n", "utf8");
	/** 一次进程：新的一份状态，从数据目录装回读过的记录。 */
	const boot = () => {
		const state = new Map<string, unknown>();
		readStore(dataDir, (error) => {
			throw error;
		}).attach(state, "s1");
		return withFiles({ cwd: dir, state });
	};
	const saved = join(dataDir, "read-files", "s1.json");
	return { file, boot, saved };
}

it("重启以后改读过的文件不用重读", async () => {
	const { file, boot, saved } = await setup();
	await readTool.execute({ path: file } as never, boot());
	await vi.waitFor(() => expect(existsSync(saved)).toBe(true));

	const res = await editTool.execute({ path: file, old_string: "bravo", new_string: "BRAVO" }, boot());
	expect(res.isError, textOf(res)).toBeUndefined();
	expect(await readFile(file, "utf8")).toBe("alpha\nBRAVO\n");
});

it("重启以后，读完又被改过的文件照样要重读", async () => {
	const { file, boot, saved } = await setup();
	await readTool.execute({ path: file } as never, boot());
	await vi.waitFor(() => expect(existsSync(saved)).toBe(true));
	await writeFile(file, "alpha\nbravo\ncharlie\n", "utf8");

	const res = await editTool.execute({ path: file, old_string: "bravo", new_string: "BRAVO" }, boot());
	expect(res.isError).toBe(true);
	expect(textOf(res)).toMatch(/changed since you read it/);
});

it("会话删掉时删掉它的记录", async () => {
	const { file, boot, saved } = await setup();
	await readTool.execute({ path: file } as never, boot());
	await vi.waitFor(() => expect(existsSync(saved)).toBe(true));
	await readStore(join(saved, "..", ".."), () => {}).forget("s1");
	expect(existsSync(saved)).toBe(false);
});
