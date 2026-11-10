/**
 * macOS 的 `open`，按它会启动什么判。
 *
 * `open` 把操作数交给 LaunchServices，LaunchServices 在用户的会话里启动程序：不是这个 shell 的子进程，所以在这条命令所在的沙箱外面。
 * `open -g P.app`（P 会跑 `touch ~/x`）就从一个明令禁止写家目录的沙箱里写了家目录。打开一个文档性质不同：启动的是用户给这类文件
 * 选好的查看器，看的是用户看得见的文件。所以程序要问，文档不问：问 `open index.html`、`open .` 只会教人不看就点。
 */

import { SAFE, risky, type RiskVerdict } from "./risk-shared.ts";

/** 只在启动程序时才有意义、或者指名了一个程序的选项。 */
const LAUNCH_OPTIONS = new Set(["-a", "-b", "--args", "-n", "--new", "--env", "--stdin", "--stdout", "--stderr"]);
/** 把下一个词当自己的值的选项，那个词就不是操作数。 */
const TAKES_VALUE = new Set(["-a", "-b", "-s", "-u", "--env", "--stdin", "--stdout", "--stderr"]);

/**
 * 本身是程序的包，以及 Finder 会运行而不是展示的文件：`.command`、`.tool`、`.sh` 在终端里打开并执行，
 * `.terminal` 带着一条要跑的命令，安装器那几种会安装。
 */
const RUNS = /\.(app|command|tool|sh|terminal|workflow|action|pkg|mpkg|prefpane|saver)\/?$/i;
/** 打开网页或草稿的 URL 协议。别的协议启动的是注册了它的那个程序，URL 就是给它的输入。 */
const VIEWS = /^(https?|mailto):/i;

export function judgeOpen(args: readonly string[]): RiskVerdict {
	for (let i = 0; i < args.length; i += 1) {
		const word = args[i]!;
		if (word === "--") continue;
		if (word.startsWith("--")) {
			const name = word.replace(/=.*$/, "");
			if (LAUNCH_OPTIONS.has(name)) return risky("launch-program");
			if (TAKES_VALUE.has(name) && !word.includes("=")) i += 1;
			continue;
		}
		if (/^-[A-Za-z]+$/.test(word)) {
			// 连写的短选项：`-na Terminal` 就是 `-n -a Terminal`。
			if (/[abn]/.test(word.slice(1))) return risky("launch-program");
			if (TAKES_VALUE.has(`-${word.slice(-1)}`)) {
				// `-u <url>`：那个值照样是要打开的东西。
				if (word.endsWith("u") && i + 1 < args.length && !opensDocument(args[i + 1]!)) return risky("launch-program");
				i += 1;
			}
			continue;
		}
		if (!opensDocument(word)) return risky("launch-program");
	}
	return SAFE;
}

/**
 * 打开这个操作数是展示一样东西，还是运行一样东西。
 *
 * 没有扩展名的名字不能认定是文档：没有扩展名的可执行文件会在终端里打开并运行。`.`、`..`、`~` 和以 `/` 结尾的是目录，在 Finder 里打开。
 */
function opensDocument(operand: string): boolean {
	if (VIEWS.test(operand)) return true;
	const path = operand.replace(/^file:\/\//i, "");
	if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return false;
	if (RUNS.test(path)) return false;
	if (path === "." || path === ".." || path === "~" || /[\\/]$/.test(path)) return true;
	const name = path.replace(/^.*[\\/]/, "");
	return /.\.[A-Za-z0-9]+$/.test(name);
}
