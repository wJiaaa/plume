/**
 * 跑 git：用哪个程序、带什么环境。
 *
 * 从仓库里起进程的两处——宿主替会话读工作区、插件替界面读仓库——必须是同一套规矩，否则修了一处漏一处：
 * Windows 上给一个不带路径的名字，进程启动器会先在**工作目录**里找，而工作目录就是仓库，一个顶层带着自己 `git.exe`
 * 的检出会被执行；macOS 上从访达启动的程序只继承 `/usr/bin:/bin:/usr/sbin:/sbin`，Homebrew 的 git 不在里面，
 * 起进程报 ENOENT，读起来和「不是仓库」一模一样。
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, win32 } from "node:path";

/**
 * 让 git 去别处干活的环境变量。
 *
 * 它们都比启动目录优先：继承下来一个 `GIT_DIR`，`rev-parse --is-inside-work-tree` 回答的就是另一个仓库，
 * 界面会对一个好好的仓库说「不是 Git 仓库」。从 git 钩子、`rebase --exec`、还留着它们的终端里启动 Plume
 * 都会带进来；我们从不需要它们，所以丢掉——这里问的就是那个目录本身。
 */
const REDIRECTING = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_PREFIX",
];

/**
 * git 常在的地方（非 Windows）。追加在 PATH 后面，用户自己设的仍然优先。
 * `delimiter` 是当前平台的，所以这段只在不等于 win32 时用。
 */
const LIKELY_PATHS = ["/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", "/usr/bin", "/bin"];

/**
 * 跑 git 的环境：去掉会让 git 去别处干活的变量，补上 git 常在的地方，关掉会等人、会顺手写 index 的行为。
 *
 * git 的提示语固定成英文：错误按英文原话认，中文系统下 git 跟着 LANG 本地化就一条也认不出。只动 `LANGUAGE`
 * （gettext 选消息语言最先看它），不动 `LC_ALL` / `LC_CTYPE`：那两个管编码，改了中文路径会被转义。
 */
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const name of REDIRECTING) delete env[name];
	env.LANGUAGE = "en";
	// 工作树的合并、同步不开编辑器等人关：这里没有人能去关它。
	env.GIT_EDITOR = "true";
	// 面板每隔一会儿跑一次 status：不顺手刷新 index，免得拿着 index.lock 和 agent 正在跑的 `git commit` 撞上。
	env.GIT_OPTIONAL_LOCKS = "0";

	// Windows 的环境变量不分大小写，通常叫 `Path`；展开成普通对象后得自己找是哪个键。
	const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const path = env[pathKey] ?? "";
	if (process.platform !== "win32") {
		const known = new Set(path.split(delimiter).filter(Boolean));
		const missing = LIKELY_PATHS.filter((dir) => !known.has(dir));
		if (missing.length > 0) env[pathKey] = [path, ...missing].filter(Boolean).join(delimiter);
	}
	return env;
}

/** Windows 上能直接运行的文件：存在、是文件。 */
function runnable(path: string): boolean {
	try {
		accessSync(path, constants.F_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * 当作 git 运行的那个文件。
 *
 * 除 Windows 外就是 `git`。Windows 上给一个不带路径的名字，进程启动器会先在工作目录里找——工作目录就是仓库，
 * 一个顶层带着自己 `git.exe` 的检出每次刷新都会被面板执行。所以 Windows 上自己按 PATH 找，跳过相对路径
 * （`.` 会把同一个洞带回来），只认 `.exe`、`.com`：`git.cmd` 不经 shell 起不来。
 * 找不到时为空，调用方报「没有 git」，不让启动器去仓库里找。
 */
export function gitProgram(
	platform: string = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	isRunnable: (path: string) => boolean = runnable,
): string | null {
	if (platform !== "win32") return "git";
	const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
	const dirs = (key ? (env[key] ?? "") : "")
		.split(win32.delimiter)
		.map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
		.filter((dir) => dir && win32.isAbsolute(dir));
	for (const dir of new Set(dirs)) {
		for (const name of ["git.com", "git.exe"]) {
			const candidate = win32.join(dir, name);
			if (isRunnable(candidate)) return candidate;
		}
	}
	return null;
}

/** 找到就留着；没找到下次再找，装上 git 不用重启。 */
let resolvedGit: string | null = null;

export function gitFile(): string {
	resolvedGit ??= gitProgram();
	if (resolvedGit) return resolvedGit;
	// 照启动器的说法写，调用方据此认出「根本没有 git」。
	throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
}
