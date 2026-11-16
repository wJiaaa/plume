/**
 * 一行命令写明要写哪些路径，给完全访问下「改 Plume 自己的目录要人亲自点头」用（`commandWritesAppData`）。
 *
 * 完全访问下命令不进沙箱，本体在命令跑之前只看得到这一行字，看不到它跑起来做什么。这里只认模型改配置时实际会写出来的样子：
 * 重定向、`tee`、`cp`/`mv` 这类放文件的程序、`sed -i`、`rm`、`touch`……，`~`、`$HOME` 展开后判。认不出的不判：
 * 脚本里写的（`python fix.py`）、先 `cd` 进去再写相对路径的、拼出来的路径（`$X/settings.json`）。这是给人一个确认的机会，
 * 不是边界：完全访问本来就允许跑任意程序。只认写，读（`cat ~/.plume/settings.json`）不判。
 */

import { homedir } from "node:os";
import { commandDialects, splitCommands, splitWords, type Dialect } from "@plume/platform";
import { toAbsolute, writesAppData, type WriteScope } from "./paths.ts";

/** 每个参数都是被写（改、删、建）的东西。 */
const WRITES_EVERY_ARGUMENT = new Set([
	"rm",
	"rmdir",
	"unlink",
	"touch",
	"mkdir",
	"chmod",
	"chown",
	"chflags",
	"xattr",
	"truncate",
	"tee",
	// mv 的来源也被挪走了。
	"mv",
	// PowerShell 和 cmd 的，按小写登记。
	"set-content",
	"add-content",
	"out-file",
	"new-item",
	"remove-item",
	"rename-item",
	"move-item",
	"clear-content",
	"del",
	"erase",
	"move",
	"ren",
]);

/** 最后一个参数是写到哪里，前面的是读的来源：从 `~/.plume` 往外拷不算改它。 */
const WRITES_LAST_ARGUMENT = new Set(["cp", "install", "rsync", "ln", "copy-item", "copy", "xcopy", "robocopy"]);

/** 加了 `-i` 就原地改它读的文件。 */
const EDITS_IN_PLACE = new Set(["sed", "gsed", "perl"]);

/** 写在命令前面、真正的程序在后面的。 */
const PREFIXES = new Set(["sudo", "env", "nohup", "time", "nice", "command", "exec", "doas"]);

/** `>`、`>>`、`2>`、`&>`，可能和目标连着写。 */
const REDIRECT = /^\d*(?:>>?|&>>?)(?!&)/;

/** 一行命令写明会写的路径（绝对路径；带通配符的取通配符前面那一截）。 */
export function commandWriteTargets(command: string, cwd: string, dialects: readonly Dialect[] = commandDialects()): string[] {
	const found = new Set<string>();
	const add = (word: string | undefined) => {
		const path = literalPath(word);
		if (path) found.add(toAbsolute(cwd, path));
	};
	for (const dialect of dialects)
		for (const piece of splitCommands(command, dialect)) {
			const words = splitWords(piece, dialect);
			let start = 0;
			while (start < words.length && (PREFIXES.has(words[start]!.toLowerCase()) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!))) start++;
			const program = (words[start] ?? "")
				.split(/[/\\]/)
				.pop()!
				.toLowerCase()
				.replace(/\.exe$/, "");
			const args: string[] = [];
			for (let i = start + 1; i < words.length; i++) {
				const word = words[i]!;
				const redirect = REDIRECT.exec(word);
				if (redirect) {
					// 连着写的 `>file`，或者分开写的 `> file`。
					add(word.length > redirect[0].length ? word.slice(redirect[0].length) : words[++i]);
					continue;
				}
				if (word.startsWith("<")) continue;
				args.push(word);
			}
			const operands = args.filter((word) => !word.startsWith("-"));
			if (WRITES_EVERY_ARGUMENT.has(program)) operands.forEach(add);
			else if (WRITES_LAST_ARGUMENT.has(program)) add(operands.at(-1));
			// `-i`、`-i.bak`、`-pi`：脚本也在操作数里，它展开不成 `~/.plume` 下的路径，一起判不碍事。
			else if (EDITS_IN_PLACE.has(program) && args.some((word) => /^-[a-z]*i/.test(word))) operands.forEach(add);
			else if (program === "dd") for (const word of args) if (word.startsWith("of=")) add(word.slice(3));
		}
	return [...found];
}

/**
 * 一个词作为路径的那一截：`$HOME`、`${HOME}` 换成家目录（`~` 由 `toAbsolute` 展开）；带通配符的取前面那一截；
 * 别的要 shell 才知道是什么的（`$X/a`、替换）、脚本一样长的不判。
 */
function literalPath(word: string | undefined): string | null {
	if (!word) return null;
	let path = word.replace(/^\$\{?HOME\}?(?=$|[/\\])/, homedir());
	const glob = path.search(/[*?[]/);
	if (glob >= 0) path = path.slice(0, glob);
	if (!path || /[$`]/.test(path) || path.includes("\n") || path.length > 400) return null;
	return path;
}

/** 这行命令写明要改的、在 Plume 自己的目录里的路径（见 `writesAppData`）；没有就是空的。 */
export async function commandWritesAppData(scope: WriteScope, command: string, dialects?: readonly Dialect[]): Promise<string[]> {
	const targets = commandWriteTargets(command, scope.cwd, dialects);
	const inside = await Promise.all(targets.map((target) => writesAppData(scope, target).catch(() => false)));
	return targets.filter((_, index) => inside[index]);
}
