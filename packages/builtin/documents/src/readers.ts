import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { Sheet, Sheets } from "./api.ts";

const MAX_ROWS = 2000;
const MAX_COLUMNS = 64;

/** 只读预览保留表格列号，不把第一行猜成标题而吃掉数据。 */
export async function readWorkbook(path: string): Promise<Sheets> {
	const { read, utils } = await import("xlsx");
	const workbook = read(await readFile(path), { type: "buffer", cellDates: true, sheetRows: MAX_ROWS });
	return {
		kind: "sheets",
		sheets: workbook.SheetNames.slice(0, 32).map((name) => {
			const sheet = workbook.Sheets[name]!;
			const range = utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1");
			const width = sheet["!ref"] ? Math.min(MAX_COLUMNS, range.e.c + 1) : 0;
			const grid = width
				? utils.sheet_to_json<string[]>(sheet, {
						header: 1,
						raw: false,
						defval: "",
						blankrows: true,
						range: { s: { r: 0, c: 0 }, e: { r: Math.min(range.e.r, MAX_ROWS - 1), c: width - 1 } },
					})
				: [];
			return {
				name,
				columns: Array.from({ length: width }, (_, index) => utils.encode_col(index)),
				rows: grid.map((row) => Array.from({ length: width }, (_, index) => String(row[index] ?? ""))),
				total: width ? range.e.r + 1 : 0,
			};
		}),
	};
}

/** 数据库查询在可杀掉的独立进程中运行，递归视图不能占住 agent 或阻止应用退出。 */
export function readDatabase(path: string, blobLabel: string): Sheets {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const entries = database
			.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 64")
			.all();
		const sheets: Sheet[] = entries.map((entry) => {
			const name = String(entry.name);
			const quoted = `"${name.replaceAll('"', '""')}"`;
			const query = database.prepare(`SELECT * FROM ${quoted} LIMIT ${MAX_ROWS}`);
			query.setReadBigInts(true);
			const rows = query.all();
			const columns = query
				.columns()
				.slice(0, MAX_COLUMNS)
				.map((column) => column.name);
			const total = entry.type === "view" ? rows.length : Number(database.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get()?.n ?? 0);
			return {
				name,
				columns,
				total,
				rows: rows.map((row) =>
					columns.map((column) => {
						const value = row[column];
						return value == null ? "" : value instanceof Uint8Array ? blobLabel.replace("{n}", String(value.length)) : String(value);
					}),
				),
			};
		});
		return { kind: "tables", sheets };
	} finally {
		database.close();
	}
}
