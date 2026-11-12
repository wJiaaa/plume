import type { CallContext } from "@plume/contract";

export interface Sheet {
	name: string;
	columns: string[];
	rows: string[][];
	total: number;
}
export interface Sheets {
	kind: "sheets" | "tables";
	sheets: Sheet[];
}
export interface DocumentsApi {
	sheets(data: Uint8Array, database: boolean, call: CallContext): Promise<Sheets>;
}
export const MAX_BYTES = 64 * 1024 * 1024;
export const WORKBOOKS = ["xlsx", "xlsm", "xltx", "xltm", "xlsb", "xls", "ods"];
export const WORDS = ["docx", "docm", "dotx", "dotm"];
export const PRESENTATIONS = ["pptx", "pptm", "ppsx", "ppsm", "potx", "potm"];
export const DATABASES = ["sqlite", "sqlite3", "db"];
