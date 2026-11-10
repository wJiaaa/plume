/**
 * git，按参数判。
 *
 * git 做的事几乎没有哪件光看名字就危险：`git reset` 是取消暂存一个文件，`git reset --hard` 是扔掉一天的工作；
 * `git push` 是分享，`git push origin :main` 是删除。所以这里读子命令的旗标，不查子命令的名字；没有危险旗标的子命令
 * 就是日常工作，问 `git reset HEAD file`、`git clean -n` 这种，正是人学会不看就点的那种提示。
 */

import type { RiskCode } from "./messages.ts";
import { SAFE, risky, type RiskVerdict } from "./risk-shared.ts";
import { RISKY_SUBCOMMANDS } from "./risk-tables.ts";

/**
 * 跳过全局选项以后 git 的子命令。
 *
 * 直接拿 `words[1]` 的话，一有全局选项拿到的就是选项而不是子命令：`git -c protocol.ext.allow=always push --force`
 * 是一次强制推送，「子命令」却读成了 `-c`，下面每条 git 规则都不管了。
 */
function gitSubcommand(argv: readonly string[]): { sub: string; args: string[] } {
	const TAKES_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
	let i = 1;
	while (i < argv.length) {
		const word = argv[i]!;
		if (TAKES_VALUE.has(word)) {
			i += 2;
			continue;
		}
		if (word.startsWith("-")) {
			i += 1;
			continue;
		}
		return { sub: word, args: argv.slice(i + 1) };
	}
	return { sub: "", args: [] };
}

/** 代表整棵树的路径：`git checkout .` 会扔掉所有没暂存的改动。 */
const WHOLE_TREE = new Set([".", "./", ":/"]);

/**
 * 危险在参数上而不在名字上的 git 子命令。
 *
 * 要紧的界线是 `git checkout <branch>`：谁都这样切分支，而且它自己就不肯覆盖本地改动，所以只有 `-f`、整棵树的路径、
 * `--` 后面的路径才算。
 */
function gitArgumentRisk(sub: string, args: string[]): RiskCode | undefined {
	const has = (...flags: string[]) => args.some((arg) => flags.includes(arg));
	// git 的短旗标可以连写：`-fd` 是 `-f -d`，`-df` 也一样。
	const short = (letter: string) => args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter));
	const operands = args.filter((arg) => !arg.startsWith("-"));
	if (sub === "checkout") {
		const afterDashes = args.indexOf("--");
		const paths = afterDashes >= 0 && afterDashes < args.length - 1;
		if (has("-f", "--force") || paths || operands.some((arg) => WHOLE_TREE.has(arg))) return "overwrite-changes";
	}
	// 只恢复暂存区会留着改动；碰到工作区的都会丢掉它们。
	if (sub === "restore" && (!has("-S", "--staged") || has("-W", "--worktree"))) return "discard-changes";
	// `git switch` 不让它覆盖就不覆盖本地改动，和 `git checkout <branch>` 一样。
	if (sub === "switch" && (short("f") || has("--force", "--discard-changes"))) return "discard-changes";
	if (sub === "push") {
		// `--force-with-lease` 是小心的写法，但照样替换掉远程分支。
		if (short("f") || args.some((arg) => arg.startsWith("--force"))) return "force-push";
		/*
		 * `+main` 是只对这一个 ref 的 `--force`；`--mirror` 让远程和本地一模一样，删掉的也删；`--delete` 和 `:main`
		 * 直接删掉远程分支。单独一个 `:` 是 git 的「推送同名分支」，什么都不删。
		 */
		const refspecs = operands.slice(1);
		if (has("--mirror")) return "force-push";
		if (has("--delete") || short("d") || refspecs.some((ref) => ref.startsWith(":") && ref.length > 1)) return "delete-branch";
		if (refspecs.some((ref) => ref.startsWith("+"))) return "force-push";
	}
	// `-d` 不肯删没合并的分支；`-D`（或 `-d --force`）连它的提交一起扔掉。
	if (sub === "branch" && (short("D") || ((short("d") || has("--delete")) && (short("f") || has("--force"))))) {
		return "delete-branch";
	}
	if (sub === "reset") {
		if (has("--hard")) return "hard-reset";
		// 另外两种碰工作区的；`--soft`、`--mixed`、`reset <path>` 每处改动都留着。
		if (has("--merge", "--keep")) return "discard-changes";
	}
	// 不带 `-f` 的 `git clean` 什么都不删（git 自己的默认），带 `-n` 更是什么都不删。
	if (sub === "clean" && (short("f") || has("--force")) && !(short("n") || has("--dry-run"))) return "delete-untracked";
	if (sub === "stash" && (operands[0] === "clear" || operands[0] === "drop")) return "discard-changes";
	if (sub === "worktree" && operands[0] === "remove" && has("-f", "--force")) return "discard-changes";
	return undefined;
}

/** 一条 git 命令的判断。`argv` 是它的词，引号已解、前面的赋值已去。 */
export function judgeGit(argv: readonly string[]): RiskVerdict {
	const { sub, args } = gitSubcommand(argv);
	const argumentRisk = gitArgumentRisk(sub, args);
	if (argumentRisk) return risky(argumentRisk);
	// 改写历史就是 `rebase`、`filter-branch` 的用途，不管带什么旗标。
	const code = RISKY_SUBCOMMANDS.get("git")?.get(sub);
	return code ? risky(code) : SAFE;
}
