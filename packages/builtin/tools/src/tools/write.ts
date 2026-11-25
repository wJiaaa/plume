import { realpath, stat } from "node:fs/promises";
import type { FileDiffDetails } from "@plume/contract";
import { computeDiff } from "@plume/platform";
import { formatDiff } from "../diff.ts";
import { displayPath, isAddress } from "./paths.ts";
import { changedSince, markRead, readRecord } from "./read-state.ts";
import { declinedResult, errorResult } from "./result.ts";
import { decodeInput, decodeText, encodeText } from "./text-layout.ts";
import type { Tool, ToolResult } from "./types.ts";
import { describeWrite } from "./describe.ts";

interface WriteArgs {
	path: string;
	content: string;
}

export const writeTool: Tool<WriteArgs> = {
	name: "write",
	describe: describeWrite,
	// 改文件：成功一次就是工作区有了实打实的进展，本体的重复检测从头数。
	kind: "create",
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
		if (isAddress(ctx.resources, args.path)) {
			const wrote = await ctx.files.write(args.path, args.content);
			if (!wrote.ok) return errorResult(wrote.message);
			try {
				// 刚写的它看过了：紧接着 edit 同一个地址不该要求先读。
				if (wrote.path) markRead(ctx, await realpath(wrote.path), await stat(wrote.path));
			} catch {
				// 记不下读过只是之后的 edit 要先读一遍。
			}
			return {
				content: [{ type: "text", text: `Wrote ${args.path} (${args.content.length} characters).` }],
				details: { kind: "resource", url: args.path },
			};
		}

		/*
		 * 不认附件（`ToolRun.allowedPaths`）：那是「给你看一眼」，不是「可以改」。拖一个文件进来的意思是让模型读它，
		 * 把同一份许可接到写这一侧，等于一次「你看看我的 ~/.zshrc」就换来了对它的写权限。
		 */
		try {
			const {
				value,
				path: absolute,
				written: writtenStamp,
			} = await ctx.files.change<ToolResult>(args.path, async ({ path: absolute, text: before, stamp }) => {
				const alreadyExists = before !== null;
				const previous = alreadyExists ? decodeText(before) : null;
				const record = readRecord(ctx, absolute);
				/*
				 * 三种情况各说各的，和 edit 一样：只说「先读」的话，读出大纲的模型照原样再读一次，又是大纲，又被拒，一轮轮白跑。
				 * 指明窗口的读（`offset`/`limit`）不算只看了一部分，见 `read.ts`。
				 */
				if (stamp && !record) return { value: errorResult(`Read the current text of ${args.path} before overwriting it.`) };
				if (stamp && record?.partial) {
					return {
						value: errorResult(
							`Your last read of ${args.path} showed only part of it (an outline, or cut off at a limit). ` +
								"Read it again with offset and limit before overwriting it, or change just the part you need with edit.",
						),
					};
				}
				if (stamp && record && changedSince(record, stamp)) {
					return { value: errorResult(`${args.path} changed since you read it. Read it again before overwriting it.`) };
				}
				const content = previous ? decodeInput(args.content.replace(/^\uFEFF/, ""), previous.layout) : args.content;
				const written = previous ? encodeText(content, previous.layout) : content;
				const after = decodeText(written).text;
				const diff = computeDiff(previous?.text ?? "", after);
				const shown = displayPath(ctx.cwd, ctx.files.resolve(args.path));
				// 通用声明（`FileDiffDetails`）：审批卡和转录的通用卡片都按它画 diff。
				const declared: FileDiffDetails = { path: shown, added: diff.added, removed: diff.removed, hunks: diff.hunks };

				if (ctx.requestApproval) {
					const decision = await ctx.requestApproval({
						kind: "create",
						title: alreadyExists ? `Overwrite ${shown}` : `Create ${shown}`,
						detail: formatDiff(diff, shown),
						diff: declared,
						subject: absolute,
					});
					if (decision !== "once" && decision !== "always") return { value: declinedResult(ctx) };
				}

				const lines = after === "" ? 0 : after.split("\n").length;
				const result: ToolResult = {
					content: [
						{
							type: "text",
							text: `${alreadyExists ? "Updated" : "Created"} ${shown} (${lines} lines).`,
						},
					],
					// 改了哪个文件由本体记在结果上（`ToolOutput.changes`）。
					details: { kind: "write", created: !alreadyExists, ...declared },
				};
				return { text: written, value: result };
			});
			if (writtenStamp) markRead(ctx, absolute, writtenStamp);
			return value;
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}
	},
};
