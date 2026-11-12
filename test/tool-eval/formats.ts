/**
 * 受测的几种编辑格式，以及判定一次调用有没有落对的应用器。
 *
 *   str-replace  对照：按原文锚定，一字不差才算，不做任何近似匹配。
 *   production   plume.tools 现在随应用发的 edit：说明、参数和执行都是它的，判的是产品本身。
 *
 * 对照的应用器故意很严：两者的差就是产品的说明和近似匹配换来的。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonSchema, ToolSpec } from "../../packages/core/llm/src/types.ts";
import { editTool } from "../../packages/builtin/tools/src/tools/edit.ts";
import { readTool } from "../../packages/builtin/tools/src/tools/read.ts";
import { withFiles } from "../../packages/builtin/tools/test/files.ts";

export type FormatId = "str-replace" | "production";

interface ApplyResult {
	ok: boolean;
	content?: string;
	error?: string;
}

export interface EditFormat {
	id: FormatId;
	spec: ToolSpec;
	/** 放进提示词，让模型知道 `read` 给了它什么。 */
	renderFile(path: string, content: string): string;
	/** production 要在磁盘上跑真的工具，所以可以是异步的。 */
	apply(args: Record<string, unknown>, current: string): ApplyResult | Promise<ApplyResult>;
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

/** 和 plume.tools 的 read 一样排行号：`NNNN→内容`，宽度按最后一行的行号补齐。 */
function numberedLines(content: string): string {
	const { lines } = toLines(content);
	const width = String(lines.length).length;
	return lines.map((line, i) => `${String(i + 1).padStart(width, " ")}→${line}`).join("\n");
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
// B · production
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
			const ctx = withFiles({ cwd, state: new Map<string, unknown>() });
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
	production,
};
