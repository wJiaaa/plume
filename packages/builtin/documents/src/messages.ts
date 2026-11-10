import type { Locale } from "@plume/contract";
const zhCN = {
	loading: "读取中…",
	unreadable: "打不开这个文件：",
	noSheets: "这个文件没有工作表",
	noTables: "这个数据库没有表",
	rows: "{n} 行",
	rowsOf: "显示 {shown} / {total} 行",
	blob: "[{n} 字节]",
	tooLarge: "文档预览上限为 64 MiB",
	timeout: "读取超过 5 秒，已停止",
	invalid: "无效的文档数据",
	outputLarge: "预览内容过多，请用默认应用打开",
};
export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		loading: "Reading…",
		unreadable: "Cannot open this file: ",
		noSheets: "This file has no worksheets",
		noTables: "This database has no tables",
		rows: "{n} rows",
		rowsOf: "Showing {shown} / {total} rows",
		blob: "[{n} bytes]",
		tooLarge: "Document previews are limited to 64 MiB",
		timeout: "Reading exceeded 5 seconds and was stopped",
		invalid: "Invalid document data",
		outputLarge: "Too much preview content. Open in the default app.",
	},
};
