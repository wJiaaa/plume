/**
 * 一次删除删掉了什么。
 *
 * `rm`、PowerShell 和 cmd 的删除命令、带 `-delete`、`-exec` 的 `find` 最后都是同一个问题（哪些路径没了），所以由同一条规则、在同一个地方回答。
 * 「什么是莽撞的目标」写两份，就多一个答案走样的地方。
 *
 * 这里每个函数拿到的都是引号已经解掉的词（`risk.ts` 只拼一次）：`rm -rf '/'` 删的是 `/`，看到 `'/'` 的规则什么都没认出来。
 */

import { isAbsolute } from "node:path";
import { SAFE, risky, underScratchRoot, wipesScratchRoot, type RiskVerdict } from "./risk-shared.ts";

/** 在哪个平台的写法下是绝对路径：`/x`、`\x`、`C:\x`、`C:/x`、Git Bash 的 `/c/x`。 */
const absoluteAnywhere = (path: string) => isAbsolute(path) || /^([A-Za-z]:[\\/]|[\\/])/.test(path);

/**
 * 作为一段路径的 `..`。
 *
 * 反斜杠也当分隔符：bash 里它是转义，`..\..` 其实是一个叫 `....` 的目录，按往外走算是往保守的一边错。
 */
export const climbsOut = (path: string) => path.split(/[\\/]/).includes("..");

/**
 * shell 还没展开的路径：`$HOME`、`${DIR}`、PowerShell 的 `$env:USERPROFILE`、cmd 的 `%USERPROFILE%`。删的是什么要到运行时
 * 才定，所以按它可能的最坏情况判。
 */
const unexpanded = (target: string) => /\$|%[^%\s]+%/.test(target);

/** PowerShell 和 cmd 的删除命令，按小写登记。`rm` 按 POSIX 那条规则判。 */
export const WINDOWS_DELETERS = new Set(["remove-item", "ri", "del", "erase", "rd", "rmdir"]);

/**
 * 前面什么都没有的通配符。
 *
 * `rm -rf *` 是工作目录和里面的一切，人们警告 `rm -rf` 时说的就是它。`rm -rf server/data/uploads/*` 是在清空一个有名字的目录，
 * 重新灌数据库、清上传目录就长这样，不比删掉那个目录更危险。两者当成一回事，日常的收拾就会让无人值守的运行停下来。
 *
 * 判法是去掉通配的那几段以后还剩不剩东西：`*` 和 `./*` 什么都不剩，`a/b/*` 剩下 `a/b`。
 */
function bareGlob(target: string): boolean {
	if (!/[*?]/.test(target)) return false;
	const prefix = target
		.split("/")
		.filter((segment) => !/[*?]/.test(segment))
		.filter((segment) => segment !== "" && segment !== ".");
	return prefix.length === 0 || prefix.includes("..");
}

/**
 * 对这些目标的递归删除，按用户定的规矩判。
 *
 * 清掉 `src/data` 重新灌数据库、清掉 `dist` 重新构建，是被要求的工作里的一步；每一步都停下来问，无人值守就不是无人值守了。
 * 这个取舍是用户明确选的：工作区里的相对路径直接放行；工作区本身（`.`）、光秃秃的通配符、家目录或绝对路径、变量、
 * 用 `..` 往外走的，以及先 `cd` 去了别处的整串命令，照样问。
 */
function recursiveDelete(targets: readonly string[], contained: boolean, cwd?: string): RiskVerdict {
	const reckless = targets.some(
		(t) =>
			!t ||
			unexpanded(t) ||
			t.startsWith("~") ||
			t === "." ||
			t === ".." ||
			bareGlob(t) ||
			wipesScratchRoot(t, cwd) ||
			(isAbsolute(t) && !underScratchRoot(t, cwd)),
	);
	if (targets.length === 0 || reckless || targets.some(climbsOut) || !contained) return risky("recursive-delete");
	return SAFE;
}

/** `rm` 的选项和操作数；`--` 之后全是操作数。 */
function options(args: readonly string[]): { flags: string[]; targets: string[] } {
	const end = args.indexOf("--");
	const before = end === -1 ? args : args.slice(0, end);
	const flags = before.filter((word) => word.startsWith("-"));
	const targets = [...before.filter((word) => !word.startsWith("-")), ...(end === -1 ? [] : args.slice(end + 1))];
	return { flags, targets };
}

/** `rm`，按它删掉什么判：删一个文件是日常，删一棵树不是。 */
export function judgeRm(args: readonly string[], contained: boolean, cwd?: string): RiskVerdict {
	const { flags, targets } = options(args);
	// 长选项也算：`--recursive` 就是 `-r`。`-rf` 是一个词带两个旗标。
	if (flags.some((flag) => /^-[a-zA-Z]*[rR]/.test(flag) || flag === "--recursive")) {
		const verdict = recursiveDelete(targets, contained, cwd);
		if (verdict.risky) return verdict;
	}
	/*
	 * 通配删除按它指向哪里判，不按通配符判。
	 *
	 * 重建数据库、清构建目录是日常工作，`rm -f data/blog.db*` 就是它。收不回来的是同一条命令指向项目外面，所以问的是这个：
	 * 绝对路径、家目录开头或还没展开的目标，或者先走出了工作区的整串命令。
	 */
	if (flags.some((flag) => /^-[a-zA-Z]*f/.test(flag) || flag === "--force") && targets.some((t) => /[*?]/.test(t))) {
		const outside = targets.some((t) => unexpanded(t) || t.startsWith("~") || wipesScratchRoot(t, cwd) || (isAbsolute(t) && !underScratchRoot(t, cwd)));
		if (outside || !contained) return risky("force-delete-glob");
	}
	if (targets.some((t) => t === "/" || t === "~" || t === "~/")) return risky("delete-root-or-home");
	return SAFE;
}

/**
 * PowerShell 和 cmd 的递归删除，按和 `rm -r` 同一条规则判。
 *
 * `-Recurse` 可以缩写成任何不歧义的前缀，短到 `-r`，大小写随意，后面还能跟 `:$true`；cmd 写作 `/s`。目标的判法相同，
 * 只是绝对路径两个平台的写法都认，通配符两种分隔符都认。
 */
export function judgeWindowsDelete(args: readonly string[], contained: boolean): RiskVerdict {
	const recursive = args.some((word) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?(:|$)/i.test(word) || /^\/s$/i.test(word));
	if (!recursive) return SAFE;
	const targets = args.filter((word) => !word.startsWith("-") && !/^\/[a-z]$/i.test(word));
	const reckless = targets.some(
		(t) => !t || unexpanded(t) || t.startsWith("~") || t === "." || t === ".." || bareGlob(t.replaceAll("\\", "/")) || absoluteAnywhere(t),
	);
	if (targets.length === 0 || reckless || targets.some(climbsOut) || !contained) return risky("recursive-delete");
	return SAFE;
}

/** 收窄 `find` 匹配范围的测试：带了一个，它就不是起点下面的整棵树。 */
const FIND_FILTERS = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-type",
	"-newer",
	"-mtime",
	"-mmin",
	"-atime",
	"-amin",
	"-ctime",
	"-cmin",
	"-size",
	"-empty",
	"-user",
	"-group",
	"-perm",
]);

/**
 * `find` 会交给 `-delete` 或 `{}` 的东西：每个起点一个路径。
 *
 * 不带过滤时，`find p -delete` 就是 `rm -rf p`，`{}` 是 `p` 自己和它下面的一切。带了过滤，是 `p` **下面**的某些东西，
 * 写成 `p/{}`：删除规则照样看得出 `/{}` 是绝对路径、`~/{}` 是家目录、`../{}` 往外走，而 `./{}`（`find . -name '*.pyc' -delete`，
 * 最常见的清理）在工作区里。
 */
function findTargets(args: readonly string[]): { targets: string[]; expression: string[] } {
	let i = 0;
	// `-H`、`-L`、`-P`、`-O3`、`-D debugopts` 写在路径前面。
	while (i < args.length && (/^-[HLP]+$/.test(args[i]!) || /^-O\d*$/.test(args[i]!) || args[i] === "-D")) i += args[i] === "-D" ? 2 : 1;
	const starts: string[] = [];
	while (i < args.length && !/^[-(!),]/.test(args[i]!)) starts.push(args[i++]!);
	const expression = args.slice(i);
	const filtered = expression.some((word) => FIND_FILTERS.has(word));
	const targets = (starts.length > 0 ? starts : ["."]).map((start) => (filtered ? `${start.replace(/\/+$/, "")}/{}` : start));
	return { targets, expression };
}

/** `find … -delete`，按它实际是的递归删除判。 */
export function judgeFind(args: readonly string[], contained: boolean, cwd?: string): RiskVerdict {
	const { targets, expression } = findTargets(args);
	return expression.includes("-delete") ? recursiveDelete(targets, contained, cwd) : SAFE;
}

/** 一个词要写成什么样，shell 读回来才还是一个词。 */
const quote = (word: string) => (/^[\w@%+=:,./~{}-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * `find` 经 `-exec`、`-execdir`、`-ok`、`-okdir` 跑的命令，拼成一行；一条都不跑时为 null。
 *
 * `find / -exec rm -rf {} +` 就是把目标挪到了行首的 `rm -rf`，所以把 `{}` 换成它代表的东西，结果当成任何别的被包着的命令来判。
 */
export function findExec(args: readonly string[]): string | null {
	const { targets, expression } = findTargets(args);
	const commands: string[] = [];
	for (let i = 0; i < expression.length; i++) {
		if (!/^-(exec|execdir|ok|okdir)$/.test(expression[i]!)) continue;
		const words: string[] = [];
		for (i += 1; i < expression.length && expression[i] !== ";" && expression[i] !== "+"; i++) {
			const word = expression[i]!;
			if (word === "{}") words.push(...targets);
			else words.push(word.replaceAll("{}", targets[0]!));
		}
		if (words.length > 0) commands.push(words.map(quote).join(" "));
	}
	return commands.length > 0 ? commands.join("; ") : null;
}
