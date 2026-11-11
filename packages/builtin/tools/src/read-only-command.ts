/**
 * 判断一条 bash 命令是不是只读：只读的不用审批。
 *
 * 这是整个审批唯一的旁路：判成只读的命令根本不会问人，所以这里的 `true` 不是「大概没事」，而是
 * 「不管参数是什么，这个程序都改不了任何东西」。够不上这条线的程序不能上表，下面几类就是因此被拿掉的：
 *
 *   `env`      —— `env FOO=1 rm -rf ~` 跑的是 `rm`，第一个词却是 `env`
 *   `find`     —— `find . -delete` 会删，`-exec` 什么都能跑
 *   `node` 等解释器 —— 它们跑一个文件，文件什么都能做
 *   `npm run`  —— 跑 package.json 里写的任何东西；`git stash` 会把工作区挪走
 *
 * 这几种都不需要任何 shell 元字符，只看元字符是拦不住的。
 */

import { literalWords, nests, sequence, type LiteralWord } from "@plume/platform";

/** 不管参数是什么都只读的程序。 */
const READ_ONLY_COMMANDS = new Set([
	"ls",
	"pwd",
	"echo",
	"cat",
	"head",
	"tail",
	"wc",
	"which",
	"whoami",
	"date",
	"grep",
	"rg",
	"fd",
	"tree",
	"du",
	"df",
	"stat",
	"file",
	"basename",
	"dirname",
]);

const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
	// 没有 `stash`：它把工作区的改动拿走。`config` 只放行读的形式，见 `WRITES_ANYWAY` 和 `gitConfigReads`。
	git: new Set(["status", "log", "diff", "show", "branch", "remote", "config", "ls-files", "rev-parse", "blame"]),
	// 没有 `run`：`npm run build` 跑的是 package.json 里写的任何东西。
	npm: new Set(["ls", "view", "outdated"]),
	pnpm: new Set(["ls", "view", "outdated", "why"]),
	docker: new Set(["ps", "images", "logs"]),
};

/**
 * 只有问它自己的时候才只读的程序。
 *
 * `node --version` 什么都做不了，`node build.js` 什么都做得了。查工具链版本是 agent 天天做的事，
 * 而且确实无害，所以留下这一种形式。
 */
const VERSION_ONLY = new Set(["node", "python", "python3", "go", "cargo", "rustc", "tsc", "deno", "bun", "java", "ruby", "perl", "php"]);
const INFORMATIONAL = /^(--version|-v|-V|--help|-h|version)$/;

/**
 * 让上面的程序变成会写、会跑东西的参数。
 *
 * 用否决而不是往表里加条目：表说的是程序拿来干什么，这里说的是它什么时候被拿去干别的。
 */
const WRITES_ANYWAY: Record<string, RegExp> = {
	// 要紧的是 `-delete` 和 `-exec`；`-f*` 这一族也写文件。
	find: /^(-delete|-exec|-execdir|-ok|-okdir|-fls|-fprint|-fprintf|-fprint0)$/,
	// config 除了读回来都是写配置文件；`--output` 让 `diff`/`log`/`show` 写出一个文件。
	git: /^(--replace-all|--add|--unset|--unset-all|--rename-section|--remove-section|--edit|-e|--output(=.*)?)$/,
	// 能 shell 出去的格式不是在读。
	docker: /^(--format=.*exec.*)$/,
	// `-x`/`-X` 每个匹配跑一个程序。短旗标能连写（`-Hx`），带上它的组合都算。
	fd: /^(-[A-Za-z]*[xX].*|--exec(-batch)?(=.*)?)$/,
	// `--pre` 对每个搜索的文件跑一个程序。
	rg: /^--pre(=.*)?$/,
	// `-o` 把列表写进文件；`-ao` 这样的组合也是。
	tree: /^-[A-Za-z]*o.*$/,
	// `-C` 编译 magic 文件并写出来。
	file: /^(-[A-Za-z]*C.*|--compile)$/,
	// 设置系统时间。
	date: /^(-[A-Za-z]*s.*|--set(=.*)?)$/,
};

export function isReadOnlyCommand(command: string): boolean {
	/*
	 * 一串命令每一条都只读，整串才只读，所以先拆开逐条判。
	 *
	 * 一见元字符就拒绝虽然拦得住 `ls; rm -rf ~`，也把模型四处看看时写的几乎所有命令都拦了：
	 * `cd x && grep -rn … | head`、`git status | head` 都会被当成写，挨个问、挨个跑。
	 *
	 * 仍然直接拒绝的：替换和 heredoc（跑的东西不是这串里的一条）；放进后台的命令；任何换行——
	 * `ls⏎rm -rf ~` 是最直接的绕法，只读的一行命令也用不着换行。
	 */
	if (/[\n\r]/.test(command) || nests(command)) return false;
	const links = sequence(command);
	if (links.length === 0) return false;
	return links.every((link, index) => {
		if (link.after === "&") return false;
		const words = literalWords(withoutDiscardedOutput(link.text));
		if (!words?.length) return false;
		if (words[0]!.text === "cd") return index === 0 && link.after === "&&" && links.length > 1 && entersKnownPlace(words);
		return readsOnly(words);
	});
}

/** `2>/dev/null` 和 `2>&1` 写的东西没人留着；别的重定向仍然算写。 */
function withoutDiscardedOutput(command: string): string {
	return command.replace(/(^|\s)(?:\d?>|&>)\s*\/dev\/null(?=\s|$)/g, "$1").replace(/(^|\s)\d?>&\d(?=\s|$)/g, "$1");
}

/**
 * 打头的 `cd` 不改磁盘上的任何东西，它改的是后面的命令读哪里。
 *
 * 所以只认从命令上就看得出去哪的 `cd`：不带参数和 `cd ~user` 回家目录，`cd -` 回上一个目录，glob 可能落到
 * 指向别处的链接上，这些都看不出来。也只许第一条是 `cd`：后面命令里的路径都按会话目录加上这一个 `cd` 来理解，
 * 连着几个 `cd` 就不再一目了然。
 */
function entersKnownPlace(words: LiteralWord[]): boolean {
	if (words.length !== 2) return false;
	const target = words[1]!;
	if (target.glob !== -1 || !target.text || target.text.startsWith("-")) return false;
	return !target.text.startsWith("~") || target.text === "~" || target.text.startsWith("~/");
}

function readsOnly(words: LiteralWord[]): boolean {
	const [head, ...args] = words.map((word) => word.text) as [string, ...string[]];

	/*
	 * 以 glob 开头的词可能展开成任何文件名，包括 `--output=x`。只在有旗标会写、会跑东西的程序上要紧；
	 * `feat*` 只能变成 `feat…`。
	 */
	const veto = WRITES_ANYWAY[head];
	if (veto && args.some((arg) => veto.test(arg))) return false;
	if (veto && words.slice(1).some((word) => word.glob === 0 || (word.glob > 0 && word.text.startsWith("-")))) return false;

	if (READ_ONLY_COMMANDS.has(head)) return true;

	if (head === "sed") return printsLines(words.slice(1));

	// `env` 打印环境变量是只读的，直到给它一个要跑的命令。只有赋值、别的什么都没有时，就没有东西可跑。
	if (head === "env") return args.every((arg) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));

	if (VERSION_ONLY.has(head)) return args.length > 0 && args.every((arg) => INFORMATIONAL.test(arg));

	const sub = READ_ONLY_SUBCOMMANDS[head];
	if (head === "git" && args[0] === "config") return gitConfigReads(args.slice(1));
	if (head === "git" && args[0] === "branch") return gitBranchReads(args.slice(1));
	if (head === "git" && args[0] === "remote") return gitRemoteReads(args.slice(1));
	return sub ? sub.has(args[0] ?? "") : false;
}

/**
 * `sed -n '1,80p' a.ts` 是模型读一段文件的习惯写法，绝大多数 `sed` 都是这个形状。
 *
 * 只认这一种。sed 脚本能写文件（`w`、`-i`）、能跑命令（`e`），所以脚本只能是纯行号范围加 `p`，
 * 其余写法照旧算写。文件参数不能以 `-` 开头，也不能以 glob 开头——目录里一个叫 `-i` 的文件，
 * 就能把 `sed -n 1,5p *` 展开成原地改写。
 */
function printsLines(args: LiteralWord[]): boolean {
	const [quiet, script, ...files] = args;
	if (quiet?.text !== "-n" || !script || !/^\d+(,\d+)?p$/.test(script.text)) return false;
	return files.every((file) => file.glob !== 0 && !file.text.startsWith("-"));
}

/**
 * `git branch` 只有列出的形式算只读：`-D` 删分支、`-m` 改名、`-u` 改上游，带一个名字就是新建。
 * 位置参数只在跟着取值旗标（`--contains <commit>`）或 `--list <pattern>` 时才是在问，不是在建。
 */
function gitBranchReads(args: string[]): boolean {
	if (
		args.some((arg) =>
			/^(-[A-Za-z]*[dDmMcCfu].*|--delete|--move|--copy|--force|--set-upstream-to(=.*)?|--unset-upstream|--edit-description|--track(=.*)?|--no-track|--create-reflog|--recurse-submodules)$/.test(
				arg,
			),
		)
	)
		return false;
	if (args.some((arg) => /^(-l|--list)$/.test(arg))) return true;
	const takesValue = /^(--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column)$/;
	return args.every((arg, index) => arg.startsWith("-") || (index > 0 && takesValue.test(args[index - 1]!)));
}

/** `git remote` 只有列出、`show`、`get-url` 是在问；`add`、`set-url`、`remove`、`prune`、`update` 都改仓库。 */
function gitRemoteReads(args: string[]): boolean {
	const positional = args.filter((arg) => !arg.startsWith("-"));
	return positional.length === 0 || positional[0] === "show" || positional[0] === "get-url";
}

/**
 * `git config` 只有读的形式算只读：`git config k v` 是赋值，没有任何旗标，`WRITES_ANYWAY` 看不见它。
 * 这不是无害的赋值——`core.fsmonitor`、`filter.*`、`core.hooksPath` 写进去，之后跑的每一个 git
 * 都会替它执行程序。带值的旗标（`--file x`）会被数成第二个位置参数，按写处理，宁可多问一次。
 */
function gitConfigReads(args: string[]): boolean {
	if (args.some((arg) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l)$/.test(arg))) return true;
	const positional = args.filter((arg) => !arg.startsWith("-"));
	if (positional[0] === "get" || positional[0] === "list") return true;
	return positional.length === 1 && !/^(set|unset|edit|rename-section|remove-section)$/.test(positional[0]!);
}
