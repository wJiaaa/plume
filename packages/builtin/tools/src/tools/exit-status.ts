/**
 * 非零的退出码是什么意思——不总是「失败了」。
 *
 * `grep` 没匹配上退出 1，`diff` 文件不同退出 1，`[ -f x ]` 没有 x 退出 1，`gh pr checks` 检查还在跑时退出 8。
 * 这些都是命令照要求做了，借进程唯一的渠道报告答案。全都当失败的话，一个在轮询 CI 的会话里会出现一列红叉，
 * 而什么都没出错。
 *
 * 所以照人的读法读：看是哪条命令给出的。一行 shell 的退出码是最后一条命令的，但 `a && b` 可能停在 `a`：候选是
 * 最后一条管道，以及用 `&&` 连到它上面的每一条。只有每个候选要么声明这个退出码是答案、要么不可能给出它（`echo`、
 * 没报错的 `cd`）时，才算答案；有一个候选可能真失败了，就算失败。
 *
 * 读不懂的——循环、`if`、子 shell、函数、`set -e`——照旧算失败。下面的表只会在读得懂的情况下拿掉红叉，
 * 不会凭空加一个，也不会藏起拿不准的那个。
 */

import { sequence, splitWords, type SequenceEntry } from "../shell-split.ts";

export interface ExitReading {
	/** 要不要报成失败。 */
	failed: boolean;
	/** 知道时，几个词说这个退出码的意思。英文：给模型读的。 */
	meaning?: string;
}

/** `code` 对这条命令是答案而不是失败时，返回它的意思。 */
type Rule = (args: string[], code: number, output: string) => string | undefined;

const noMatch: Rule = (_, code) => (code === 1 ? "no matches" : undefined);
const differ: Rule = (_, code) => (code === 1 ? "the inputs differ" : undefined);
const falsy: Rule = (_, code) => (code === 1 ? "the condition is false" : undefined);
const notFound: Rule = (_, code) => (code === 1 ? "not found" : undefined);
const noProcess: Rule = (_, code) => (code === 1 ? "no process matched" : undefined);
const has = (args: string[], ...flags: string[]) =>
	args.some((arg) => flags.includes(arg) || flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)));

/** `gh pr checks` 输出的一行（制表符分隔），或它的 `--json` 形式。 */
const CHECK_ROWS = /^[^\t\n]+\t(pass|fail|pending|skipping|cancel|neutral)\t/m;

const RULES: Record<string, Rule> = {
	grep: noMatch,
	egrep: noMatch,
	fgrep: noMatch,
	zgrep: noMatch,
	rg: noMatch,
	ag: noMatch,
	ack: noMatch,
	diff: differ,
	cmp: differ,
	colordiff: differ,
	test: falsy,
	"[": falsy,
	"[[": falsy,
	which: notFound,
	type: notFound,
	pgrep: noProcess,
	pidof: noProcess,
	pkill: noProcess,
	killall: noProcess,
	/*
	 * `find` 有路径读不了时退出 1，其余照样搜完了；`find / -name x 2>/dev/null` 正是因此而写，结尾照样是 1。
	 * 除了它自己的抱怨还打印了别的就是答案，只打印了抱怨就是失败。
	 */
	find: (_, code, output) =>
		code === 1 && output.split("\n").some((line) => line.trim() && !line.startsWith("find: "))
			? "some paths could not be read; the rest were searched"
			: undefined,
	// `lsof -i :3000` 问的是「那个端口上有没有东西」，「没有」是没有输出的退出 1。
	lsof: (_, code, output) => (code === 1 && !output.trim() ? "nothing matched" : undefined),
	// `kill -0 <pid>` 问进程在不在。
	kill: (args, code) => (code === 1 && args.includes("-0") ? "the process is not running" : undefined),
	// `nc -z host port` 问那里有没有在监听。
	nc: (args, code) => (code === 1 && args.some((arg) => /^-[a-zA-Z]*z/.test(arg)) ? "nothing is listening" : undefined),
	// `jq -e` 把 false 或 null 的结果变成退出 1。
	jq: (args, code) => (code === 1 && has(args, "-e", "--exit-status") ? "the result is false or null" : undefined),
	expr: (_, code) => (code === 1 ? "the result is zero or empty" : undefined),
	npm: (args, code) => (code === 1 && args[0] === "outdated" ? "some packages are outdated" : undefined),
	pnpm: (args, code) => (code === 1 && args[0] === "outdated" ? "some packages are outdated" : undefined),
	yarn: (args, code) => (code === 1 && args[0] === "outdated" ? "some packages are outdated" : undefined),
	systemctl: (args, code) => (code !== 0 && ["is-active", "is-enabled", "is-failed"].includes(args[0] ?? "") ? `the answer to ${args[0]} is no` : undefined),
	git: (args, code, output) => {
		const sub = gitSubcommand(args);
		if (!sub) return undefined;
		const rest = args.slice(args.indexOf(sub) + 1);
		if (sub === "grep") return noMatch(rest, code, output);
		if ((sub === "diff" || sub === "diff-index" || sub === "diff-files") && code === 1 && has(rest, "--quiet", "--exit-code", "--no-index")) {
			return "there are differences";
		}
		if (sub === "merge-base" && code === 1 && rest.includes("--is-ancestor")) return "not an ancestor";
		if (sub === "check-ignore" && code === 1) return "not ignored";
		if (sub === "ls-remote" && code === 2 && rest.includes("--exit-code")) return "no matching refs";
		if ((sub === "show-ref" || sub === "rev-parse") && code === 1 && has(rest, "--quiet", "-q", "--verify", "--exists")) return "the ref does not exist";
		if (sub === "show-ref" && code === 2 && rest.includes("--exists")) return "the ref does not exist";
		if (sub === "config" && code === 1 && !output.trim()) return "the key is not set";
		return undefined;
	},
	gh: (args, code, output) => {
		if (args[0] !== "pr" || args[1] !== "checks") return undefined;
		// 报告就是那张表；没有表时，退出码说的是别的事。
		if (!CHECK_ROWS.test(output) && !/"(bucket|state)"\s*:/.test(output)) return undefined;
		if (code === 8) return "some checks are still pending";
		if (code === 1) return "some checks failed";
		return undefined;
	},
};

/** 不可能是非零退出码来源的命令。 */
const SILENT = new Set(["echo", "printf", "true", ":", "sleep"]);

/** 出现就说明这一行是这里读不懂的结构。 */
const CONSTRUCTS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"function",
	"{",
	"}",
	"!",
	"coproc",
	"exit",
	"return",
]);

/** `git -C dir --no-pager diff`：全局选项之后的子命令。 */
function gitSubcommand(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return arg;
	}
	return undefined;
}

/**
 * 一条命令跑的程序和它的参数，跳过赋值和把退出码原样传出的包装：`FOO=1 env -i timeout 30 grep x` 就是 `grep x`。
 */
function program(text: string): { name: string; args: string[] } | undefined {
	const words = splitWords(text);
	let i = 0;
	const skipAssignments = () => {
		while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
	};
	const skipOptions = (valued: string[] = []) => {
		while (i < words.length && words[i]!.startsWith("-")) {
			if (valued.includes(words[i]!)) i++;
			i++;
		}
	};
	skipAssignments();
	for (;;) {
		const word = words[i];
		if (word === undefined) return undefined;
		if (word === "env") {
			i++;
			skipOptions(["-u", "-S", "-C"]);
			skipAssignments();
		} else if (word === "command" || word === "builtin" || word === "exec") {
			// `command -v x` 是一个问题，`which` 的回答方式一样。
			if (words[i + 1] === "-v" || words[i + 1] === "-V") return { name: "which", args: words.slice(i + 2) };
			i++;
		} else if (word === "nice" || word === "nohup" || word === "time" || word === "stdbuf") {
			i++;
			skipOptions(["-n"]);
		} else if (word === "sudo") {
			i++;
			skipOptions(["-u", "-g", "-C", "-D", "-h", "-p", "-U"]);
		} else if (word === "timeout") {
			i++;
			skipOptions(["-s", "-k", "--signal", "--kill-after"]);
			i++;
		} else break;
	}
	const name = words[i]!.split("/").pop() ?? words[i]!;
	return { name, args: words.slice(i + 1) };
}

/** 各条管道（每条是一串命令），连同跟在它后面的操作符。 */
function andOrTail(entries: SequenceEntry[]): { stages: string[]; before?: SequenceEntry["after"] }[] | undefined {
	const pipelines: { stages: string[]; after: SequenceEntry["after"] }[] = [];
	let stages: string[] = [];
	for (const entry of entries) {
		stages.push(entry.text);
		if (entry.after === "|") continue;
		pipelines.push({ stages, after: entry.after });
		stages = [];
	}
	if (stages.length) pipelines.push({ stages, after: "end" });
	const last = pipelines[pipelines.length - 1];
	// 最后一条命令放到后台的一行退出 0。
	if (!last || last.after === "&") return undefined;
	/*
	 * 最后一条管道，以及用 `&&` 连到它上面的每一条：`a && b` 里失败的 `a` 就是退出码，`b` 根本没跑。
	 * 遇到 `||` 就停：`a || b` 里失败的 `a` 会接着跑 `b`。
	 */
	const tail = [last];
	for (let k = pipelines.length - 2; k >= 0 && pipelines[k]!.after === "&&"; k--) tail.push(pipelines[k]!);
	return tail.map((pipeline) => ({ stages: pipeline.stages }));
}

/**
 * 读一条跑完的命令的退出码。
 *
 * `shell` 是它跑在哪种 shell 里：只按 POSIX shell 读，PowerShell 的一行语法不同，退出码也有它自己的一套。
 */
export function readExit(command: string, code: number | null, output: string, shell: "posix" | "powershell" = "posix"): ExitReading {
	if (code === 0) return { failed: false };
	if (code === null || shell !== "posix") return { failed: true };
	// `set -e` 让这一行停在第一个失败处，不管它在哪；`pipefail` 让整条管道都算数。
	if (/\bset\s+(-[a-zA-Z]*e[a-zA-Z]*\b|-o\s+errexit\b)/.test(command)) return { failed: true };
	const pipefail = /\bpipefail\b/.test(command);

	const tail = andOrTail(sequence(command));
	if (!tail) return { failed: true };

	let meaning: string | undefined;
	for (const pipeline of tail) {
		const deciding = pipefail ? pipeline.stages : [pipeline.stages[pipeline.stages.length - 1]!];
		for (const text of deciding) {
			if (/^[({]/.test(text)) return { failed: true };
			const run = program(text);
			if (!run || CONSTRUCTS.has(run.name) || /^\w+\(\)/.test(text)) return { failed: true };
			if (SILENT.has(run.name)) continue;
			// 失败的 `cd` 会说出来；什么都没打印的没失败。
			if (run.name === "cd" || run.name === "pushd") {
				if (new RegExp(`\\b${run.name}: `).test(output)) return { failed: true };
				continue;
			}
			const answer = RULES[run.name]?.(run.args, code, output);
			if (answer === undefined) return { failed: true };
			meaning ??= answer;
		}
	}
	return meaning === undefined ? { failed: true } : { failed: false, meaning };
}

/**
 * 按 shell 自己的约定说一个退出码，给模型读的那一行。
 *
 * 126、127 是 shell 在任何东西跑起来之前就拒绝了，128+N 是被信号 N 杀死——「测试失败了」和「测试被杀了，多半是内存」
 * 的区别不该让模型自己去记。
 */
export function describeStatus(code: number | null, signal?: string | null): string {
	if (code === null) return signal ? `terminated by ${signal}` : "terminated without an exit code";
	if (code === 126) return "exit code 126: not executable";
	if (code === 127) return "exit code 127: command not found";
	if (code > 128 && code < 160) {
		const name = SIGNALS[code - 128];
		return name ? `exit code ${code}: killed by ${name}` : `exit code ${code}`;
	}
	return `exit code ${code}`;
}

const SIGNALS: Record<number, string> = {
	1: "SIGHUP",
	2: "SIGINT",
	3: "SIGQUIT",
	6: "SIGABRT",
	9: "SIGKILL (often: out of memory)",
	11: "SIGSEGV",
	13: "SIGPIPE",
	15: "SIGTERM",
};
