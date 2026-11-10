/**
 * 一条 shell 命令从外面看是不是在「看」：转录里把它和 read、grep 归成同一段探索（见 `toolCategory`）。
 *
 * 这是给人看的归类，不是安全判断。审批用的是 agent 进程里的只读命令判定，那边表更窄、`$`、重定向一律算写——
 * 宁可多问一次；这里 `sed -n 1,80p a.ts` 就是在看。归错了只是转录里多一行或少一行，不放过任何东西。
 *
 * 判定从严：`|`、`&&`、`;` 串起来的每一段都得是认得的读命令。「沾上一个读命令就算」的话，
 * `pnpm test | tail` 也成了在看代码。
 */

/** 只读、不跑别的程序的命令。写成小写：PowerShell 的命令不分大小写。 */
const READERS = new Set([
	"cat",
	"head",
	"tail",
	"ls",
	"tree",
	"find",
	"fd",
	"rg",
	"grep",
	"egrep",
	"fgrep",
	"ag",
	"wc",
	"stat",
	"file",
	"du",
	"df",
	"pwd",
	"which",
	"whereis",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"echo",
	"printf",
	"sort",
	"uniq",
	"cut",
	"tr",
	"nl",
	"column",
	"jq",
	"diff",
	"cmp",
	"sed",
	"awk",
	"get-content",
	"gc",
	"get-childitem",
	"gci",
	"dir",
	"select-string",
	"sls",
	"get-location",
	"test-path",
	"resolve-path",
]);

/** 换目录不算做事，也不算在看：`cd src && rg x` 看的是后半句。 */
const NAVIGATION = new Set(["cd", "pushd", "popd"]);

const GIT_READS = new Set(["status", "log", "show", "diff", "blame", "ls-files", "ls-tree", "rev-parse", "grep", "shortlog", "describe", "cat-file"]);

/** 认得的读命令换了参数就是在写：`sed -i`、`find -delete`、`sort -o out`。 */
const WRITES_ANYWAY: Record<string, RegExp> = {
	sed: /^(-[A-Za-z]*i.*|--in-place(=.*)?)$/,
	find: /^(-delete|-exec|-execdir|-ok|-okdir|-fprint.*|-fls)$/,
	fd: /^(-[A-Za-z]*[xX].*|--exec(-batch)?(=.*)?)$/,
	rg: /^--pre(=.*)?$/,
	sort: /^(-o.*|--output(=.*)?)$/,
};

export function isShellRead(command: string): boolean {
	const segments = split(command);
	if (!segments) return false;
	let reads = false;
	for (const segment of segments) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
		if (words.length === 0) continue;
		const head = (words[0]!.split(/[\\/]/).pop() ?? "").toLowerCase();
		if (NAVIGATION.has(head)) continue;
		if (!reader(head, words.slice(1))) return false;
		reads = true;
	}
	return reads;
}

function reader(head: string, args: string[]): boolean {
	if (head === "git") {
		// `git -C dir log`：跳过全局选项，取第一个子命令。
		let at = 0;
		while (at < args.length && args[at]!.startsWith("-")) at += args[at] === "-C" || args[at] === "-c" ? 2 : 1;
		return GIT_READS.has(args[at] ?? "");
	}
	if (!READERS.has(head)) return false;
	const veto = WRITES_ANYWAY[head];
	return !veto || !args.some((arg) => veto.test(arg));
}

/**
 * 按引号外的 `|` `||` `&&` `&` `;` 和换行切段；引号外有写文件的重定向就返回 null。
 *
 * 要认引号：`rg "a|b" src` 里那根竖线是正则，按它切开，后半段 `b" src` 谁也不认得，整条就成了执行。
 * 指向 `/dev/null` 的重定向和 `2>&1` 不写任何东西。
 */
function split(command: string): string[] | null {
	const segments: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let at = 0; at < command.length; at++) {
		const char = command[at]!;
		if (quote) {
			current += char;
			if (char === "\\" && quote === '"') current += command[++at] ?? "";
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === "\\") {
			current += char + (command[++at] ?? "");
			continue;
		}
		if (char === ">") {
			const target = command[at + 1] === ">" ? at + 2 : at + 1;
			// `2>&1` 整个吃掉：留下那个 `&` 会被下面当成后台符号切开。
			if (/^&\d/.test(command.slice(target))) {
				current += command.slice(at, target + 2);
				at = target + 1;
				continue;
			}
			if (!/^\s*\/dev\/null\b/.test(command.slice(target))) return null;
			current += command.slice(at, target);
			at = target - 1;
			continue;
		}
		if (char === "|" || char === "&" || char === ";" || char === "\n") {
			// `&>` 是重定向，不是后台：交给上面那条，在下一个字符上判。
			if (char === "&" && command[at + 1] === ">") {
				current += char;
				continue;
			}
			segments.push(current);
			current = "";
			if ((char === "|" || char === "&") && command[at + 1] === char) at++;
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments;
}
