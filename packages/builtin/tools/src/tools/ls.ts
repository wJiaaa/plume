import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorResult } from "./result.ts";
import type { Tool, ToolResult } from "./types.ts";
import { displayPath } from "./paths.ts";
import { authorizeRead } from "./read-access.ts";
import { resourceScope } from "./scratch-file.ts";
import { describeLs } from "./describe.ts";

const MAX_ENTRIES = 400;

interface LsArgs {
	path?: string;
	all?: boolean;
}

export const lsTool: Tool<LsArgs> = {
	name: "ls",
	describe: describeLs,
	kind: "list",
	description: "List the contents of a directory, with directories first and file sizes shown.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Directory to list. Defaults to the workspace root." },
			all: { type: "boolean", description: "Include dotfiles." },
		},
		additionalProperties: false,
	},

	async execute(args, ctx): Promise<ToolResult> {
		let absolute = ctx.cwd;
		if (args.path) {
			// 和 read/edit/write 认同一批地址：不换成磁盘上的位置，`scratch://` 会被当成相对路径拼成 `<cwd>/scratch:/`。
			let located: string | null;
			try {
				located = ctx.resources ? await ctx.resources.locate(args.path, resourceScope(ctx)) : null;
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
			// 地址给的位置不问：落点已由 scheme 限在它自己的目录里（临时目录、技能目录），和 `read <scheme>://` 一样，问一次只是让人替它点头。
			if (located) absolute = located;
			else {
				const authorized = await authorizeRead(ctx, args.path);
				if (!authorized.ok) return errorResult(authorized.message);
				absolute = authorized.absolute;
			}
		}

		let entries: Dirent[];
		try {
			entries = await readdir(absolute, { withFileTypes: true });
		} catch {
			return errorResult(`Not a directory or not found: ${args.path ?? "."}`);
		}

		// 排序只看是不是目录和名字，readdir 的 dirent 就有；先排好截到 400 条，大小只给显示出来的文件取：
		// `node_modules/.pnpm` 这种几千项的目录，挨个 stat 完再丢掉大半是白等。
		const rows = entries
			.filter((entry) => args.all || !entry.name.startsWith("."))
			.map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
			.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
		const shown: { name: string; dir: boolean; size: number }[] = [];
		for (let at = 0; at < Math.min(rows.length, MAX_ENTRIES); at += 64) {
			const batch = rows.slice(at, Math.min(at + 64, MAX_ENTRIES));
			const sizes = await Promise.all(batch.map(async (row) => (row.dir ? 0 : ((await stat(join(absolute, row.name)).catch(() => null))?.size ?? 0))));
			batch.forEach((row, index) => shown.push({ ...row, size: sizes[index]! }));
		}

		const body = shown.map((r) => (r.dir ? `${r.name}/` : `${r.name}  (${formatSize(r.size)})`)).join("\n");
		const footer = rows.length > shown.length ? `\n\n[${rows.length - shown.length} more entries]` : "";

		return {
			content: [{ type: "text", text: (body || "(empty directory)") + footer }],
			uneventful: body === "",
			details: {
				kind: "ls",
				path: displayPath(ctx.cwd, absolute),
				entries: shown,
				truncated: rows.length > shown.length,
			},
		};
	},
};

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
