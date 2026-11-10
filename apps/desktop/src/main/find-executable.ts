/**
 * 按平台自己的规矩在 PATH 里找一个程序，不起 `which` / `where` 去问。
 *
 * `which` 在精简的系统上没装，`where` 只有 Windows 有；Windows 上命令在磁盘上带扩展名（`code.cmd`、`wt.exe`），
 * 拿裸名字去找永远找不到。平台是参数，Windows 的规矩在跑测试的任何机器上都能验。
 *
 * 不引用 electron，测试才能直接加载它。
 */

import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface FindExecutableOptions {
	platform?: string;
	env?: NodeJS.ProcessEnv;
	/** 判断一个路径是不是这个平台能跑的程序。缺省看磁盘，测试里可以换掉。 */
	isExecutable?: (path: string) => boolean;
}

/** `PATHEXT` 根本没设时 Windows 用的值。 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * 按这个平台的拼法取一个环境变量。
 *
 * Windows 上 `Path` 和 `PATH` 是同一个变量，`process.env` 用一个不分大小写的代理把这件事藏起来了；
 * 复制出来的对象（`{ ...process.env }`）和测试里的普通对象没有这层代理。从资源管理器启动给的是 `Path`，
 * 从 Git Bash 启动给的是 `PATH`，两种都要认。
 */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: string): string | undefined {
	if (env[name] !== undefined || platform !== "win32") return env[name];
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key === undefined ? undefined : env[key];
}

/**
 * 一个命令在磁盘上可能叫的几个文件名。
 *
 * Windows 跑 `code` 时按 `PATHEXT` 的顺序试 `code.com`、`code.exe`、`code.bat`、`code.cmd`，有裸的 `code` 也不跑它。
 * 已经带着其中一个扩展名的按写的找：`code.cmd` 就是那个文件。
 */
export function candidateNames(command: string, platform: string, env: NodeJS.ProcessEnv): string[] {
	if (platform !== "win32") return [command];
	const extensions = (envValue(env, "PATHEXT", platform) || DEFAULT_PATHEXT)
		.split(";")
		.map((extension) => extension.trim().toLowerCase())
		.filter((extension) => extension.startsWith("."));
	const lower = command.toLowerCase();
	if (extensions.some((extension) => lower.endsWith(extension))) return [command];
	return extensions.map((extension) => `${command}${extension}`);
}

/**
 * 去哪些目录找，按 PATH 自己的顺序，重复的只找一次。Windows 允许 PATH 的一项带引号（`"C:\Program Files\Go\bin"`），
 * 引号不是目录的一部分。
 */
export function searchDirs(platform: string, env: NodeJS.ProcessEnv): string[] {
	const delimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
	const dirs = (envValue(env, "PATH", platform) ?? "")
		.split(delimiter)
		.map((dir) => (platform === "win32" ? dir.trim().replace(/^"(.*)"$/, "$1") : dir))
		.filter(Boolean);
	return [...new Set(dirs)];
}

/**
 * 这个路径是不是这个平台会跑的程序。
 *
 * Windows 上只看 `stat` 不够：`WindowsApps` 里的应用执行别名（`wt.exe`、商店装的 `python.exe`）是重解析点，
 * `stat` 跟不过去、直接报错，`lstat` 看得到。别的平台看可执行位，和 shell 一样。
 */
function onDisk(platform: string): (path: string) => boolean {
	if (platform === "win32") {
		return (path) => {
			try {
				return statSync(path).isFile();
			} catch {
				try {
					return !lstatSync(path).isDirectory();
				} catch {
					return false;
				}
			}
		};
	}
	return (path) => {
		try {
			if (!statSync(path).isFile()) return false;
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
}

/** `command` 的完整路径，这台机器上没有时是 null。本身就是路径（带分隔符）的，在原处按同样的扩展名规矩查，不去搜。 */
export function findExecutable(command: string, options: FindExecutableOptions = {}): string | null {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const runnable = options.isExecutable ?? onDisk(platform);
	const path = platform === "win32" ? win32 : posix;
	const names = candidateNames(command, platform, env);

	const isPath = platform === "win32" ? /[\\/]/.test(command) : command.includes("/");
	if (isPath) return names.find((name) => runnable(name)) ?? null;

	for (const dir of searchDirs(platform, env)) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (runnable(candidate)) return candidate;
		}
	}
	return null;
}
