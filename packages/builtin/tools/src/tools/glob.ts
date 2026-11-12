import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { SEARCH_ALIASES } from "./args.ts";
import { errorResult } from "./result.ts";
import type { Tool, ToolResult } from "./types.ts";
import { displayPath } from "./paths.ts";
import { gitListedFiles, SKIP_DIRS } from "./project-files.ts";
import { authorizeRead } from "./read-access.ts";
import { describeGlob } from "./describe.ts";

const MAX_RESULTS = 500;
/**
 * 按修改时间排序最多对多少个匹配做 stat。遍历本身一直走完（只 readdir，便宜），所以总数是准的；
 * 超过这个数时排序只覆盖先找到的这些，结果里明说。
 */
const SORT_CAP = 10_000;

interface GlobArgs {
	pattern: string;
	description?: string;
	path?: string;
	limit?: number;
}

export const globTool: Tool<GlobArgs> = {
	name: "glob",
	describe: describeGlob,
	kind: "find",
	aliases: SEARCH_ALIASES,
	description:
		"Find files by name, newest first; to search contents, use grep. Supports `*`, `?`, `**` and `{a,b}`, e.g. `src/**/*.{ts,tsx}`. " +
		"Skips files git ignores (outside a git repository: build and dependency directories). " +
		"Files that share a directory come under one line ending in `/`, indented by their names alone: the path of each is that line plus the name. " +
		"Several patterns worth trying go out together in one reply.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Glob pattern, relative to the search root." },
			description: { type: "string", description: "5-10 word description shown to the user, in plain words and the user's language — not the pattern." },
			path: { type: "string", description: "Directory to search. Defaults to the workspace root." },
			limit: { type: "number", description: "Maximum number of matches. Default 500." },
		},
		additionalProperties: true,
	},

	async execute(args, ctx): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		const path = typeof args.path === "string" ? args.path : "";

		let root = ctx.cwd;
		if (path) {
			const authorized = await authorizeRead(ctx, path);
			if (!authorized.ok) return errorResult(authorized.message);
			root = authorized.absolute;
		}
		if (!pattern)
			return errorResult(
				'`pattern` is required (`description` is only shown to the user, never searched). Please specify the glob pattern to search for in the `pattern` parameter, e.g. {"pattern": "**/*.ts"}.',
			);

		const regex = globToRegExp(pattern);
		const limit = Math.min(args.limit ?? MAX_RESULTS, MAX_RESULTS);
		const found: string[] = [];
		let total = 0;
		// 模式按搜索目录匹配（`path: "src"` 配 `**/*.tsx`），记下的是绝对路径，报出去时再相对工作区根写。
		const consider = (full: string): void => {
			if (!regex.test(relative(root, full).split(sep).join("/"))) return;
			total++;
			if (found.length < SORT_CAP) found.push(full);
		};

		const walk = async (dir: string): Promise<void> => {
			if (ctx.signal?.aborted) return;
			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (SKIP_DIRS.has(entry.name)) continue;
					// 隐藏目录只在模式点名要它时才进。
					if (entry.name.startsWith(".") && !pattern.includes("/.") && !pattern.startsWith(".")) continue;
					await walk(full);
					continue;
				}
				if (!entry.isFile()) continue;
				consider(full);
			}
		};

		const listed = await gitListedFiles(root);
		if (listed) for (const full of listed) consider(full);
		else await walk(root);
		const matches: { path: string; mtime: number }[] = [];
		for (let at = 0; at < found.length; at += 64) {
			const batch = found.slice(at, at + 64);
			const infos = await Promise.all(batch.map((full) => stat(full).catch(() => null)));
			batch.forEach((full, index) => matches.push({ path: displayPath(ctx.cwd, full), mtime: infos[index]?.mtimeMs ?? 0 }));
		}
		matches.sort((a, b) => b.mtime - a.mtime);
		const shown = matches.slice(0, limit);

		if (shown.length === 0) {
			return {
				content: [{ type: "text", text: `No files match ${pattern}.` }],
				details: { kind: "glob", count: 0 },
				uneventful: true,
			};
		}

		const footer =
			total > found.length
				? `\n\n[${total} matches in total, ${total - shown.length} not shown; newest-first covers only the first ${found.length} found — narrow the pattern or path]`
				: total > shown.length
					? `\n\n[${total - shown.length} more matches not shown]`
					: "";
		return {
			content: [{ type: "text", text: byDirectory(shown.map((m) => m.path)) + footer }],
			details: { kind: "glob", pattern, count: total, files: shown.map((m) => m.path) },
		};
	},
};

/**
 * 同一个目录只写一次的路径列表。
 *
 * 平铺的列表每行都重复目录：一个 Java 模块列出来大半是同一串 `src/main/java/com/…`。按目录分组能小一半多。
 * 只有一个命中的目录写完整路径：为一个名字写一行目录什么也省不了，还多一件要拼回去的事。
 *
 * 新的在前照旧：目录排在它最新那个文件本来的位置，目录下的文件保持原来的顺序。
 */
export function byDirectory(paths: readonly string[]): string {
	const groups = new Map<string, string[]>();
	for (const path of paths) {
		const cut = path.lastIndexOf("/");
		const dir = cut === -1 ? "" : path.slice(0, cut + 1);
		const names = groups.get(dir);
		if (names) names.push(path.slice(cut + 1));
		else groups.set(dir, [path.slice(cut + 1)]);
	}
	const lines: string[] = [];
	for (const [dir, names] of groups) {
		if (names.length === 1 || !dir) lines.push(...names.map((name) => dir + name));
		else lines.push(dir, ...names.map((name) => `  ${name}`));
	}
	return lines.join("\n");
}

/**
 * glob 换成正则。
 *
 * `**` 跨目录，`*` 和 `?` 不跨，`{a,b}` 展开成多选一，`[abc]`、`[a-z]`、`[!x]`（或 `[^x]`）是字符类，和 ripgrep 的
 * `--glob` 一样读。其余都转义，`src/v1.2/*.ts` 这样的模式混不进正则语法。
 */
export function globToRegExp(pattern: string): RegExp {
	return new RegExp(`^${globSource(pattern)}$`);
}

function globSource(pattern: string): string {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i]!;
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				// `**/` 也要能匹配零层目录，`**/*.ts` 才找得到根目录下的 `a.ts`。
				if (pattern[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 3;
					continue;
				}
				out += ".*";
				i += 2;
				continue;
			}
			out += "[^/]*";
			i += 1;
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			i += 1;
			continue;
		}
		if (char === "[") {
			const close = classEnd(pattern, i);
			if (close !== -1) {
				out += charClass(pattern.slice(i + 1, close));
				i = close + 1;
				continue;
			}
		}
		if (char === "{") {
			const close = pattern.indexOf("}", i);
			if (close !== -1) {
				const options = pattern.slice(i + 1, close).split(",");
				// 每一项照样是 glob：`{*.test.ts,*.spec.ts}` 里的 `*` 是通配符。
				out += `(?:${options.map(globSource).join("|")})`;
				i = close + 1;
				continue;
			}
		}
		out += escapeRegex(char);
		i += 1;
	}
	return out;
}

/** 在 `open` 处开始的字符类在哪里结束；没有结束时是 -1，`[` 就只是个字符。紧跟在 `[` 或 `[!` 后面的 `]` 是成员。 */
function classEnd(pattern: string, open: number): number {
	let j = open + 1;
	if (pattern[j] === "!" || pattern[j] === "^") j += 1;
	if (pattern[j] === "]") j += 1;
	return pattern.indexOf("]", j);
}

/** glob 的字符类换成正则的。取反的也不匹配 `/`，和 `?` 一样。 */
function charClass(body: string): string {
	const negated = body.startsWith("!") || body.startsWith("^");
	const members = (negated ? body.slice(1) : body).replace(/[\\\][^]/g, "\\$&");
	return negated ? `[^/${members}]` : `[${members}]`;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
