import { realpath, stat } from "node:fs/promises";
import { computeDiff, formatDiff } from "../diff.ts";
import { withTextFile } from "./file-write.ts";
import { displayPath, resolveWorkspacePath, scratchDirsOf } from "./paths.ts";
import { resourceScope, scratchFile } from "./scratch-file.ts";
import { changedSince, markRead, readRecord } from "./read-state.ts";
import { declinedResult, errorResult } from "./result.ts";
import { decodeInput, decodeText, encodeText } from "./text-layout.ts";
import type { Tool, ToolResult } from "./types.ts";

interface WriteArgs {
	path: string;
	content: string;
}

export const writeTool: Tool<WriteArgs> = {
	name: "write",
	description: "Write a whole file, creating parent directories. To change part of an existing file use `edit`; read an existing file before overwriting it.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, absolute or relative to the workspace root." },
			content: { type: "string", description: "Complete file contents." },
		},
		required: ["path", "content"],
		additionalProperties: false,
	},
	mutating: true,

	async execute(args, ctx): Promise<ToolResult> {
		if (typeof args.content !== "string") return errorResult("`content` must be a string.");

		/*
		 * 可写的地址只有一个（`scratch://`），其余的拒掉正是要的：能 `write skill://<名字>` 的模型就能改掉它该遵守的说明，
		 * 而那次修改看起来和别的工具调用没两样。改技能走文件系统，那里有人自己对 diff 的审核。
		 */
		if (ctx.resources?.canResolve(args.path)) {
			try {
				await ctx.resources.write(args.path, args.content, resourceScope(ctx));
				// 刚写的它看过了：紧接着 edit 同一个地址不该要求先读。
				const file = await scratchFile(ctx, args.path);
				if (file) markRead(ctx, await realpath(file), await stat(file));
				return {
					content: [{ type: "text", text: `Wrote ${args.path} (${args.content.length} characters).` }],
					details: { kind: "resource", url: args.path },
				};
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		}

		/*
		 * 不吃 `ctx.allowedPaths`：那是「给你看一眼」，不是「可以改」。拖一个文件进来的意思是让模型读它，
		 * 把同一份许可接到写这一侧，等于一次「你看看我的 ~/.zshrc」就换来了对它的写权限。
		 */
		try {
			return await withTextFile<ToolResult>(ctx, args.path, async ({ path: absolute, before, stamp, write }) => {
				const alreadyExists = before !== null;
				const previous = alreadyExists ? decodeText(before) : null;
				const record = readRecord(ctx, absolute);
				if (stamp && (!record || changedSince(record, stamp) || record.partial)) {
					return errorResult(`Read the current text of ${args.path} before overwriting it.`);
				}
				const content = previous ? decodeInput(args.content.replace(/^\uFEFF/, ""), previous.layout) : args.content;
				const written = previous ? encodeText(content, previous.layout) : content;
				const after = decodeText(written).text;
				const diff = computeDiff(previous?.text ?? "", after);
				const shown = displayPath(ctx.cwd, resolveWorkspacePath(ctx.cwd, args.path, scratchDirsOf(ctx)));

				if (ctx.requestApproval) {
					const decision = await ctx.requestApproval({
						kind: "write",
						title: alreadyExists ? `Overwrite ${shown}` : `Create ${shown}`,
						detail: formatDiff(diff, shown),
						subject: absolute,
					});
					if (decision !== "once" && decision !== "always") return declinedResult("The user rejected this write.");
				}

				const { stamp: writtenStamp, changeId } = await write(written);
				const lines = after === "" ? 0 : after.split("\n").length;
				markRead(ctx, absolute, writtenStamp);

				return {
					content: [
						{
							type: "text",
							text: `${alreadyExists ? "Updated" : "Created"} ${shown} (${lines} lines).`,
						},
					],
					details: {
						kind: "write",
						...(changeId ? { changeId } : {}),
						path: shown,
						created: !alreadyExists,
						added: diff.added,
						removed: diff.removed,
						hunks: diff.hunks,
					},
				};
			});
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}
	},
};
