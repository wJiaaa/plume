import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PluginContext } from "@plume/contract";
import { afterEach, beforeEach, expect, it } from "vitest";
import { utils, write } from "xlsx";
import plugin from "../src/index.ts";
import { readDatabase, readWorkbook } from "../src/readers.ts";
import type { DocumentsApi } from "../src/api.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-documents-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

it("工作表保留第一行、空行、格式化数字和多表，并限制预览行数", async () => {
	const workbook = utils.book_new();
	const sheet = utils.aoa_to_sheet([["名称", "数量"], [], ["示例", 0.25]]);
	sheet.B3!.z = "0%";
	utils.book_append_sheet(workbook, sheet, "数据");
	utils.book_append_sheet(workbook, utils.aoa_to_sheet(Array.from({ length: 2100 }, (_, n) => [n])), "长表");
	const path = join(dir, "data.xlsx");
	await writeFile(path, write(workbook, { type: "buffer", bookType: "xlsx" }));
	const data = await readWorkbook(path);
	expect(data.sheets[0]).toMatchObject({
		name: "数据",
		columns: ["A", "B"],
		rows: [
			["名称", "数量"],
			["", ""],
			["示例", "25%"],
		],
	});
	expect(data.sheets[1]?.rows).toHaveLength(2000);
	expect(data.sheets[1]?.total).toBe(2100);
});

it("SQLite 支持空表、带引号的表名、大整数和 BLOB，原件不改变", async () => {
	const path = join(dir, "database.sqlite");
	const db = new DatabaseSync(path);
	db.exec(`CREATE TABLE "a""b" (value INTEGER, data BLOB); INSERT INTO "a""b" VALUES (9223372036854775807, X'0102'); CREATE TABLE empty (name TEXT);`);
	db.close();
	const before = await readFile(path);
	const data = readDatabase(path, "[{n} bytes]");
	expect(data.sheets[0]?.rows).toEqual([["9223372036854775807", "[2 bytes]"]]);
	expect(data.sheets[1]).toMatchObject({ name: "empty", columns: ["name"], rows: [], total: 0 });
	expect(await readFile(path)).toEqual(before);
});

it("解析服务使用隔离进程，超时和取消后清理临时文件", async () => {
	let api!: DocumentsApi;
	const effects: Array<() => void> = [];
	plugin.apply({
		dataDir: dir,
		locale: () => "zh-CN",
		effect: (fn: () => void) => effects.push(fn),
		serve: (value: DocumentsApi) => {
			api = value;
		},
	} as unknown as PluginContext);
	const path = join(dir, "slow.db");
	const db = new DatabaseSync(path);
	db.exec("CREATE VIEW slow AS WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n");
	db.close();
	const bytes = await readFile(path);
	await expect(api.sheets(bytes, true, { signal: new AbortController().signal })).rejects.toThrow("5 秒");
	const controller = new AbortController();
	const call = api.sheets(bytes, true, { signal: controller.signal });
	setTimeout(() => controller.abort(), 100);
	await expect(call).rejects.toThrow(/cancelled/);
	const { readdir } = await import("node:fs/promises");
	expect(await readdir(dir)).toEqual(["slow.db"]);
	for (const dispose of effects) dispose();
}, 15_000);
