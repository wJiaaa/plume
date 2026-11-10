/**
 * 源码文件的结构视图：声明留着，实现折起来。
 *
 * 为了知道一个 300 行的文件导出了什么而读它，要花 300 行上下文，而且不只是 token：想要的答案埋在了用不上的代码里。
 * 一个会话里读二十次这样的文件，大半个上下文窗口就花在了没人看第二眼的东西上。
 *
 * 所以不带窗口地读一个长源码文件，返回它的形状：import、声明、解释它们的注释，原来实现的地方留一个标记。
 * 页脚说清楚怎么拿回任何一段，还说绝不要猜折起来的内容——模型当成完整的摘要比没有摘要更糟。
 *
 * 折不好就不折：文件认不出足够的结构，或者折了也省不了多少，调用方拿到原文。错的大纲比长文件贵得多。
 */

import { charWindow, formatCharWindow, MAX_LINE_CHARS } from "./long-line.ts";

/** 这些扩展名的声明认得出来。 */
const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".swift",
	".rb",
	".php",
	".c",
	".h",
	".cc",
	".cpp",
	".hpp",
	".cs",
	".scala",
	".sh",
	".sql",
	".vue",
	".svelte",
]);

/** 声明的写法，按优先级排。 */
const PATTERNS: { kind: string; re: RegExp }[] = [
	{ kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
	{ kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/ },
	{ kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
	// `export const foo = (…) =>` 和 `export const Foo: Type = {` 都算定义。
	{ kind: "const", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
	{ kind: "func", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/ },
	{ kind: "def", re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
	{ kind: "struct", re: /^\s*(?:pub\s+)?(?:struct|trait|impl|enum)\s+([A-Za-z_][\w]*)/ },
	{ kind: "method", re: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\(/ },
];

/**
 * 短于这些行不折：折了模型多半要再按范围读一次，每次都把整段对话重发一遍，比直接给原文贵。
 */
const MIN_LINES = 300;
/** 短于这么多行的一段照原样：标记和这几行一样占地方。 */
const MIN_RUN = 4;
/** 折掉的不到文件的这么多，就给原文。 */
const MIN_SAVING = 0.3;

export interface Outline {
	text: string;
	/** 模型看得见的行数。 */
	shownLines: number;
	/** 换成标记的行数。 */
	foldedLines: number;
	/** 按窗口显示的长行；页脚据此提 char_offset。 */
	longLines: { line: number; length: number; shownFrom: number; shownTo: number }[];
}

/** 这个文件的语言，声明认不认得出来。 */
function isOutlineable(path: string): boolean {
	const dot = path.lastIndexOf(".");
	return dot !== -1 && CODE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

const IMPORT_RE = /^\s*(?:import|export|from|use|using|require|package|#include|require_relative)\b/;
const DOC_OPEN_RE = /^\s*\/\*\*?/;
const DOC_CLOSE_RE = /\*\/\s*$/;
const LINE_COMMENT_RE = /^\s*(?:\/\/|#|--)/;
/** 缩进浅的右括号是结构不是实现：留着它形状才看得清。 */
const CLOSER_RE = /^[\t ]{0,2}[)}\]]+[;,]?\s*$/;

/** 缩进有几层，四个空格算一层。 */
function depthOf(line: string): number {
	const indent = /^[\t ]*/.exec(line)?.[0] ?? "";
	return indent.replaceAll("    ", "\t").replaceAll(" ", "").length;
}

/**
 * 这一行是结构还是实现。
 *
 * 绑定（`const` 这类）只认顶层的：函数体里的 `const step = compute()` 一样匹配，一个满是局部变量的函数会多出
 * 几十条「声明」，留下的比例超过门槛，整个文件就不折了。函数、类、类型、方法允许往里一层，类的成员在那里。
 */
function isDeclaration(line: string): boolean {
	const depth = depthOf(line);
	if (depth > 1) return false;
	for (const { kind, re } of PATTERNS) {
		if (!re.test(line)) continue;
		if (kind === "const" && depth > 0) continue;
		return true;
	}
	return false;
}

/**
 * 哪些行留下。
 *
 * 紧挨在声明上面的注释跟它一起留：文档注释往往是屏幕上信息最多的东西，把它和它说的那段分开，还不如都丢掉。
 */
function keepMask(lines: string[]): boolean[] {
	const keep = lines.map((line) => isDeclaration(line) || IMPORT_RE.test(line) || CLOSER_RE.test(line));

	for (let i = 0; i < lines.length; i++) {
		if (!keep[i]) continue;
		// 往上走过贴着的注释块，跟声明一起留。
		let j = i - 1;
		while (j >= 0 && !keep[j]) {
			const line = lines[j]!;
			if (LINE_COMMENT_RE.test(line) || DOC_CLOSE_RE.test(line) || DOC_OPEN_RE.test(line) || line.trim().startsWith("*") || line.trim() === "") {
				// 空行只有在注释块里面才留，在它前面的不留。
				if (line.trim() === "" && !(j > 0 && !keep[j - 1] && (LINE_COMMENT_RE.test(lines[j - 1]!) || lines[j - 1]!.trim().startsWith("*")))) break;
				keep[j] = true;
				if (DOC_OPEN_RE.test(line)) break;
				j -= 1;
				continue;
			}
			break;
		}
	}
	return keep;
}

/**
 * 组出大纲；原文是更好的回答时返回 null。
 *
 * `null` 不是失败，短文件、数据文件、认不出声明的文件都是这样，调用方给原文。
 */
export function outline(path: string, content: string, lines: string[]): Outline | null {
	if (!isOutlineable(path)) return null;
	if (lines.length < MIN_LINES) return null;

	const keep = keepMask(lines);
	const kept = keep.filter(Boolean).length;
	// 什么都认不出，或者全是声明：大纲帮不上忙。
	if (kept < 3 || kept / lines.length > 1 - MIN_SAVING) return null;

	const width = String(lines.length).length;
	const out: string[] = [];
	let folded = 0;
	let run: number[] = [];
	const displayed: number[] = [];
	const longLines: Outline["longLines"] = [];

	const show = (index: number) => {
		const line = lines[index]!;
		if (line.length > MAX_LINE_CHARS) {
			const window = charWindow(line, 0);
			longLines.push({ line: index + 1, length: line.length, shownFrom: window.start + 1, shownTo: window.end });
			out.push(`${String(index + 1).padStart(width, " ")}→${formatCharWindow(line)}`);
		} else {
			out.push(`${String(index + 1).padStart(width, " ")}→${line}`);
		}
		displayed.push(index + 1);
	};

	const flush = () => {
		if (run.length === 0) return;
		if (run.length < MIN_RUN) {
			// 太短，不值得一个标记，照样显示。
			for (const index of run) show(index);
		} else {
			out.push(`${" ".repeat(width)}  ⋯ ${run.length} lines (${run[0]! + 1}-${run[run.length - 1]! + 1})`);
			folded += run.length;
		}
		run = [];
	};

	for (let i = 0; i < lines.length; i++) {
		if (keep[i]) {
			flush();
			show(i);
		} else {
			run.push(i);
		}
	}
	flush();

	if (folded / lines.length < MIN_SAVING) return null;

	return { text: out.join("\n"), shownLines: displayed.length, foldedLines: folded, longLines };
}

/**
 * 告诉模型它在看什么、怎么拿到其余部分的那一行。
 *
 * 要紧的是「绝不要猜」：没有这句，模型会照样谈论它没见过的实现，被当成完整的大纲比整个文件更糟。
 */
// i18n-exempt：发给模型的话。
export function outlineFooter(path: string, result: Outline, totalLines: number): string {
	return (
		`\n\n[结构视图：显示 ${result.shownLines} 行声明，折叠 ${result.foldedLines} 行实现（共 ${totalLines} 行）。` +
		`需要某段实现时用 offset/limit 读它的行范围，例如 read ${path} offset=<起> limit=<行数>。` +
		(result.longLines.length > 0 ? `超长行只显示窗口，用 char_offset 继续。` : "") +
		`绝不要猜测 ⋯ 折叠掉的内容。]`
	);
}
