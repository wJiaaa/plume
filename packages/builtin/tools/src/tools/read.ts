import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { textArg } from "./args.ts";
import { errorResult } from "./result.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { charWindow, formatCharWindow, longLineFooter, MAX_LINE_CHARS } from "./long-line.ts";
import { outline, outlineFooter } from "./outline.ts";
import { displayPath, imageMimeType, looksBinary } from "./paths.ts";
import { authorizeRead, toAbsolute } from "./read-access.ts";
import { markRead } from "./read-state.ts";
import { sameNamed } from "./project-files.ts";
import { resourceScope, scratchFile } from "./scratch-file.ts";
import { decodeText } from "./text-layout.ts";
import { LINE_KEEP_BYTES, readLineWindow, STREAM_ABOVE_BYTES } from "./large-text.ts";
import { extractDocumentText } from "@plume/document-text";
import { describeRead } from "./describe.ts";

const DEFAULT_LIMIT = 2000;
const PATH_KEYS = ["path", "file", "filePath"];
/**
 * 正文的字数上限，留出头部路径、页脚和长行提示的余量。一次读给多少字要有个数：读出来的被当成「读过了」，
 * 之后 edit 据此放行，要是读出来的太长被别处剪掉，模型没看见的行也成了读过的。
 */
const OUTPUT_BUDGET = 35_400;
/** 图片的上限：一张图跟着历史每轮重发，再大就不值得了。原样交出去，不缩放。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 能抽出字来读的文档格式，见 `@plume/document-text`。 */
const EXTRACTABLE = new Set([
	"pdf",
	"docx",
	"pptx",
	"xlsx",
	"xlsm",
	"xlsb",
	"ods",
	"odt",
	"odp",
	"zip",
	"jar",
	"war",
	"ipa",
	"apk",
	"aar",
	"whl",
	"nupkg",
	"vsix",
	"epub",
	"xpi",
	"crx",
]);

interface ReadArgs {
	path: string;
	offset?: number;
	limit?: number;
	char_offset?: number;
}

/** 小写的扩展名：下面按它决定走哪条路。 */
function extensionOf(path: string): string {
	const base = path.toLowerCase().split(/[/\\]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1) : "";
}

/** 找不到时附上项目里的同名文件，见 `sameNamed`。 */
async function notFound(cwd: string, path: string): Promise<string> {
	const named = await sameNamed(cwd, path).catch(() => []);
	if (named.length === 0) return `File not found: ${path}`;
	return `File not found: ${path}. Files with that name in the project:\n${named.map((one) => `  ${one}`).join("\n")}`;
}

export const readTool: Tool<ReadArgs> = {
	name: "read",
	describe: describeRead,
	description:
		"Read a file. Text comes back under a `[path]` header as 1-indexed lines, `NNNN→content`; the `NNNN→` prefix is not part of the file. " +
		"A long source file read without `offset`/`limit` comes back as its STRUCTURE: declarations and doc comments, each body folded to " +
		"`⋯ N lines (from-to)`. Read that range to see a body — never guess at it. Short files, data files and `offset`/`limit` windows are verbatim. " +
		"A line over 2000 characters comes back as a window; continue it with `char_offset`. Images come back as images. " +
		"When you already know several files you need, read them all in one reply: calls sent together run in parallel.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, absolute or relative to the workspace root." },
			offset: { type: "number", description: "1-indexed line to start from." },
			limit: { type: "number", description: "Maximum number of lines to return. Defaults to 2000." },
			char_offset: {
				type: "number",
				description: "1-indexed character to start from on each line, for a line read or grep said was over 2000 characters.",
			},
		},
		required: ["path"],
		additionalProperties: true,
	},

	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as unknown as Record<string, unknown>;
		const path = textArg(args, PATH_KEYS);

		if (!path) return errorResult("`path` is required.");
		const charOffset = Math.max(1, numberArg(raw.char_offset ?? raw.charOffset) ?? 1);

		/*
		 * 先认地址，而且只认有人登记了的 scheme。
		 *
		 * 没人认的 `foo://` 照旧当路径，在文件系统那里以「找不到」失败，那是实话；把所有 `://` 都揽过来，会拿地址的报错
		 * 回答一个从没想用地址的人路径里的笔误。临时文件按文件读，edit 才找得到它要的那次 read；拒绝的话由地址那边说。
		 */
		const scratch = await scratchFile(ctx, path).catch(() => null);
		const resourceResult = scratch ? null : await tryResource(path, ctx, { offset: args.offset, limit: args.limit, charOffset });
		if (resourceResult) return resourceResult;
		const shownPath = scratch ? path : displayPath(ctx.cwd, toAbsolute(ctx.cwd, path));

		let absolute: string;
		try {
			absolute = await realpath(scratch ?? toAbsolute(ctx.cwd, path));
		} catch {
			return errorResult(scratch ? `File not found: ${path}` : await notFound(ctx.cwd, path));
		}
		const authorized = await authorizeRead(ctx, absolute);
		if (!authorized.ok) return errorResult(authorized.message);

		let info: Stats;
		try {
			info = await stat(absolute);
		} catch {
			return errorResult(`File not found: ${path}`);
		}
		if (info.isDirectory()) return errorResult(`${path} is a directory. Use \`ls\` or \`glob\` instead.`);

		const mime = imageMimeType(absolute);
		if (mime) {
			if (info.size > MAX_IMAGE_BYTES) {
				return errorResult(`Image is ${(info.size / 1024 / 1024).toFixed(1)} MB, above the 5 MB limit.`);
			}
			const data = await readFile(absolute);
			// 不带时间戳：看过这张图，但没有读成文字，edit 照样要求先按文字读。
			markRead(ctx, absolute);
			return {
				content: [],
				images: [{ data: data.toString("base64"), mimeType: mime as NonNullable<ToolResult["images"]>[number]["mimeType"] }],
				details: { kind: "image", path: shownPath, bytes: info.size, mimeType: mime },
			};
		}

		const extractable = EXTRACTABLE.has(extensionOf(absolute));
		// 太大了，为几千个字不值得整个读进来；抽字要整份文档，所以文档照旧整个读。
		if (info.size > STREAM_ABOVE_BYTES && !extractable) return readLarge(args, ctx, absolute, shownPath, info, charOffset);

		const buffer = await readFile(absolute);

		/*
		 * 合同、表格、幻灯片，读成里面的字。
		 *
		 * 按下面的字节判断它们都是二进制。人把同一份文件拖进输入框时附件能抽出字来，模型自己去找时却被拒，
		 * 同一份文件、同样的字节，因为谁在问而两个答案。先抽字：字节判断分不清 XML 的 zip 和可执行文件。
		 */
		const extracted = extractable ? await extractDocumentText(absolute, buffer).catch(() => null) : null;
		if (extracted) {
			markRead(ctx, absolute);
			// 说出来而不是交一个空字符串：扫描件有页没有文字层，空字符串正是让人以为扫描件被读过了的那种回答。
			const body = extracted.imageOnly ? `[${shownPath} has no text layer — it is a scan or an image-only document. Reading it needs OCR.]` : extracted.text;
			return {
				content: [{ type: "text", text: body }],
				details: {
					kind: "document",
					path: shownPath,
					bytes: info.size,
					characters: extracted.fullLength ?? extracted.text.length,
					truncated: extracted.truncated === true,
					...(extracted.imageOnly ? { imageOnly: true } : {}),
				},
			};
		}

		if (looksBinary(buffer)) {
			return errorResult(`${args.path} looks like a binary file (${info.size} bytes) and cannot be read as text.`);
		}

		const { text } = decodeText(buffer.toString("utf8"));
		const allLines = text.split("\n");
		// 末尾的换行会多出一个空元素，那不是一行。
		if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();

		const askedWindow = args.offset !== undefined || args.limit !== undefined || charOffset > 1;

		/*
		 * 不带窗口地读一个长源码文件，返回它的形状而不是字节。
		 *
		 * 只在没要窗口时：给了 `offset`/`limit`/`char_offset` 就是说已经知道看哪里，把它指的地方折起来就反了。
		 * 原文更好时（短文件、数据文件、认不出声明的）`outline` 返回 null。
		 */
		if (!askedWindow) {
			const shape = outline(shownPath, text, allLines);
			// 大纲本身超出上限时改走下面按字数截断的窗口。
			if (shape && shape.text.length <= OUTPUT_BUDGET) {
				markRead(ctx, absolute, info, true);
				return {
					content: [{ type: "text", text: `[${shownPath}]\n${shape.text}${outlineFooter(shownPath, shape, allLines.length)}` }],
					details: {
						kind: "text",
						path: shownPath,
						totalLines: allLines.length,
						outlined: true,
						shownLines: shape.shownLines,
						foldedLines: shape.foldedLines,
					},
				};
			}
		}

		const offset = Math.max(1, args.offset ?? 1);
		const limit = Math.max(1, args.limit ?? DEFAULT_LIMIT);
		const shown = renderLines(allLines.slice(offset - 1, offset - 1 + limit), offset, allLines.length, charOffset - 1);
		if (!shown) {
			return errorResult(`Line ${offset} is past the end of the file (${allLines.length} lines).`);
		}
		const { body, shownEnd, long, footer } = shown;

		/*
		 * 记下的是整个文件的修改时间和大小，不是这一段的：文件哪里变了编辑都得拒，不只是屏幕上那段。
		 * 模型自己要的窗口，它知道边在哪里；没要窗口却没读完的，它不知道。
		 */
		markRead(ctx, absolute, info, !askedWindow && shownEnd < allLines.length);
		return {
			content: [{ type: "text", text: `[${shownPath}]\n${body}${footer}` }],
			details: {
				kind: "text",
				path: shownPath,
				totalLines: allLines.length,
				shownFrom: offset,
				shownTo: shownEnd,
				...(long[0] ? { charFrom: long[0].shownFrom, charTo: long[0].shownTo, longLines: long.length } : {}),
			},
		};
	},
};

interface LineWindow {
	body: string;
	shownEnd: number;
	long: { line: number; length: number; shownFrom: number; shownTo: number }[];
	footer: string;
}

/**
 * 大到不该整个读进来的文件：流式读，窗口和页脚和小文件一样。
 *
 * 不出大纲：这么大的是日志或导出，不是大纲帮得上的源码，而且组大纲要整个文本在内存里，这条路就是为了避免这个。
 */
async function readLarge(args: ReadArgs, ctx: ToolContext, absolute: string, shownPath: string, info: Stats, charOffset: number): Promise<ToolResult> {
	const askedWindow = args.offset !== undefined || args.limit !== undefined || charOffset > 1;
	const offset = Math.max(1, args.offset ?? 1);
	const limit = Math.max(1, args.limit ?? DEFAULT_LIMIT);
	const window = await readLineWindow(absolute, offset, limit, charOffset - 1, OUTPUT_BUDGET, ctx.signal);
	if (window.binary) return errorResult(`${args.path} looks like a binary file (${info.size} bytes) and cannot be read as text.`);
	const shown = renderLines(window.lines, offset, window.totalLines, charOffset - 1);
	if (!shown) return errorResult(`Line ${offset} is past the end of the file (${window.totalLines} lines).`);
	const { body, shownEnd, long, footer } = shown;
	// 说出来，不当成整行：超出留下那部分的 `char_offset` 会被读成行尾。
	const cut = window.cut.filter((line) => line <= shownEnd);
	const cutNote = cut.length
		? `\n\n[line${cut.length === 1 ? "" : "s"} ${cut.join(", ")} ${cut.length === 1 ? "is" : "are"} longer than ${LINE_KEEP_BYTES / 1024 / 1024} MB; only the first ${LINE_KEEP_BYTES / 1024 / 1024} MB can be read, and any character count above covers just that part — use grep or bash to search the rest]`
		: "";
	markRead(ctx, absolute, info, !askedWindow && shownEnd < window.totalLines);
	return {
		content: [{ type: "text", text: `[${shownPath}]\n${body}${footer}${cutNote}` }],
		details: {
			kind: "text",
			path: shownPath,
			totalLines: window.totalLines,
			shownFrom: offset,
			shownTo: shownEnd,
			...(long[0] ? { charFrom: long[0].shownFrom, charTo: long[0].shownTo, longLines: long.length } : {}),
		},
	};
}

/**
 * 从 `offset` 起的这一段带行号排出来，逐行按 `charStart` 开字符窗口；`slice` 为空（`offset` 越过末尾）时返回 null。
 * `totalLines` 是整个文件的行数，页脚据此说还剩多少。
 */
function renderLines(slice: string[], offset: number, totalLines: number, charStart: number): LineWindow | null {
	if (slice.length === 0) return null;

	const long: LineWindow["long"] = [];
	const width = String(offset + slice.length - 1).length;
	/*
	 * 按字数截断。
	 *
	 * 两千行不设字数上限时，一次读能有几十万字，一条结果就占掉大半个上下文。截在上限以内，
	 * 再告诉它从哪一行接着读。
	 */
	const rendered: string[] = [];
	let used = 0;
	for (const [i, line] of slice.entries()) {
		const lineNo = offset + i;
		const inline = line.length <= MAX_LINE_CHARS && charStart <= 0;
		const window = inline ? null : charWindow(line, charStart);
		const row = `${String(lineNo).padStart(width, " ")}→${inline ? line : formatCharWindow(line, charStart)}`;
		if (rendered.length > 0 && used + row.length + 1 > OUTPUT_BUDGET) break;
		rendered.push(row);
		used += row.length + 1;
		if (window) long.push({ line: lineNo, length: line.length, shownFrom: window.start + 1, shownTo: window.end });
	}

	const shownEnd = offset + rendered.length - 1;
	const capped = rendered.length < slice.length ? ` (output capped at ${OUTPUT_BUDGET.toLocaleString("en-US")} characters)` : "";
	const lineFooter =
		shownEnd < totalLines ? `\n\n[showing lines ${offset}-${shownEnd} of ${totalLines}${capped}; call read again with offset=${shownEnd + 1} for more]` : "";
	return { body: rendered.join("\n"), shownEnd, long, footer: lineFooter + longLineFooter(long) };
}

/**
 * 地址交给拥有它的 scheme 读，结果和读文件一样带头部；内容来自别处的包进 `<resource origin="…">`。
 *
 * 窗口参数对地址同样有效，超出单条结果上限的内容也按窗口给：剪枝标记让模型 `read artifact://…` 取回中段，整段返回的话，
 * 它作为新结果又被剪成同样的头尾，中段永远取不回来。
 */
async function tryResource(path: string, ctx: ToolContext, window: { offset?: number; limit?: number; charOffset: number }): Promise<ToolResult | null> {
	const router = ctx.resources;
	if (!router?.canResolve(path)) return null;

	try {
		const resource = await router.resolve(path, resourceScope(ctx));
		let content = resource.content;
		const asked = window.offset !== undefined || window.limit !== undefined || window.charOffset > 1;
		if (asked || content.length > OUTPUT_BUDGET) {
			const lines = content.split("\n");
			if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
			const offset = Math.max(1, window.offset ?? 1);
			const limit = Math.max(1, window.limit ?? DEFAULT_LIMIT);
			const shown = renderLines(lines.slice(offset - 1, offset - 1 + limit), offset, lines.length, window.charOffset - 1);
			if (!shown) return errorResult(`Line ${offset} is past the end of ${resource.url} (${lines.length} lines).`);
			content = shown.body + shown.footer;
		}
		const header = resource.label ? `[${resource.url} — ${resource.label}]` : `[${resource.url}]`;
		const body = resource.origin
			? `<resource url="${escapeAttr(resource.url)}" origin="${escapeAttr(resource.origin)}">\n${content}\n</resource>`
			: `${header}\n${content}`;
		return {
			content: [{ type: "text", text: body }],
			details: { kind: "resource", url: resource.url, contentType: resource.contentType, ...resource.meta },
		};
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error));
	}
}

function escapeAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function numberArg(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
