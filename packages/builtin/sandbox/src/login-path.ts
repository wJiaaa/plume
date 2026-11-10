/**
 * 从图标启动的应用，命令该带什么环境跑。
 *
 * macOS 上从图标启动的进程，launchd 只给 `/usr/bin:/bin:/usr/sbin:/sbin`。`git`、`python3` 在里面，
 * `node`、`npm`、`pnpm`、`bun` 不在，版本管理器（fnm、nvm、volta、asdf）装的东西也不在：它们都在家目录下，
 * 由 shell 的启动文件宣布出来。
 *
 * 经 `$SHELL -c` 跑救不回来：那是非交互、非登录的 shell，zsh 读完 `~/.zshenv` 就停，几乎人人写在 `~/.zshrc` 里的
 * `export PATH=…` 根本没跑。于是人在自己终端里随手能跑的工具，这里报 `command not found`，看上去是应用坏了。
 *
 * 缺的也不只 `PATH`：启动文件导出的别的东西一样没有——代理（没有它 `git push`、`npm install` 在代理后面超时）、
 * 1Password 这类 ssh agent 的 `SSH_AUTH_SOCK`、`LANG`、`JAVA_HOME`。所以像终端启动那样问 shell 要一次完整环境，记住答案。
 * 问不到时退到一份常见目录的猜测。
 */

import { spawn } from "node:child_process";
import { basename, delimiter } from "node:path";
import { loginShell } from "@plume/platform";
import { homedir } from "node:os";

/** launchd 给图形进程的全部 `PATH`。`PATH` 里没有这之外的目录，说明没有哪个启动文件动过它：应用是双击打开的。 */
const SYSTEM_ONLY = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);

/** 问不到 shell 时去哪找工具：常见的安装位置，尤其是 node 生态的包管理器——找不到 `pnpm` 的兜底不算兜底。 */
const LIKELY = [
	"/usr/local/bin",
	"/opt/homebrew/bin",
	"/opt/local/bin",
	`${homedir()}/.local/bin`,
	`${homedir()}/Library/pnpm`,
	`${homedir()}/.local/share/pnpm`,
	`${homedir()}/.pnpm`,
	`${homedir()}/.bun/bin`,
	`${homedir()}/.cargo/bin`,
	`${homedir()}/.volta/bin`,
	`${homedir()}/.nvm/current/bin`,
	`${homedir()}/.asdf/shims`,
	// mise 把每个版本装在 `installs/<工具>/<版本>` 下，列表猜不到版本号；shims 是唯一不随版本变的入口，和 asdf 同理。
	`${homedir()}/.local/share/mise/shims`,
];

/** 包住答案：交互 shell 可以打招呼、提示更新，都落在同一个 stdout 上，答案要找出来而不是整份当答案。 */
const MARK = "__PLUME_ENV__";

/** 够一份很重的 `~/.zshrc` 跑完，又不至于让卡住的那份拖太久。没有东西在等它（见 `primeCommandPath`），只关乎什么时候放弃。 */
const ASK_TIMEOUT_MS = 5_000;

/** 会说 `-l -i -c` 和单引号的登录 shell。 */
const ASKABLE = new Set(["bash", "zsh", "sh", "dash", "ksh", "fish"]);

/**
 * 只设给被问的那个 shell，免得启动文件把这次询问变成一个会话。
 *
 * oh-my-zsh 的 tmux 插件开了自动启动时会在 `~/.zshrc` 里 exec 进 tmux，询问永远走不到打印环境那一行，每次启动都等满超时。
 * `DISABLE_AUTO_UPDATE` 让 oh-my-zsh 别顺路检查更新。
 */
const ASK_ENV = { DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTARTED: "true", ZSH_TMUX_AUTOSTART: "false" };

/**
 * 说的是回答问题的那个 shell 或本应用，而不是用户的变量。
 *
 * `ELECTRON_RUN_AS_NODE` 是这次询问的方式，留着的话 agent 跑的每个基于 Electron 的命令行（VS Code 的 `code`）都会以裸 Node 启动。
 */
const NOT_THE_USERS = new Set([
	"PWD",
	"OLDPWD",
	"SHLVL",
	"_",
	"PS1",
	"PS2",
	"PS3",
	"PS4",
	"PROMPT",
	"RPROMPT",
	"COLUMNS",
	"LINES",
	"TERM",
	"COLORTERM",
	"WINDOWID",
	"STY",
	"SHELL_SESSION_ID",
	"ZSH_EXECUTION_STRING",
	"ELECTRON_RUN_AS_NODE",
	"ELECTRON_NO_ATTACH_CONSOLE",
	...Object.keys(ASK_ENV),
]);
const NOT_THE_USERS_PREFIX = /^(TERM_|ITERM_|TMUX|KITTY_|WEZTERM_|ALACRITTY_|VTE_|GHOSTTY_)/;

/** 有没有哪个启动文件给这个 `PATH` 添过东西。 */
function assembledByAShell(path: string): boolean {
	return path
		.split(delimiter)
		.filter(Boolean)
		.some((dir) => !SYSTEM_ONLY.has(dir));
}

/** POSIX 单引号；不带反斜杠的内容 fish 也这么读。 */
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * 问用户的登录 shell 它会给终端什么环境。
 *
 * `-l` 读登录文件，`-i` 读 `~/.zshrc`：设置放在哪一个是习惯问题，两种都不少见。shell 里用本进程自己的二进制当 Node
 * 打印 JSON 格式的 `process.env`：值里有换行也不怕，`env` 的输出做不到。stdin 接 `/dev/null`：启动文件要读一行时
 * 不会对着一条没人写的管道等满超时。
 */
async function askShell(): Promise<Record<string, string> | undefined> {
	const shell = loginShell();
	if (!ASKABLE.has(basename(shell))) return undefined;
	const script = `process.stdout.write(${JSON.stringify(MARK)}+JSON.stringify(process.env)+${JSON.stringify(MARK)})`;
	const command = `${quote(process.execPath)} -e ${quote(script)}`;
	for (const flags of [
		["-l", "-i", "-c"],
		["-l", "-c"],
	]) {
		const stdout = await capture(shell, [...flags, command]);
		const answer = stdout?.split(MARK)[1];
		if (!answer) continue;
		try {
			const env = JSON.parse(answer) as Record<string, string>;
			if (typeof env.PATH === "string" && env.PATH.includes(delimiter)) return env;
		} catch {
			// 启动文件自己打印了这个记号。换简单些的参数再试。
		}
	}
	return undefined;
}

/** 跑完一个 shell，返回它的 stdout；失败或超时是 undefined。 */
function capture(file: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		let stdout = "";
		let done = false;
		const finish = (value: string | undefined) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...ASK_ENV, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
		} catch {
			resolve(undefined);
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(undefined);
		}, ASK_TIMEOUT_MS);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => finish(undefined));
		// 导出完一切之后以非零退出的启动文件，答案照样算数。
		child.on("close", () => finish(stdout));
	});
}

/** `extra` 里 `path` 还没有的目录，按顺序、各一次：登录加交互的 shell 会把 `~/.zprofile` 和 `~/.zshrc` 里的同一句各跑一遍。 */
function missingFrom(path: string, extra: string[]): string[] {
	const known = new Set(path.split(delimiter).filter(Boolean));
	const out: string[] = [];
	for (const dir of extra) {
		if (!dir || known.has(dir)) continue;
		known.add(dir);
		out.push(dir);
	}
	return out;
}

/** 只追加不替换：系统目录是找到 `git` 的唯一途径，答错或没答的 shell 不能把它们拿走。 */
const extend = (path: string, extra: string[]): string => [path, ...missingFrom(path, extra)].filter(Boolean).join(delimiter);

/** shell 给出的目录。存 shell 的原话而不是拼好的 `PATH`：要扩展的是调用方的 `PATH`，不一定是本进程的。 */
let resolved: string[] | undefined;
/** shell 导出的其余变量，去掉描述 shell 自己的。 */
let resolvedEnv: Record<string, string> | undefined;
/** 正在进行的询问：同时来的调用方共用一次。 */
let asking: Promise<void> | undefined;
/** `asking` 是真问了，还是只判断了不用问。 */
let asked = false;

/** 本进程是不是从终端启动的：那时的环境就是终端的，包括人启动前刚 export 的，不该拿启动文件的默认值盖掉。 */
const fromTerminal = (): boolean => {
	const term = process.env.TERM;
	return Boolean((term && term !== "dumb") || process.env.TERM_PROGRAM);
};

/**
 * 开始问 shell，答完时兑现。
 *
 * 和 `commandEnv` 分开，因为它慢，而且没有东西等它：同步地问一个登录加交互的 zsh 要一两秒，整个进程跟着卡住。
 * 于是第一条命令用兜底列表，之后的命令用真环境。想让第一条也对的调用方（桌面端启动时）带 `always` 先调一次：
 * 只要不是从终端启动的就问。不带时只有 `PATH` 一看就是没人组装过的才问：命令行和测试跑在终端里，不该为它起 shell。
 */
export function primeCommandPath(options: { always?: boolean } = {}): Promise<void> {
	// Windows 上不问：`PATH` 来自注册表（见 `commandPath`），也没有会说 `-l -i -c` 的登录 shell。
	const wanted = process.platform !== "win32" && (options.always ? !fromTerminal() : !assembledByAShell(process.env.PATH ?? ""));
	if (asking && (asked || !wanted)) return asking;
	if (!wanted) return (asking = Promise.resolve());
	asked = true;
	asking = askShell().then((env) => {
		if (!env) return;
		const dirs = env.PATH?.split(delimiter).filter(Boolean);
		if (dirs?.length) resolved = dirs;
		const kept: Record<string, string> = {};
		for (const [key, value] of Object.entries(env)) {
			if (key === "PATH" || NOT_THE_USERS.has(key) || NOT_THE_USERS_PREFIX.test(key)) continue;
			kept[key] = value;
		}
		resolvedEnv = kept;
	});
	return asking;
}

/** 跑命令用的 `PATH`。能原样还回去就原样还：从终端启动的、测试、Windows 上的每次启动，都不起 shell。 */
function commandPath(inherited: string | undefined): string | undefined {
	// Windows 的图形进程从注册表读 `PATH`，拿到的已经是真的那份。
	if (process.platform === "win32") return inherited;
	const path = inherited ?? "";
	// shell 的顺序在前：那是用户的顺序，人的终端先找到 Homebrew 的 git、nvm 的 node，这里也该一样。
	if (resolved) return extend("", [...resolved, ...path.split(delimiter)]);
	if (assembledByAShell(path)) return inherited;
	// 没人先问过时自愈：第一条命令发起询问、用兜底，第二条就有真答案。
	void primeCommandPath();
	return extend(path, LIKELY);
}

/**
 * 跑命令用的环境：shell 答过之后，它导出的变量盖在继承来的上面，`PATH` 用 `commandPath` 的。
 *
 * `PATH` 只在真变了时才写：Windows 把这个变量拼成 `Path`，`{ ...process.env }` 丢了让两者算同一个键的不区分大小写的代理，
 * 往那个对象上写 `PATH` 会让子进程两个都拿到，哪个生效没法预料。所以 Windows 上原样还回去。
 */
export function commandEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...inherited };
	if (process.platform === "win32") return env;
	if (resolvedEnv) Object.assign(env, resolvedEnv);
	const repaired = commandPath(inherited.PATH);
	if (repaired !== undefined && repaired !== env.PATH) env.PATH = repaired;
	return env;
}
