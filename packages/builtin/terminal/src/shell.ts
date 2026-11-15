/**
 * 新终端跑哪个 shell、怎么起、带什么环境，以及它前台在跑什么。没有 node-pty 的值，测试里直接调。
 */

import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { basename, posix, win32 } from "node:path";
import type { IWindowsPty } from "@xterm/xterm";

/** Windows 的环境变量名不分大小写，`Path` 和 `PATH` 是同一个。 */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: string): string | undefined {
	if (env[name] !== undefined || platform !== "win32") return env[name];
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key === undefined ? undefined : env[key];
}

/**
 * 在 PATH 里找一个能执行的文件；给的是路径就只看它自己。Windows 按 PATHEXT 补扩展名。
 *
 * Windows 上光 `stat` 不够：`WindowsApps` 里的应用执行别名（`wt.exe`、商店装的 `pwsh.exe`）是 `stat` 跟不过去的
 * 重解析点，`lstat` 看得见，所以 `stat` 失败时再问 `lstat`，只要不是目录就算。
 */
export function findExecutable(command: string, platform: string, env: NodeJS.ProcessEnv): string | null {
	const windows = platform === "win32";
	const path = windows ? win32 : posix;
	const extensions = (envValue(env, "PATHEXT", platform) || ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((ext) => ext.trim().toLowerCase())
		.filter((ext) => ext.startsWith("."));
	const names = !windows || extensions.some((ext) => command.toLowerCase().endsWith(ext)) ? [command] : extensions.map((ext) => `${command}${ext}`);
	const runnable = (file: string) => {
		try {
			if (!statSync(file).isFile()) return false;
			if (!windows) accessSync(file, constants.X_OK);
			return true;
		} catch {
			if (!windows) return false;
			try {
				return !lstatSync(file).isDirectory();
			} catch {
				return false;
			}
		}
	};
	if (windows ? /[\\/]/.test(command) : command.includes("/")) return names.find(runnable) ?? null;
	const dirs = (envValue(env, "PATH", platform) ?? "")
		.split(path.delimiter)
		.map((dir) => (windows ? dir.trim().replace(/^"(.*)"$/, "$1") : dir))
		.filter(Boolean);
	for (const dir of new Set(dirs)) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (runnable(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * 新终端跑的 shell。
 *
 * Windows 上 `SHELL` 只由 Git Bash、MSYS2、Cygwin 这类设置，值是它们自己世界里的路径（`/usr/bin/bash`），
 * ConPTY 打不开，终端就一个都起不来。所以那边 `SHELL` 只在是存在的 Windows 路径时才算数；否则依次是
 * PowerShell 7、Windows PowerShell（PATH 里没列也在 System32 里找）、`%ComSpec%`——最后这个总是在的。
 */
export function pickShell(platform: string, env: NodeJS.ProcessEnv, find: (command: string) => string | null): string {
	const declared = env.SHELL?.trim();
	if (platform !== "win32") return declared || "/bin/bash";
	if (declared && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(declared) && find(declared)) return declared;
	const systemRoot = envValue(env, "SystemRoot", platform);
	const inbox = systemRoot ? win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
	return find("pwsh.exe") ?? find("powershell.exe") ?? (inbox ? find(inbox) : null) ?? envValue(env, "ComSpec", platform) ?? "cmd.exe";
}

/**
 * 怎么起这个 shell：macOS 上、以及 Windows 的 Git Bash，作为登录 shell。
 *
 * 从 Dock 启动的应用只继承 launchd 的 `/usr/bin:/bin:/usr/sbin:/sbin`，非登录的 zsh 又跳过 `/etc/zprofile`
 * （path_helper）和 `~/.zprofile`——`brew shellenv` 通常就写在那里。少了它们，`.zshrc` 里的 mise、zoxide、
 * starship 一个接一个找不到，终端里既没有用户的提示符也没有用户的工具。系统自带的终端也都是这样起 shell 的。
 * Git Bash 自己的窗口跑的是 `bash --login -i`，不加 `--login` 就读不到 `.bash_profile`。
 * Linux 的终端习惯起非登录 shell；PowerShell 和 cmd 不认 `-l`。
 */
export function shellArgs(platform: string, shell = ""): string[] {
	if (platform === "darwin") return ["-l"];
	if (platform === "win32" && win32.basename(shell).toLowerCase() === "bash.exe") return ["--login"];
	return [];
}

/**
 * 让新终端的 shell 切到某个目录的那一行（文件树的「在终端打开」），目录原样留在字面量里，不让 shell 展开。
 *
 * PowerShell 的 `cd` 是 `Set-Location -Path`：`[`、`]` 当通配符，带方括号的目录进不去，所以用 `-LiteralPath`；它的单引号
 * 字面量里 `'` 写成 `''`，弯的单引号（U+2018 到 U+201B）也算单引号，一样要成对。cmd 换盘要 `/d`，路径放双引号里（Windows 路径里不会有 `"`）。
 * 其余（包括 Windows 上的 Git Bash）用 POSIX 的单引号写法。
 */
export function cdCommand(platform: string, shell: string, directory: string): string {
	const name = (platform === "win32" ? win32 : posix)
		.basename(shell)
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (name === "pwsh" || name === "powershell") return `Set-Location -LiteralPath '${directory.replace(/[\u0027\u2018-\u201b]/g, "$&$&")}'`;
	if (platform === "win32" && name === "cmd") return `cd /d "${directory}"`;
	return `cd '${directory.replaceAll("'", "'\\''")}'`;
}

/**
 * 继承来的环境，加上描述这个终端的几项。
 *
 * TERM 决定 shell 用不用颜色和光标定位；COLORTERM 告诉 starship、bat、delta 这边能画 24 位色，不然它们退回
 * 256 色。两项都描述的是这个终端，启动应用的那个终端设过什么都覆盖掉。
 *
 * macOS 从 Dock 启动时没有任何区域设置，C 区域下的 shell 把中文文件名显示成 `\M-d\M-8...`。只在三项都空时
 * 补 `LC_CTYPE`：它决定字节怎么变成字符；`LANG` 不动，排序和数字格式留给用户自己的配置。
 */
export function shellEnv(platform: string, base: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	if (platform === "darwin" && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LC_CTYPE = "en_US.UTF-8";
	return env;
}

/** 从这个版本起 node-pty 用 ConPTY，更早的 Windows 10 上是 winpty。 */
const CONPTY_FROM_BUILD = 18309;

/**
 * Windows 上的 pty 要如实告诉 xterm，别处什么都不给。
 *
 * 不说的话 xterm 当它是 Unix 的 pty：ConPTY 在终端变高时不把回滚的行拉回来，而是补空行，面板一拉高，本该回来的那几行
 * 就没了。版本号也要给：xterm 只在 ConPTY 的版本够新（21376 起）时打开换行重排，老版本上重排会乱。`release` 是
 * `os.release()`（`10.0.22631`），读不出版本号时只说后端，回滚的处理打开、重排保持关着，两件事都落在安全的一边。
 */
export function windowsPtyFor(platform: string, release: string | undefined): IWindowsPty | undefined {
	if (platform !== "win32") return undefined;
	const build = Number(release?.split(".")[2]);
	if (!Number.isInteger(build) || build <= 0) return { backend: "conpty" };
	return { backend: build >= CONPTY_FROM_BUILD ? "conpty" : "winpty", buildNumber: build };
}

/**
 * 前台的程序，是 shell 自己或说不清时为空。
 *
 * 标签上写「终端 1 · node」，开着 dev server 的那个不用点开就认得出来；关标签前也按它决定要不要问一句。
 * Windows 的 ConPTY 报的总是 shell，所以那边总是空，不猜。
 */
function foregroundOf(pty: { readonly process: string }, shell: string): string | null {
	let name: string;
	try {
		name = pty.process;
	} catch {
		return null;
	}
	if (!name) return null;
	// 登录 shell 可能写成 `-zsh`；Windows 的带扩展名。
	const own = basename(shell.replace(/\\/g, "/"))
		.replace(/\.exe$/i, "")
		.toLowerCase();
	const seen = basename(name.replace(/\\/g, "/")).replace(/^-/, "");
	return seen.replace(/\.exe$/i, "").toLowerCase() === own ? null : seen;
}

/**
 * 输出停下来一会儿再读一次前台，只报变化。
 *
 * 看输出是因为程序的两头都会出现在输出里：回车启动时回显的那一行，结束时画出的提示符。晚一点读而不是
 * 每块都读：构建一次写几千块，这中间名字不会变。
 */
export function watchForeground(pty: { readonly process: string }, shell: string, report: (process: string | null) => void, delay = 300) {
	let current: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const check = () => {
		timer = null;
		const next = foregroundOf(pty, shell);
		if (next === current) return;
		current = next;
		report(next);
	};
	return {
		poke(): void {
			timer ??= setTimeout(check, delay);
		},
		get current(): string | null {
			return current;
		},
		dispose(): void {
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}
