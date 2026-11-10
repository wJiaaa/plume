/**
 * 受测的几种编辑格式，以及判定一次调用有没有落对的应用器。
 *
 * 要回答「新格式是不是更好」，只量一种是答不出来的：
 *
 *   str-replace  按原文锚定：给出一字不差的旧文字，交回新文字。
 *   hunk-text    按行号锚定的小语言：模型只写替换进去的那几行。
 *   hunk-json    同样的操作写成结构化数组，用来分开「按行锚定有帮助」和「简短的文本语法有帮助」。
 *   production   plume.tools 现在随应用发的 edit：说明、参数和执行都是它的，判的是产品本身。
 *
 * 前三种的应用器故意很严：一个会悄悄修好坏调用的格式，量到的是那次修补，而发出去的不是那次修补。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonSchema, ToolSpec } from "../../packages/core/llm/src/types.ts";
import { editTool } from "../../packages/builtin/tools/src/tools/edit.ts";
import { readTool } from "../../packages/builtin/tools/src/tools/read.ts";

export type FormatId = "str-replace" | "hunk-text" | "hunk-json" | "production";

interface ApplyResult {
	ok: boolean;
	content?: string;
	error?: string;
}

export interface EditFormat {
	id: FormatId;
	spec: ToolSpec;
	/** 放进提示词，让模型知道 `read` 给了它什么。 */
	renderFile(path: string, content: string, tag: string): string;
	/** production 要在磁盘上跑真的工具，所以可以是异步的。 */
	apply(args: Record<string, unknown>, current: string, tag: string): ApplyResult | Promise<ApplyResult>;
}

// ---------------------------------------------------------------------------
// 共用的小工具
// ---------------------------------------------------------------------------

/** 拆行时记住末尾有没有换行，来回转换不丢东西。 */
function toLines(content: string): { lines: string[]; trailingNewline: boolean } {
	const trailingNewline = content.endsWith("\n");
	const body = trailingNewline ? content.slice(0, -1) : content;
	return { lines: body.split("\n"), trailingNewline };
}

function fromLines(lines: string[], trailingNewline: boolean): string {
	return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * 文件的 4 位十六进制指纹，FNV-1a。
 *
 * 不是安全原语：它只是让一次照着旧内容写的编辑被拒，而不是悄悄落在别人改过的文件上。
 * 回答「你看过之后这个文件变了没有」，65536 个桶足够了。
 */
export function snapshotTag(content: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		h ^= content.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return ((h >>> 0) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

/** 和 plume.tools 的 read 一样排行号：`NNNN→内容`，宽度按最后一行的行号补齐。 */
function numberedLines(content: string): string {
	const { lines } = toLines(content);
	const width = String(lines.length).length;
	return lines.map((line, i) => `${String(i + 1).padStart(width, " ")}→${line}`).join("\n");
}

// ---------------------------------------------------------------------------
// 两种 hunk 格式共用的模型
// ---------------------------------------------------------------------------

type Hunk =
	| { op: "replace"; start: number; end: number; lines: string[] }
	| { op: "insert"; after: number; lines: string[] }
	| { op: "delete"; start: number; end: number };

/**
 * 按原始行号应用 hunk。
 *
 * 关键在倒序：从下往上应用，哪个 hunk 都不会挪动后面 hunk 引用的行号，模型不用替自己的改动做算术。
 * 重叠算错而不是合并——两个 hunk 碰同一行，意图就说不清了。
 */
function applyHunks(hunks: Hunk[], current: string): ApplyResult {
	const { lines, trailingNewline } = toLines(current);
	const total = lines.length;

	const touched = new Set<number>();
	for (const hunk of hunks) {
		if (hunk.op === "insert") {
			if (hunk.after < 0 || hunk.after > total) return { ok: false, error: `INSERT AFTER ${hunk.after} is out of range (file has ${total} lines)` };
			continue;
		}
		if (hunk.start < 1 || hunk.end > total) return { ok: false, error: `range ${hunk.start}-${hunk.end} is out of range (file has ${total} lines)` };
		if (hunk.start > hunk.end) return { ok: false, error: `range ${hunk.start}-${hunk.end} is inverted` };
		for (let n = hunk.start; n <= hunk.end; n++) {
			if (touched.has(n)) return { ok: false, error: `line ${n} is touched by more than one hunk` };
			touched.add(n);
		}
	}

	const anchorOf = (h: Hunk) => (h.op === "insert" ? h.after + 0.5 : h.start);
	const ordered = [...hunks].sort((a, b) => anchorOf(b) - anchorOf(a));

	const out = [...lines];
	for (const hunk of ordered) {
		if (hunk.op === "insert") out.splice(hunk.after, 0, ...hunk.lines);
		else if (hunk.op === "delete") out.splice(hunk.start - 1, hunk.end - hunk.start + 1);
		else out.splice(hunk.start - 1, hunk.end - hunk.start + 1, ...hunk.lines);
	}
	return { ok: true, content: fromLines(out, trailingNewline) };
}

// ---------------------------------------------------------------------------
// A · str-replace
// ---------------------------------------------------------------------------

const strReplaceParams: JsonSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path." },
		old_string: { type: "string", description: "Exact text to replace." },
		new_string: { type: "string", description: "Replacement text. Must differ from old_string." },
		replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
	},
	required: ["path", "old_string", "new_string"],
	additionalProperties: false,
};

const strReplace: EditFormat = {
	id: "str-replace",
	spec: {
		name: "edit",
		description:
			"Replace an exact string in a file. `old_string` must match the file byte for byte, including indentation, " +
			"and must be unique unless `replace_all` is true. " +
			"Include a few surrounding lines in `old_string` when the snippet would otherwise be ambiguous.",
		parameters: strReplaceParams,
	},
	renderFile(path, content) {
		return `${path}:\n\`\`\`\n${numberedLines(content)}\n\`\`\``;
	},
	apply(args, current) {
		const oldStr = typeof args.old_string === "string" ? args.old_string : null;
		const newStr = typeof args.new_string === "string" ? args.new_string : null;
		if (oldStr === null || newStr === null) return { ok: false, error: "old_string and new_string must both be strings" };
		if (oldStr === newStr) return { ok: false, error: "old_string and new_string are identical" };

		const count = current.split(oldStr).length - 1;
		if (count === 0) return { ok: false, error: "old_string not found in file" };
		if (count > 1 && args.replace_all !== true) return { ok: false, error: `old_string appears ${count} times; not unique` };

		return { ok: true, content: args.replace_all === true ? current.split(oldStr).join(newStr) : current.replace(oldStr, () => newStr) };
	},
};

// ---------------------------------------------------------------------------
// B · hunk-text
// ---------------------------------------------------------------------------

const HUNK_SYNTAX = `Patch syntax — one operation per header line, payload lines start with "+":

REPLACE <start>-<end>
+new line 1
+new line 2

INSERT AFTER <line>
+new line

DELETE <start>-<end>

Rules:
- Line numbers are the ORIGINAL numbers from the file you were shown. They never shift, no matter
  how many operations you write.
- A payload line is everything after the leading "+", verbatim, including indentation. A blank line
  is a bare "+". A line whose own text starts with "+" is written "++".
- The range names the original lines you are REPLACING. The payload may be longer or shorter.
- Never widen a range to retype lines you want to keep — use INSERT AFTER instead.
- To delete, use DELETE. Never use REPLACE with an empty payload.
- Ranges must not overlap. Single line: REPLACE 7-7.`;

const hunkTextParams: JsonSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path." },
		// 这里故意不给示例值。描述里写着「e.g. A1B2」时，gemini-2.5-flash-lite 会把示例原样抄进参数，而不去读文件头——
		// 2026-09-04 量过，45 次里 hunk-text 的两次失败之一就是它。
		tag: { type: "string", description: "Copy the 4-character tag from the [path#TAG] header of the file you were shown. Do not invent it." },
		patch: { type: "string", description: `The patch. ${HUNK_SYNTAX}` },
	},
	required: ["path", "tag", "patch"],
	additionalProperties: false,
};

/** 一行毫无疑问是操作头，而不是内容。 */
const HEADER_RE = /^\s*(?:REPLACE\s+\d+\s*-\s*\d+|INSERT\s+AFTER\s+\d+|DELETE\s+\d+\s*-\s*\d+)\s*:?\s*$/i;

/**
 * 解析补丁语言。
 *
 * 内容行应当以 `+` 开头，提示词也这么教——它让操作头和内容的边界一目了然，空的内容行也靠它写。但 `+` 不是必须的，
 * 因为量出来如此：在 `gemini-2.5-flash-lite` 上，最常见的失败是编辑本身对、只是漏了前缀，拒掉它什么也换不来。
 * 一行内容只有在恰好符合操作头的语法时才有歧义，真实的源码行不会那样。
 *
 * `looseLines` 记下这份宽容用了几次，以后要不要把 `+` 从提示词里整个拿掉，可以拿数据来争，而不是靠猜。
 */
export function parseHunkText(patch: string): { ok: true; hunks: Hunk[]; looseLines: number } | { ok: false; error: string } {
	const hunks: Hunk[] = [];
	const lines = patch.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	let looseLines = 0;

	const readPayload = (): string[] => {
		const payload: string[] = [];
		while (i < lines.length) {
			const line = lines[i]!;
			if (HEADER_RE.test(line)) break;
			if (line.startsWith("+")) {
				payload.push(line.slice(1));
			} else {
				// 末尾的空行属于补丁自己的排版，不是内容。
				const restIsBlank = lines.slice(i).every((l) => l.trim() === "");
				if (restIsBlank) break;
				payload.push(line);
				if (line.trim() !== "") looseLines += 1;
			}
			i += 1;
		}
		return payload;
	};

	while (i < lines.length) {
		const line = lines[i]!;
		if (line.trim() === "") {
			i += 1;
			continue;
		}

		let match = /^\s*REPLACE\s+(\d+)\s*-\s*(\d+)\s*:?\s*$/i.exec(line);
		if (match) {
			i += 1;
			const payload = readPayload();
			if (payload.length === 0) return { ok: false, error: `REPLACE ${match[1]}-${match[2]} has no payload; use DELETE to remove lines` };
			hunks.push({ op: "replace", start: Number(match[1]), end: Number(match[2]), lines: payload });
			continue;
		}

		match = /^\s*INSERT\s+AFTER\s+(\d+)\s*:?\s*$/i.exec(line);
		if (match) {
			i += 1;
			const payload = readPayload();
			if (payload.length === 0) return { ok: false, error: `INSERT AFTER ${match[1]} has no payload` };
			hunks.push({ op: "insert", after: Number(match[1]), lines: payload });
			continue;
		}

		match = /^\s*DELETE\s+(\d+)\s*-\s*(\d+)\s*:?\s*$/i.exec(line);
		if (match) {
			i += 1;
			hunks.push({ op: "delete", start: Number(match[1]), end: Number(match[2]) });
			continue;
		}

		if (line.startsWith("+")) return { ok: false, error: `payload line with no preceding operation header: ${JSON.stringify(line.slice(0, 40))}` };
		return { ok: false, error: `unrecognised line: ${JSON.stringify(line.slice(0, 40))}` };
	}

	if (hunks.length === 0) return { ok: false, error: "patch contains no operations" };
	return { ok: true, hunks, looseLines };
}

const hunkText: EditFormat = {
	id: "hunk-text",
	spec: {
		name: "edit",
		description:
			"Edit a file by naming the original line numbers to change. You write only the replacement lines — " +
			"never retype lines you are keeping. " +
			"`tag` must be the snapshot tag from the header of the file you were shown; if the file changed since " +
			"then the edit is rejected.\n\n" +
			HUNK_SYNTAX,
		parameters: hunkTextParams,
	},
	renderFile(path, content, tag) {
		return `[${path}#${tag}]\n\`\`\`\n${numberedLines(content)}\n\`\`\``;
	},
	apply(args, current, tag) {
		if (typeof args.tag !== "string") return { ok: false, error: "tag is required" };
		if (args.tag.toUpperCase() !== tag) return { ok: false, error: `stale tag ${args.tag}: the file is now ${tag}. Re-read before editing.` };
		if (typeof args.patch !== "string") return { ok: false, error: "patch must be a string" };

		const parsed = parseHunkText(args.patch);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		return applyHunks(parsed.hunks, current);
	},
};

// ---------------------------------------------------------------------------
// C · hunk-json
// ---------------------------------------------------------------------------

const hunkJsonParams: JsonSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path." },
		tag: { type: "string", description: "Copy the 4-character tag from the [path#TAG] header of the file you were shown. Do not invent it." },
		hunks: {
			type: "array",
			description:
				"Operations against the ORIGINAL line numbers shown in the file. Numbers never shift between hunks. " +
				"Ranges must not overlap. Use `insert` for pure additions rather than widening a `replace`.",
			items: {
				type: "object",
				properties: {
					op: {
						type: "string",
						enum: ["replace", "insert", "delete"],
						description:
							"replace: needs start, end, lines (lines must be non-empty). " +
							"insert: needs after, lines. " +
							"delete: needs start, end and NO lines — to remove lines use delete, never replace with an empty lines array.",
					},
					start: { type: "number", description: "First original line, 1-indexed. For replace and delete." },
					end: { type: "number", description: "Last original line, inclusive. For replace and delete." },
					after: { type: "number", description: "Insert after this original line. 0 means the top of the file. For insert only." },
					lines: {
						type: "array",
						items: { type: "string" },
						description:
							"New lines, verbatim including indentation, without trailing newlines. Required and non-empty for replace and insert; omit for delete.",
					},
				},
				required: ["op"],
				additionalProperties: false,
			},
		},
	},
	required: ["path", "tag", "hunks"],
	additionalProperties: false,
};

const hunkJson: EditFormat = {
	id: "hunk-json",
	spec: {
		name: "edit",
		description:
			"Edit a file by naming the original line numbers to change. You supply only the replacement lines — " +
			"never retype lines you are keeping. " +
			"`tag` must be the snapshot tag from the header of the file you were shown; if the file changed since " +
			"then the edit is rejected.",
		parameters: hunkJsonParams,
	},
	renderFile(path, content, tag) {
		return `[${path}#${tag}]\n\`\`\`\n${numberedLines(content)}\n\`\`\``;
	},
	apply(args, current, tag) {
		if (typeof args.tag !== "string") return { ok: false, error: "tag is required" };
		if (args.tag.toUpperCase() !== tag) return { ok: false, error: `stale tag ${args.tag}: the file is now ${tag}. Re-read before editing.` };
		if (!Array.isArray(args.hunks) || args.hunks.length === 0) return { ok: false, error: "hunks must be a non-empty array" };

		const hunks: Hunk[] = [];
		for (const raw of args.hunks as Record<string, unknown>[]) {
			const op = raw?.op;
			const lines = Array.isArray(raw?.lines) ? (raw.lines as unknown[]).map(String) : [];
			if (op === "replace") {
				if (typeof raw.start !== "number" || typeof raw.end !== "number") return { ok: false, error: "replace needs numeric start and end" };
				if (lines.length === 0) return { ok: false, error: "replace with no lines; use delete instead" };
				hunks.push({ op: "replace", start: raw.start, end: raw.end, lines });
			} else if (op === "insert") {
				if (typeof raw.after !== "number") return { ok: false, error: "insert needs a numeric after" };
				if (lines.length === 0) return { ok: false, error: "insert with no lines" };
				hunks.push({ op: "insert", after: raw.after, lines });
			} else if (op === "delete") {
				if (typeof raw.start !== "number" || typeof raw.end !== "number") return { ok: false, error: "delete needs numeric start and end" };
				hunks.push({ op: "delete", start: raw.start, end: raw.end });
			} else {
				return { ok: false, error: `unknown op ${JSON.stringify(op)}` };
			}
		}
		return applyHunks(hunks, current);
	},
};

// ---------------------------------------------------------------------------
// D · production
//
// 同一套评测，对着随应用发的代码跑：工具的说明和参数取自 plume.tools 的 `editTool`，执行也是它——文件写进临时目录，
// 先经真的 `read` 读一遍（edit 只认读过的文件），再交给真的 `edit`。这样 edit 的近似匹配、引号和转义的读法、
// 「读过以后没变」这些规则都算在 production 的分数里，判的才是产品。
// ---------------------------------------------------------------------------

/** 落盘用的文件名。模型写的 `path` 不参与判分：别的格式也只看内容。 */
const TARGET = "target.ts";

const textOf = (result: { content: { text: string }[] }) => result.content.map((part) => part.text).join("\n");

const production: EditFormat = {
	id: "production",
	spec: { name: "edit", description: editTool.description, parameters: editTool.parameters as JsonSchema },
	renderFile(path, content) {
		// 和 read 给短文件（或带 offset/limit 读的窗口）的输出一样：`[路径]` 头，下面是带行号的行。
		return `[${path}]\n${numberedLines(content)}`;
	},
	async apply(args, current) {
		const cwd = await mkdtemp(join(tmpdir(), "plume-edit-eval-"));
		try {
			await writeFile(join(cwd, TARGET), current, "utf8");
			const ctx = { cwd, state: new Map<string, unknown>() };
			// 带上窗口读：模型在提示词里看到的是整个文件，不该因为长文件的大纲视图被 edit 拒掉。
			const read = await readTool.execute({ path: TARGET, offset: 1, limit: 100_000 }, ctx);
			if (read.isError) return { ok: false, error: `read failed: ${textOf(read)}` };
			const result = await editTool.execute({ ...args, path: TARGET } as Parameters<typeof editTool.execute>[0], ctx);
			if (result.isError) return { ok: false, error: textOf(result) };
			return { ok: true, content: await readFile(join(cwd, TARGET), "utf8") };
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
};

export const FORMATS: Record<FormatId, EditFormat> = {
	"str-replace": strReplace,
	"hunk-text": hunkText,
	"hunk-json": hunkJson,
	production,
};
