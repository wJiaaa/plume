/**
 * 按原文替换来改文件。
 *
 * 按原文而不是按行号：换一个词不用重打整行，一段一行的长文里那是上千个字要一字不差地抄。
 *
 * 守着的几条：文件必须读过、读过以后没变、匹配必须唯一。原文对不上字节时，先试 `edit-match.ts` 里几种相近的读法再放弃。
 * 不记显示了哪几行：上一次读没读全（大纲、撞上上限的窗口），在一次指明窗口的读之前这个文件不能改。
 */

import type { FileDiffDetails } from "@plume/contract";
import { computeDiff, type FileDiff } from "@plume/platform";
import { formatDiff } from "../diff.ts";
import { findEditMatch, replacementFor } from "./edit-match.ts";
import { withTextFile } from "./file-write.ts";
import { formatCharWindow, MAX_LINE_CHARS } from "./long-line.ts";
import { displayPath, resolveWorkspacePath, scratchDirsOf } from "./paths.ts";
import { scratchFile } from "./scratch-file.ts";
import { changedSince, markRead, readRecord } from "./read-state.ts";
import { declinedResult, errorResult } from "./result.ts";
import { decodeInput, decodeText, encodeText } from "./text-layout.ts";
import type { Tool, ToolResult } from "./types.ts";
import { describeEdit } from "./describe.ts";

interface EditArgs {
	path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

export const editTool: Tool<EditArgs> = {
	name: "edit",
	describe: describeEdit,
	// 改文件：成功一次就是工作区有了实打实的进展，本体的重复检测从头数。
	kind: "modify",
	description:
		"Replace exact text in a file. `old_string` must match the file exactly, whitespace and indentation included, and be unique unless `replace_all` is set. " +
		"Keep `old_string` as small as possible while still unique: when only a word changes, a few words around it are enough, even on a long line. " +
		"Read the file before editing it; if it changed since, the edit is refused — re-read and redo it. " +
		"If that read came back as an outline or was cut short, read the part you are changing with `offset`/`limit` first. " +
		"For several separate changes, send several edit calls in one response.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, absolute or relative to the workspace root." },
			old_string: { type: "string", description: "The exact text to replace." },
			new_string: { type: "string", description: "The text to put in its place." },
			replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
		},
		required: ["path", "old_string", "new_string"],
		additionalProperties: false,
	},
	mutating: true,

	async execute(args, ctx): Promise<ToolResult> {
		// 不认附件（`ToolRun.allowedPaths`），理由见 `write.ts` 同一处：附件是「给你看」，不是「可以改」。
		if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
			return errorResult("`old_string` and `new_string` must both be strings.");
		}
		try {
			// `scratch://x` 改的是临时目录里的那个文件，和 read 认的是同一个，见 `scratch-file.ts`。
			const file = await scratchFile(ctx, args.path);
			return await withTextFile<ToolResult>(ctx, file ?? args.path, async ({ path: absolute, before: raw, stamp, write }) => {
				const record = readRecord(ctx, absolute);
				if (!record?.stamp) return errorResult(`Read ${args.path} as text before editing it.`);
				if (record.partial) {
					return errorResult(
						`Your last read of ${args.path} did not show the whole file. Read the part you are changing with offset and limit before editing it.`,
					);
				}
				if (raw === null || !stamp) return errorResult(`File not found: ${args.path}`);
				if (changedSince(record, stamp)) return errorResult(`The file changed since you read it. Re-read ${args.path} before editing.`);

				const { text: before, layout } = decodeText(raw);
				if (args.old_string === "") return errorResult("`old_string` is empty. To fill an empty file or replace a whole file, use `write`.");
				const oldString = decodeInput(args.old_string, layout);
				const newString = decodeInput(args.new_string, layout);
				if (oldString === newString) return errorResult("`old_string` and `new_string` are identical, so this edit would do nothing.");

				const match = findEditMatch(before, oldString, Boolean(args.replace_all));
				if (match.status === "not_found") {
					return errorResult(
						`\`old_string\` was not found in ${args.path}. It must match exactly, including whitespace and indentation — copy it from what read showed, without the line-number prefix.`,
					);
				}
				if (match.status === "ambiguous") {
					return errorResult(
						`\`old_string\` does not match ${args.path} exactly, and ${match.count} places come close in different ways. Copy the text from what read showed, with enough around it to be unique.`,
					);
				}
				const target = match.actual;
				const replacement = replacementFor(match.strategy, oldString, target, newString);
				if (target === replacement) return errorResult("`old_string` and `new_string` are identical, so this edit would do nothing.");
				const occurrences = countOccurrences(before, target, Boolean(args.replace_all));
				if (occurrences > 1 && !args.replace_all) {
					return errorResult(
						`\`old_string\` appears ${occurrences} times in ${args.path}. Include more of the surrounding text to make it unique, or set replace_all: true.`,
					);
				}

				const after = args.replace_all ? before.split(target).join(replacement) : before.replace(target, () => replacement);
				const count = args.replace_all ? occurrences : 1;
				const diff = computeDiff(before, after);
				const shown = displayPath(ctx.cwd, resolveWorkspacePath(ctx.cwd, file ?? args.path, scratchDirsOf(ctx)));

				if (ctx.requestApproval) {
					const decision = await ctx.requestApproval({
						kind: "modify",
						title: `Edit ${shown}`,
						detail: formatDiff(diff, shown),
						subject: absolute,
					});
					if (decision !== "once" && decision !== "always") return declinedResult("The user rejected this edit.");
				}

				const written = await write(encodeText(after, layout));
				markRead(ctx, absolute, written.stamp);
				// 上下文一行而不是预览的三行：回显是为了省一次重读，不是为了审这次改动。
				const echo = changedView(computeDiff(before, after, 1), after);

				return {
					content: [
						{
							type: "text",
							text: `Edited ${file ? args.path : shown}: ${count} replacement${count === 1 ? "" : "s"}, +${diff.added} -${diff.removed}.${echo}`,
						},
					],
					// diff 那几项是通用声明（`FileDiffDetails`），转录的通用卡片按它画；`changeId` 是 `FileChangeDetails`。
					details: {
						kind: "edit",
						...(written.changeId ? { changeId: written.changeId } : {}),
						...({ path: shown, added: diff.added, removed: diff.removed, hunks: diff.hunks } satisfies FileDiffDetails),
					},
				};
			});
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}
	},
};

/** 超过这么多行，回显比它省下的那次重读还贵，只给行号范围。 */
const MAX_ECHO_LINES = 60;

/**
 * 改过的地方现在的样子。
 *
 * 不回显的话，模型几乎每次编辑后都要重读一遍这个文件：每次都把整段对话重发一遍，只为知道这条结果本来就知道的事。
 * 太长显示不全的行和 read 一样开窗口。
 */
function changedView(diff: FileDiff, after: string): string {
	const lines = after.endsWith("\n") ? after.slice(0, -1).split("\n") : after.split("\n");
	const blocks = diff.hunks.map((hunk) => hunk.lines.flatMap((line) => (line.newLine === undefined ? [] : [line.newLine])));
	const total = blocks.reduce((sum, block) => sum + block.length, 0);
	if (total === 0) return "";
	if (total > MAX_ECHO_LINES) {
		const spans = blocks.filter((block) => block.length).map((block) => `${block[0]}-${block.at(-1)}`);
		return `\nChanged regions now at lines ${spans.join(", ")}.`;
	}
	const width = String(Math.max(...blocks.flat())).length;
	const rendered = blocks.map((block) =>
		block
			.map((lineNo) => {
				const text = lines[lineNo - 1] ?? "";
				return `${String(lineNo).padStart(width, " ")}→${text.length <= MAX_LINE_CHARS ? text : formatCharWindow(text)}`;
			})
			.join("\n"),
	);
	return `\nNow reads:\n${rendered.join("\n     ⋯\n")}`;
}

function countOccurrences(haystack: string, needle: string, replaceAll: boolean): number {
	if (needle === "") return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		// 判唯一时重叠的也算；replace_all 只替换不重叠的。
		index = haystack.indexOf(needle, index + (replaceAll ? needle.length : 1));
	}
	return count;
}
