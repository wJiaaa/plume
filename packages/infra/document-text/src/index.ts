/**
 * 文档里的字，给只能读字的模型。
 *
 * 附件是一份合同、一份表格时，把字节当 UTF-8 解出来只会得到几千个替换字符，什么都不发又等于没附。新式 Office 格式
 * （`.docx`、`.pptx`、`.xlsx`）是 XML 的 zip 包，字就在里面；PDF 读的是文字层，用 `unpdf`（纯 JavaScript 的 pdf.js，
 * 没有原生依赖，所以能放在 agent 进程里）。
 *
 * 读不了的直接说读不了，不去猜：`.doc`、`.xls`、`.ppt` 是 OLE 复合文件，抽字要实现一套文件系统，抽一半比不抽更糟。
 * 返回 null 是「格式不支持」，`imageOnly` 是「文件是好的，但没有文字层」（扫描件），两件事对人来说要做的不一样。
 */

import { strFromU8, unzipSync } from "fflate";

/** 抽出来的字。和 `@plume/contract` 的 `DocumentText` 同形：这里不依赖 contract。 */
export interface DocumentText {
	text: string;
	/** 有页，但一页字都没有：多半是扫描件。 */
	imageOnly?: boolean;
	/** 字太多被截断了。 */
	truncated?: boolean;
	/** 截断时原文一共多少字。 */
	fullLength?: number;
}

/**
 * 一份文档最多进提示词多少字。合同几千字该整份进去；五百页的手册不该，它会把整段对话挤出上下文窗口，
 * 而附上它的人多半只想问其中一段。截断了会告诉调用方，回答里才说得清。
 */
const MAX_CHARS = 120_000;

/** 底下是 zip 的那些扩展名，不管它们叫什么。 */
const ZIP_LIKE = new Set(["zip", "jar", "war", "ipa", "apk", "aar", "whl", "nupkg", "vsix", "epub", "xpi", "crx"]);

/** HTML、XML 的字符引用一次解完：先解 `&amp;` 再解 `&lt;` 会把字面的 `&amp;lt;` 变成 `<`。 */
function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		ndash: "–",
		mdash: "—",
		hellip: "…",
		laquo: "«",
		raquo: "»",
		ldquo: "“",
		rdquo: "”",
		lsquo: "‘",
		rsquo: "’",
		middot: "·",
	};
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === "#") {
			const value = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
		}
		return named[code.toLowerCase()] ?? whole;
	});
}

/**
 * OOXML 里按文档顺序的每一段 `<w:t>`、`<a:t>`、`<t>`。用正则不用 XML 解析器是格式允许的：字都在名字以 `:t` 结尾
 * 或就叫 `t` 的叶子元素里，从不嵌套。段落和表格行的结尾换成换行，读起来才是一篇文档而不是一堵墙。
 */
function textFromOoxml(xml: string): string {
	const out: string[] = [];
	const pattern = /<(?:[a-z]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-z]+:)?t>|<\/(?:w:p|a:p|w:tr)>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(xml))) out.push(match[1] === undefined ? "\n" : decodeEntities(match[1]));
	return out.join("");
}

function tidy(text: string): string {
	return text
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * 把「长得像汉字但不是汉字」的码位换回汉字。PDF 抽出来的「白皮书」可能是康熙部首区的「⽩⽪」，人眼看不出区别，
 * 用户问起「白皮书」时模型却对不上。只动康熙部首、CJK 部首补充两个区，不整段 NFKC：那会把全角「，」压成半角，等于改原文。
 */
function normalizeRadicals(text: string): string {
	return text.replace(/[⺀-⻿⼀-⿟]/g, (char) => {
		const folded = char.normalize("NFKC");
		return folded.length === 1 ? folded : char;
	});
}

function finish(text: string): DocumentText {
	const tidied = tidy(text);
	return tidied.length > MAX_CHARS ? { text: tidied.slice(0, MAX_CHARS), truncated: true, fullLength: tidied.length } : { text: tidied };
}

/** Word：正文，加上页眉页脚（当事人和日期常在那里）。 */
function textFromDocx(bytes: Uint8Array): DocumentText {
	const zip = unzipSync(bytes);
	const parts = [
		"word/document.xml",
		...Object.keys(zip)
			.sort()
			.filter((name) => /^word\/(header|footer)\d*\.xml$/.test(name)),
	];
	return finish(
		parts
			.map((name) => (zip[name] ? textFromOoxml(strFromU8(zip[name])) : ""))
			.filter(Boolean)
			.join("\n\n"),
	);
}

function slideNumber(name: string): number {
	return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

/** 幻灯片：每页一段，带页码和备注。问一份幻灯片多半是问某一页，不编号模型答不出「第 4 页讲了什么」。 */
function textFromPptx(bytes: Uint8Array): DocumentText {
	const zip = unzipSync(bytes);
	const slides = Object.keys(zip)
		.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
		.sort((a, b) => slideNumber(a) - slideNumber(b));
	const blocks = slides.map((name) => {
		const body = textFromOoxml(strFromU8(zip[name]!));
		const notesFile = zip[`ppt/notesSlides/notesSlide${slideNumber(name)}.xml`];
		const notes = notesFile ? textFromOoxml(strFromU8(notesFile)) : "";
		// i18n-exempt：抽出来的字是发给模型的，不随界面语言变。
		return [`## 第 ${slideNumber(name)} 页`, tidy(body), notes.trim() ? `（备注）${tidy(notes)}` : ""].filter(Boolean).join("\n");
	});
	return finish(blocks.join("\n\n"));
}

/** 表格：每个工作表一段 CSV。CSV 是把表格放进提示词最紧凑、模型也读得最稳的写法。 */
async function textFromXlsx(bytes: Uint8Array): Promise<DocumentText> {
	const { read, utils } = await import("xlsx");
	const book = read(bytes, { type: "array" });
	const blocks = book.SheetNames.map((name) => {
		const sheet = book.Sheets[name];
		const csv = sheet ? utils.sheet_to_csv(sheet, { blankrows: false }).trim() : "";
		return csv ? `## ${name}\n${csv}` : "";
	}).filter(Boolean);
	return finish(blocks.join("\n\n"));
}

/** PDF 的文字层，按页编号，理由和幻灯片一样。 */
async function textFromPdf(bytes: Uint8Array): Promise<DocumentText> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	// 复制一份：pdf.js 会把拿到的缓冲区转交给它的 worker，调用方手里那份随之失效。
	const pdf = await getDocumentProxy(new Uint8Array(bytes));
	const { totalPages, text } = await extractText(pdf, { mergePages: false });
	const pages = Array.isArray(text) ? text : [text];
	const blocks = pages
		.map((page, index) => {
			const body = tidy(normalizeRadicals(page ?? ""));
			// i18n-exempt：抽出来的字是发给模型的，不随界面语言变。
			return body ? `## 第 ${index + 1} 页\n${body}` : "";
		})
		.filter(Boolean);
	// 页在、字不在：扫描件，不是空文件。说清楚，别让人以为附件坏了。
	if (blocks.length === 0) return totalPages > 0 ? { text: "", imageOnly: true } : { text: "" };
	return finish(blocks.join("\n\n"));
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 压缩包：只列里面有什么，不解开。解开一个任意大、任意深的包是上下文窗口消失的方式，而问题几乎总是「里面有什么」。 */
function listArchive(bytes: Uint8Array): DocumentText {
	const entries = Object.entries(unzipSync(bytes))
		.filter(([name]) => !name.endsWith("/"))
		.sort(([a], [b]) => a.localeCompare(b));
	// i18n-exempt：抽出来的字是发给模型的，不随界面语言变。
	return finish([`共 ${entries.length} 个文件`, ...entries.map(([name, data]) => `${name}  (${formatBytes(data.length)})`)].join("\n"));
}

/** 一份文档的字；格式读不了就是 null。坏文件也是 null：什么都不说好过往提示词里塞乱码。 */
export async function extractDocumentText(name: string, bytes: Uint8Array): Promise<DocumentText | null> {
	const extension = name.toLowerCase().split(".").pop() ?? "";
	try {
		if (extension === "pdf") return await textFromPdf(bytes);
		if (extension === "docx" || extension === "odt") return textFromDocx(bytes);
		if (extension === "pptx" || extension === "odp") return textFromPptx(bytes);
		if (["xlsx", "xlsm", "xlsb", "ods"].includes(extension)) return await textFromXlsx(bytes);
		if (ZIP_LIKE.has(extension)) return listArchive(bytes);
		return null;
	} catch {
		return null;
	}
}
