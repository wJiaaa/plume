import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { SEARCH_ALIASES } from "./args.ts";
import { errorResult } from "./result.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { globToRegExp } from "./glob.ts";
import { insideGitWorkTree, SKIP_DIRS } from "./project-files.ts";
import { formatMatchWindow, formatMatchWindowsAt, MAX_LINE_CHARS, utf8ByteOffsetsToIndices, type MatchOptions } from "./long-line.ts";
import { displayPath, looksBinary } from "./paths.ts";
import { describeGrep } from "./describe.ts";

const MAX_MATCHES = 200;
// 所有命中加起来约 3.4k token；再多就该把搜索收窄。
const MAX_OUTPUT_CHARS = 12_000;
/** ripgrep 的 stderr 全部读完，但只留这么多：一个总数和几个例子。 */
const ERROR_LINES_KEPT = 3;
const ERROR_LINE_CHARS = 200;

/**
 * 留着 文件:行号 的地址。长行留命中附近的窗口（不是前两千字），并给出 `char_offset`，read 能打开其余部分。
 * 知道这一行每处命中在哪（`matchesAt`）时，散在各处的命中各给一段，每段一行、都带同一个地址，见 `formatMatchWindowsAt`；
 * 几段仍算一条命中，条数上限和「省略了几条」照旧按行数。
 */
function shortenLine(line: string, pattern?: string, options?: MatchOptions, matchesAt?: readonly number[]): string {
	const { address, content } = splitGrepLine(line);
	const bodies = matchesAt?.length ? formatMatchWindowsAt(content, matchesAt) : [formatMatchWindow(content, pattern, options)];
	return bodies.map((body) => `${address}${body}`).join("\n");
}

/** 一行里正则的每一处命中，给兜底用：ripgrep 自己报每处位置，兜底的 `exec` 只找第一处。 */
function matchStarts(text: string, regex: RegExp, first: number): number[] {
	if (text.length <= MAX_LINE_CHARS) return [first];
	const global = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
	const starts: number[] = [];
	for (let found = global.exec(text); found; found = global.exec(text)) {
		starts.push(found.index);
		// 空匹配不前进的话会原地打转。
		if (found[0] === "") global.lastIndex++;
	}
	return starts.length > 0 ? starts : [first];
}

/** ripgrep 或兜底给的 `路径:行号:内容`。路径本身不开窗口。 */
function splitGrepLine(line: string): { address: string; content: string } {
	const found = line.match(/^(.+?:)(\d+:)(.*)$/s);
	if (!found) return { address: "", content: line };
	return { address: found[1]! + found[2]!, content: found[3]! };
}

/** 收集时每行已经缩短过；再缩一遍会把省略的字数换掉。 */
function boundCollectedLines(lines: string[]): string[] {
	const shown: string[] = [];
	let size = 0;
	for (const line of lines) {
		if (size + line.length + 1 > MAX_OUTPUT_CHARS) break;
		shown.push(line);
		size += line.length + 1;
	}
	return shown;
}

interface GrepArgs {
	pattern: string;
	description?: string;
	path?: string;
	glob?: string;
	case_insensitive?: boolean;
	context?: number;
	files_only?: boolean;
	limit?: number;
}

export const grepTool: Tool<GrepArgs> = {
	name: "grep",
	describe: describeGrep,
	kind: "search",
	aliases: SEARCH_ALIASES,
	description:
		"Search file contents with a regular expression. A matching line over 2000 characters comes back as a window around the hit, " +
		"with the `char_offset` that lets `read` open more of it. " +
		"Send the searches that do not depend on each other's results in one reply, instead of one search per reply.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Regular expression to search for." },
			description: { type: "string", description: "5-10 word description shown to the user, in plain words and the user's language — not the pattern." },
			path: { type: "string", description: "Directory or file to search. Defaults to the workspace root." },
			glob: { type: "string", description: "Only search files matching this glob, e.g. `**/*.ts`." },
			case_insensitive: { type: "boolean", description: "Ignore case." },
			context: { type: "number", description: "Lines of context around each match." },
			files_only: { type: "boolean", description: "List matching file paths instead of matching lines." },
			limit: { type: "number", description: "Maximum matches to return. Default 200." },
		},
		additionalProperties: true,
	},

	async execute(args, ctx): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";

		if (!pattern)
			return errorResult(
				'`pattern` is required (`description` is only shown to the user, never searched). Please specify the regex/pattern to search for in the `pattern` parameter, e.g. {"pattern": "your_regex"}.',
			);
		const normalizedArgs: GrepArgs = {
			...args,
			pattern,
			path: typeof args.path === "string" && args.path ? args.path : undefined,
		};

		let root = ctx.cwd;
		if (normalizedArgs.path) {
			// 只认路径，地址也按路径判：先换成绝对路径，本体就不会把它当地址。
			const authorized = await ctx.files.read(ctx.files.resolve(normalizedArgs.path));
			if (!authorized.ok) return errorResult(authorized.message);
			if (authorized.path) root = authorized.path;
			/*
			 * 路径不存在时 ripgrep 退出码 2，stderr 里那句 "No such file or directory" 又被截在 200 字之后，
			 * 交回去的就成了「No matches」：模型把猜错名字的文件当成搜过了、里面没有。先查一次，答它真正的情况。
			 */
			if (!(await stat(root).catch(() => null))) return errorResult(`Path not found: ${normalizedArgs.path}. Nothing was searched.`);
		}
		// 仓库里看到的文件和 `glob`、兜底是同一份：git 列的，隐藏的也在内。见 `project-files.ts`。按原文重试时同一份，只算一次。
		const scope = (await insideGitWorkTree(root)) ? ["--hidden", "--glob", "!.git"] : [];
		const viaRipgrep = await runRipgrep(normalizedArgs, root, ctx, false, scope);
		// 没有 ripgrep：按原文重试也起不来，直接走兜底。
		if (viaRipgrep === MISSING) return runFallback(normalizedArgs, root, ctx);
		if (viaRipgrep) return viaRipgrep;

		/*
		 * 不是正则的模式几乎总是想按原文搜。
		 *
		 * 模型会拿 `foo(bar`、`arr[0]` 这种代码片段来搜，搜失败了只会让它再试一次；按原文重试正好找到想要的。
		 * 重试也走 ripgrep：直接落到 JavaScript 的兜底会为 ripgrep 几毫秒就答得上的问题把整棵树走一遍。
		 */
		if (!compiles(normalizedArgs.pattern)) {
			const literally = await runRipgrep(normalizedArgs, root, ctx, true, scope);
			if (literally && literally !== MISSING) return literally;
		}
		return runFallback(normalizedArgs, root, ctx);
	},
};

/** 这个模式是不是正则，还是只是一段长得像正则的文字。 */
function compiles(pattern: string): boolean {
	try {
		return Boolean(new RegExp(pattern));
	} catch {
		return false;
	}
}

/**
 * 用哪个 ripgrep：环境变量 `PLUME_RIPGREP` 指的那份（桌面端把随安装包带的那份写在这里），没有就找 `PATH` 里的 `rg`。
 * 都没有就整个退回 JavaScript 兜底，慢几十倍，结果一样。
 */
function ripgrepCommand(): string {
	return process.env.PLUME_RIPGREP?.trim() || "rg";
}

/** 起不来 ripgrep（没装、找不到）：和「起来了但没搜成」（模式编译不了）分开，前者不必再试一次。 */
const MISSING = "missing";

/**
 * 只列文件用文本模式（一行一个路径），列命中的行用 JSON 模式。JSON 没搜成时不再换文本模式试：两次的模式、引擎一样，
 * 编译不了的照样编译不了。
 */
async function runRipgrep(args: GrepArgs, root: string, ctx: ToolContext, literal: boolean, scope: string[]): Promise<ToolResult | typeof MISSING | null> {
	const limit = Math.min(args.limit ?? MAX_MATCHES, MAX_MATCHES);
	if (args.files_only) return runRipgrepText(args, root, ctx, literal, limit, scope);
	return runRipgrepJson(args, root, ctx, literal, limit, scope);
}

/**
 * ripgrep 自己知道命中的位置（`submatches.start`），用它比在排好的行里再搜一遍准：
 * 环视或正则引擎不同时，再搜一遍会落回行首。
 */
async function runRipgrepJson(
	args: GrepArgs,
	root: string,
	ctx: ToolContext,
	literal: boolean,
	limit: number,
	scope: string[],
): Promise<ToolResult | typeof MISSING | null> {
	// `--crlf` 让 `$` 匹配在 `\r\n` 之前：没有它，`foo$` 永远匹配不到 CRLF 文件的行。
	const argv = ["--json", "--crlf", "--max-count", String(limit), ...scope];
	if (literal) argv.push("--fixed-strings");
	if (args.case_insensitive) argv.push("-i");
	if (args.context) argv.push("-C", String(args.context));
	if (args.glob) argv.push("--glob", args.glob);
	argv.push("--", args.pattern, root);
	let completed = false;
	// 每个文件的命中数：到了 `--max-count` 的文件被 ripgrep 截住了，总数就只是下限。
	const perFile = new Map<string, number>();
	let capped = false;
	/** 每一行出自哪个文件（绝对路径），和收到的行一一对应：密钥文件的行要按文件问过才留下，见 `withoutDenied`。 */
	const owners: string[] = [];
	const run = await collectRipgrep(
		argv,
		ctx,
		(line, lines, keep) => {
			let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: { start?: number }[] } };
			try {
				event = JSON.parse(line) as typeof event;
			} catch {
				return false;
			}
			// 收尾的事件，只有真的搜过才会写，见 `ripgrepResult`。
			if (event.type === "summary") completed = true;
			if (event.type !== "match" && event.type !== "context") return false;
			const pathText = event.data?.path?.text ?? "";
			if (event.type === "match") {
				const seen = (perFile.get(pathText) ?? 0) + 1;
				perFile.set(pathText, seen);
				if (seen >= limit) capped = true;
			}
			if (!keep) return true;
			const raw = (event.data?.lines?.text ?? "").replace(/\r?\n$/, "");
			const lineNo = event.data?.line_number ?? 0;
			const rel = displayPath(ctx.cwd, pathText);
			const byteStarts = event.type === "match" ? (event.data?.submatches ?? []).map((one) => one.start).filter((start) => typeof start === "number") : [];
			const matchesAt = byteStarts.length > 0 ? utf8ByteOffsetsToIndices(raw, byteStarts) : undefined;
			lines.push(shortenLine(`${rel}:${lineNo}:${raw}`, args.pattern, { literal, ignoreCase: args.case_insensitive }, matchesAt));
			owners.push(resolve(ctx.cwd, pathText));
			return true;
		},
		limit,
	);
	if (!run) return MISSING;
	const kept = await withoutDenied(run.lines, owners, ctx);
	const result = ripgrepResult(
		{ ...run, lines: kept.lines, count: run.count - (run.lines.length - kept.lines.length) },
		args,
		limit,
		literal,
		completed,
		capped,
	);
	return result && withDeniedNote(result, kept.denied, ctx.cwd);
}

/** 只列文件：一行一个路径。只有文件名、没有内容，不用为密钥文件问人。 */
async function runRipgrepText(
	args: GrepArgs,
	root: string,
	ctx: ToolContext,
	literal: boolean,
	limit: number,
	scope: string[],
): Promise<ToolResult | typeof MISSING | null> {
	const argv = ["--color=never", "--crlf", "--files-with-matches", ...scope];
	if (literal) argv.push("--fixed-strings");
	if (args.case_insensitive) argv.push("-i");
	if (args.glob) argv.push("--glob", args.glob);
	argv.push("--", args.pattern, root);
	const run = await collectRipgrep(
		argv,
		ctx,
		(line, lines, keep) => {
			if (!keep) return true;
			// 一行就是一个路径，和 JSON 模式一样写成相对工作区、`/` 分隔的。
			lines.push(shortenLine(displayPath(ctx.cwd, line), args.pattern, { literal, ignoreCase: args.case_insensitive }));
			return true;
		},
		limit,
	);
	return run ? ripgrepResult(run, args, limit, literal) : MISSING;
}

/**
 * 命中的行里出自密钥文件的（ssh 私钥、Plume 的设置和凭据……，见 `RunFiles`）：批准过搜索的根不算数，按文件问一次，
 * 不批准的那些行拿掉。别的文件在已经过了边界的根下面，`read` 直接放行、不问。只有文件名的结果（`files_only`）不用问。
 */
async function withoutDenied(lines: string[], owners: readonly string[], ctx: ToolContext): Promise<{ lines: string[]; denied: string[] }> {
	const denied = new Set<string>();
	for (const owner of new Set(owners)) if (!(await ctx.files.read(owner)).ok) denied.add(owner);
	if (denied.size === 0) return { lines, denied: [] };
	return { lines: lines.filter((_line, index) => !denied.has(owners[index] as string)), denied: [...denied] };
}

/** 拿掉了哪几个文件的命中，照实说：不说的话，模型会以为那些文件里没有。 */
function withDeniedNote(result: ToolResult, denied: readonly string[], cwd: string): ToolResult {
	if (denied.length === 0) return result;
	// i18n-exempt：工具结果是发给模型的。
	const note = `\n\n[matches in ${denied.map((path) => displayPath(cwd, path)).join(", ")} are not shown: the user did not allow reading ${denied.length === 1 ? "that file" : "those files"}]`;
	return {
		...result,
		content: result.content.map((part, index) => (index === result.content.length - 1 && part.type === "text" ? { ...part, text: part.text + note } : part)),
	};
}

/** 一次 ripgrep 留下的：退出码、收到的行、stderr 的样本。 */
interface RipgrepRun {
	code: number | null;
	lines: string[];
	count: number;
	errors: { total: number; first: string[] };
	/** 再多也显示不下了，由这边叫停的；这时 `count` 只是下限。 */
	stopped: boolean;
}

/**
 * ripgrep 真的搜了没有，搜了的话结果是什么。
 *
 * 退出码 2 是「出错了」，ripgrep 用它说两件事。一是它的引擎编译不了这个模式，什么都没搜、stdout 是空的，
 * 得落到按原文重试或 JavaScript 引擎（它有 ripgrep 没有的环视）。二是搜到了底、有些路径读不了，命中照样有；
 * 这种不该扔掉再用慢的扫一遍。有命中、或者 JSON 流里有收尾的 `summary`，就说明搜过了，读不了的一并说出来。
 */
function ripgrepResult(run: RipgrepRun, args: GrepArgs, limit: number, literal: boolean, completed = false, capped = false): ToolResult | null {
	const ran = run.stopped || run.code === 0 || run.code === 1 || (run.code === 2 && (run.count > 0 || completed));
	if (!ran) return null;
	return formatMatches(run.lines, args, limit, literal, run.count, run.code === 2 || run.stopped ? describeErrors(run.errors) : "", capped || run.stopped);
}

function describeErrors(errors: RipgrepRun["errors"]): string {
	if (errors.total === 0) return "";
	const more = errors.total > errors.first.length ? `\n… ${errors.total - errors.first.length} more` : "";
	return (
		`[ripgrep reported ${errors.total} error${errors.total === 1 ? "" : "s"}; anything in the paths it could not read ` +
		`is missing from these results:\n${errors.first.join("\n")}${more}]`
	);
}

function collectRipgrep(
	argv: string[],
	ctx: ToolContext,
	onLine: (line: string, lines: string[], keep: boolean) => boolean,
	limit: number,
): Promise<RipgrepRun | null> {
	return new Promise<RipgrepRun | null>((resolve) => {
		let child: ChildProcessByStdio<null, Readable, Readable>;
		try {
			/*
			 * 每个流都有人管。stderr 没人读的话，搜 `/proc`、`C:\Windows` 时每个读不了的路径一条权限错误，
			 * 超过管道缓冲（约 64KB）ripgrep 就卡在写上永远不退出。stdin 关掉，ripgrep 没什么可等；
			 * `windowsHide` 不让控制台窗口闪一下。
			 */
			child = spawn(ripgrepCommand(), argv, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch {
			resolve(null);
			return;
		}

		const lines: string[] = [];
		let count = 0;
		let failed = false;
		let full = false;
		let size = 0;
		const errors: RipgrepRun["errors"] = { total: 0, first: [] };
		const reader = createInterface({ input: child.stdout });
		reader.on("line", (line) => {
			if (!line || full) return;
			const before = lines.length;
			if (onLine(line, lines, lines.length < limit)) count++;
			for (let i = before; i < lines.length; i++) size += lines[i]!.length + 1;
			/*
			 * 收满了就让 ripgrep 停下。`--max-count` 是每个文件的上限，不是总数：200 条早就收齐了，
			 * ripgrep 还会把整棵树扫完，每一行都送过来再被这里 JSON.parse 一遍然后丢掉。字符闸门满了
			 * 也一样——再多的行也显示不出来。停下以后剩下的命中数不知道，所以结果标成 `stopped`，
			 * 照实说「可能还有」。
			 */
			if (lines.length >= limit || size > MAX_OUTPUT_CHARS) {
				full = true;
				child.kill();
			}
		});
		const errorReader = createInterface({ input: child.stderr });
		errorReader.on("line", (line) => {
			if (!line.trim()) return;
			errors.total++;
			if (errors.first.length < ERROR_LINES_KEPT) errors.first.push(line.slice(0, ERROR_LINE_CHARS));
		});
		child.on("error", () => {
			failed = true;
			resolve(null);
		});
		const abort = () => {
			child.kill("SIGKILL");
		};
		ctx.signal?.addEventListener("abort", abort, { once: true });
		if (ctx.signal?.aborted) abort();

		child.on("close", (code) => {
			ctx.signal?.removeEventListener("abort", abort);
			reader.close();
			errorReader.close();
			if (failed) return;
			resolve({ code, lines, count, errors, stopped: full });
		});
	});
}

async function runFallback(args: GrepArgs, root: string, ctx: ToolContext): Promise<ToolResult> {
	let regex: RegExp;
	let literal = false;
	try {
		regex = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
	} catch {
		// 和 ripgrep 的重试同一个道理：编译不了的模式是想按原文搜。
		literal = true;
		try {
			const escaped = args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			regex = new RegExp(escaped, args.case_insensitive ? "i" : "");
		} catch (error) {
			return errorResult(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const limit = Math.min(args.limit ?? MAX_MATCHES, MAX_MATCHES);
	const globRegex = args.glob ? globToRegExp(args.glob) : null;
	// ripgrep 的 `--glob` 照 gitignore 的规矩：不带 `/` 的模式比文件名，任意深度都算；带了才比整条路径。
	const globTarget = args.glob?.includes("/") ? (rel: string) => rel : (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
	const lines: string[] = [];
	/** 同 JSON 模式：每一行出自哪个文件，`files_only` 不记。 */
	const owners: string[] = [];
	const contextLines = args.context ?? 0;

	const scanFile = async (path: string): Promise<void> => {
		if (lines.length >= limit) return;
		const buffer = await readFile(path).catch(() => null);
		if (!buffer || looksBinary(buffer)) return;
		const rel = displayPath(ctx.cwd, path);
		/*
		 * 按 ripgrep（带 `--crlf`）的方式分行：`\r\n` 结束一行，开头的 UTF-8 BOM 不是文字。
		 * 只按 `\n` 分的话，CRLF 文件每行都带着 `\r`，挡住 `$`；BOM 挡在第一行的 `^` 前面。
		 */
		const text = buffer.toString("utf8");
		const fileLines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split(/\r?\n/);
		/*
		 * 已经输出到第几行。相邻两处命中的上下文重叠时，重叠的行只出一次，和 ripgrep 一样；
		 * 各吐各的话同一段会出现好几遍，看着像命中比实际多得多。
		 */
		let shownTo = -1;

		for (let i = 0; i < fileLines.length && lines.length < limit; i++) {
			const found = regex.exec(fileLines[i]!);
			if (!found) {
				regex.lastIndex = 0;
				continue;
			}
			regex.lastIndex = 0;
			if (args.files_only) {
				lines.push(shortenLine(rel));
				return;
			}
			const opts = { literal, ignoreCase: args.case_insensitive };
			const last = Math.min(fileLines.length - 1, i + contextLines);
			for (let c = Math.max(0, i - contextLines, shownTo + 1); c <= last; c++) {
				const matchesAt = c === i ? matchStarts(fileLines[c]!, regex, found.index) : undefined;
				lines.push(shortenLine(`${rel}:${c + 1}:${fileLines[c]}`, args.pattern, opts, matchesAt));
				owners.push(path);
			}
			shownTo = Math.max(shownTo, last);
		}
	};

	const walk = async (dir: string): Promise<void> => {
		if (lines.length >= limit || ctx.signal?.aborted) return;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				await walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = relative(root, full).split(sep).join("/");
			if (globRegex && !globRegex.test(globTarget(rel))) continue;
			await scanFile(full);
		}
	};

	if ((await stat(root).catch(() => null))?.isFile()) await scanFile(root);
	else {
		const listed = await ctx.projectFiles(root);
		if (!listed) await walk(root);
		else
			for (const full of listed) {
				if (lines.length >= limit || ctx.signal?.aborted) break;
				if (globRegex && !globRegex.test(globTarget(relative(root, full).split(sep).join("/")))) continue;
				await scanFile(full);
			}
	}
	// 满了就停，没扫完的部分还有多少命中不知道——所以要说「可能还有」，不能当成全部。
	const stopped = lines.length >= limit;
	const kept = args.files_only ? { lines, denied: [] } : await withoutDenied(lines, owners, ctx);
	return withDeniedNote(formatMatches(kept.lines, args, limit, literal, kept.lines.length, "", stopped), kept.denied, ctx.cwd);
}

/**
 * @param literal 模式不是合法正则、按原文搜的。结果里要说出来：不说的话，元字符被悄悄解除的搜索读起来像照写的搜了、没搜到。
 * @param warning 搜索没覆盖到的，原样附在后面，见 `describeErrors`。
 * @param stopped 搜索在上限处停下了，`count` 只是下限。
 */
function formatMatches(lines: string[], args: GrepArgs, limit: number, literal = false, count = lines.length, warning = "", stopped = false): ToolResult {
	const note = literal ? `\`${args.pattern}\` is not a valid regular expression, so it was searched for literally.` : "";
	const trailer = warning ? `\n\n${warning}` : "";
	if (lines.length === 0) {
		const text = (literal ? `${note}\nNo matches.` : `No matches for /${args.pattern}/.`) + trailer;
		return {
			content: [{ type: "text", text }],
			details: { kind: "grep", pattern: args.pattern, count: 0, literal },
			/* 什么都没搜到的结果，之后不会有人再问。 */
			uneventful: true,
		};
	}
	const shown = boundCollectedLines(lines.slice(0, limit));
	const header = literal ? `${note}\n\n` : "";
	// 停在字符闸门上而不是条数上时，「hit the 200-match limit」就是假话：只收了几条长行。
	const reason = shown.length < Math.min(count, limit) ? `the ${MAX_OUTPUT_CHARS}-character output limit` : `the ${limit}-match limit`;
	const footer = stopped
		? `\n\n[truncated: hit ${reason}${count > shown.length ? `, and ${count - shown.length} collected lines are not shown` : ""}; more matches may exist — narrow pattern, path or glob]`
		: count > shown.length
			? `\n\n[truncated: ${count - shown.length} collected matching/context lines omitted; narrow pattern, path or glob]`
			: "";
	return {
		content: [{ type: "text", text: header + shown.join("\n") + footer + trailer }],
		details: { kind: "grep", pattern: args.pattern, count, matches: shown, literal, ...(stopped ? { stopped: true } : {}) },
	};
}
