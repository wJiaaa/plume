/**
 * 跑 git。
 *
 * 只有这一处起进程，所有调用拿到同样的缓冲上限和同样形状的回答：读的返回 stdout、失败就抛；
 * 写的把成没成当值返回。git 在 stderr 上说很多不是错误的话，所以只看退出码。
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, win32 } from "node:path";
import { promisify } from "node:util";

import type { OpResult, RemoteResult } from "../api.ts";
import { explainGitFailure } from "./errors.ts";
import { say } from "./say.ts";

const execFileAsync = promisify(execFile);

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
 * git 常在的地方。macOS 上从访达启动的程序只继承 `/usr/bin:/bin:/usr/sbin:/sbin`，Homebrew 的 git 不在里面，
 * 起进程报 ENOENT，读起来和「不是仓库」一模一样。追加在后面，用户自己设的 PATH 仍然优先。
 */
const LIKELY_PATHS = ["/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", "/usr/bin", "/bin"];

function gitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const name of REDIRECTING) delete env[name];
	/*
	 * git 的提示语固定成英文：`errors.ts` 按英文原话认错误，中文系统下 git 跟着 LANG 本地化就一条也认不出。
	 * 只动 LANGUAGE（gettext 选消息语言最先看它），不动 LC_ALL / LC_CTYPE：那两个管编码，改了中文路径会被转义。
	 */
	env.LANGUAGE = "en";
	// 工作树的合并、同步不开编辑器等人关：这里没有人能去关它。
	env.GIT_EDITOR = "true";

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

/**
 * 远端操作的环境：这里没有地方让人输入凭据。
 *
 * `GIT_TERMINAL_PROMPT=0` 只管 git 自己的提示；Windows 上 Git Credential Manager 会先弹自己的窗口，
 * 超时杀掉 git 也关不掉它，所以 `GCM_INTERACTIVE=never` 也要（新旧 GCM 认的值不同，`never` 两边都认）。
 */
function remoteGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...gitEnvironment(base), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
}

/** 只建一次：`process.env` 不会变，每次重建会落在两百个文件的 diff 里每一次 `git show` 上。 */
const GIT_ENV = gitEnvironment(process.env);
const REMOTE_GIT_ENV = remoteGitEnvironment(process.env);

/**
 * 放在每个作为位置参数交给 git 的引用、分支、标签前面。
 *
 * 引用名可以以 `-` 开头：克隆带来一个 `refs/tags/--output=/tmp/x`，`git log --output=/tmp/x..HEAD` 就会写出
 * 一个仓库作者指定的文件。这个标记之后 git 把每个参数都当修订或名字。git 2.24 起支持；更老的 git
 * 把标记本身当未知选项而失败，不会去做别的事。`rev-parse` 2.30 才认，不给它加。
 */
export const END_OF_OPTIONS = "--end-of-options";

export const MAX_FILES = 200;
export const MAX_BLOB_BYTES = 400_000;

/**
 * 同时在跑的逐文件读取上限。每个都是一次起进程或一次读盘：不设上限，两百个文件就是同一瞬间两百个
 * git 进程；一个一个来又全是等待。八个让起进程的延迟和读盘重叠，又不至于让别处感觉到。
 */
const FILE_CONCURRENCY = 8;

/** 带上限的 `Promise.all`，结果按输入顺序。 */
export async function mapLimit<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const out = Array.from<R>({ length: items.length });
	let next = 0;
	const workers = Array.from({ length: Math.min(FILE_CONCURRENCY, items.length) }, async () => {
		for (let i = next++; i < items.length; i = next++) out[i] = await run(items[i] as T);
	});
	await Promise.all(workers);
	return out;
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
 * 除 Windows 外就是 `git`。Windows 上给一个不带路径的名字，进程启动器会先在**工作目录**里找——工作目录
 * 就是仓库，一个顶层带着自己 `git.exe` 的检出每次刷新都会被面板执行。所以 Windows 上自己按 PATH 找，
 * 跳过相对路径（`.` 会把同一个洞带回来），只认 `.exe`、`.com`：`git.cmd` 不经 shell 起不来。
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

function gitFile(): string {
	resolvedGit ??= gitProgram();
	if (resolvedGit) return resolvedGit;
	// 照启动器的说法写，`probeRepo` 据此认出「根本没有 git」。
	throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
}

/** 每处起 git 都带 `windowsHide`：agent 进程没有控制台，Windows 上不带它，面板每刷新一次就闪一串黑窗口。 */
export async function git(cwd: string, args: string[], { timeoutMs }: { timeoutMs?: number } = {}): Promise<string> {
	const { stdout } = await execFileAsync(gitFile(), args, { cwd, maxBuffer: 32 * 1024 * 1024, env: GIT_ENV, timeout: timeoutMs, windowsHide: true });
	return stdout;
}

/** 要往 stdin 写的那一个调用（`cat-file --batch`）用；环境和别处一样，不然继承来的 `GIT_DIR` 会让它读别的仓库。 */
export function spawnGit(cwd: string, args: string[]): ChildProcessWithoutNullStreams {
	return spawn(gitFile(), args, { cwd, env: GIT_ENV, windowsHide: true });
}

/** 不替调用方决定回答是不是文字：`git show HEAD:logo.png` 回的是 PNG，按 UTF-8 解码就成了乱码。 */
export async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
	const { stdout } = await execFileAsync(gitFile(), args, { cwd, maxBuffer: 32 * 1024 * 1024, encoding: "buffer", env: GIT_ENV, windowsHide: true });
	return stdout;
}

/** 为了效果跑 git，报成没成。原话要留着：「would be overwritten by merge」比一个「失败」有用得多。 */
export async function run(cwd: string, args: string[]): Promise<OpResult> {
	try {
		await git(cwd, args);
		return { ok: true };
	} catch (error) {
		const detail = error as { stderr?: string; stdout?: string; message?: string };
		const text = (detail.stderr || detail.stdout || detail.message || "").trim();
		return { ok: false, error: text.split("\n").slice(0, 3).join("\n") || say().actionFailed };
	}
}

/** 读的结果去掉首尾空白；失败是 null。 */
export const output = (cwd: string, args: string[]) =>
	git(cwd, args).then(
		(text) => text.trim(),
		() => null,
	);

/** 只问成不成：`show-ref --verify`、`merge-base --is-ancestor` 这类拿退出码回答的。 */
export const succeeds = (cwd: string, args: string[]) =>
	git(cwd, args).then(
		() => true,
		() => false,
	);

/**
 * 跑一条要连远端的 git 命令。
 *
 * 和 `run` 分开，因为一碰网络什么都不一样了：
 * - **要能停**：不答也不拒的主机会把 `fetch` 卡到 TCP 放弃为止，面板在它跑的时候禁着别的按钮。所以有超时，也接 `signal`。
 * - **不能等人**：见 `remoteGitEnvironment`，另加 `credential.interactive=false`。
 * 不设 `GIT_ASKPASS`：指向一个什么都不答的程序会让 git 拿空用户名去认证，失败原因就从「没地方问你」变成「凭据被拒」，说错了原因。
 */
export async function runRemote(cwd: string, args: string[], { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<RemoteResult> {
	try {
		await execFileAsync(gitFile(), ["-c", "credential.interactive=false", ...args], {
			cwd,
			maxBuffer: 32 * 1024 * 1024,
			env: REMOTE_GIT_ENV,
			timeout: timeoutMs,
			signal,
			windowsHide: true,
		});
		return { ok: true };
	} catch (error) {
		const detail = error as { stderr?: string; message?: string; killed?: boolean; name?: string };
		// 先认取消：被中止的子进程也是被杀掉的，先问 `killed` 会把每次取消都报成超时。
		if (detail.name === "AbortError") return { ok: false, cancelled: true };
		// 超时被杀时 stderr 是空的，message 只是「Command failed: git …」，说了跑的什么，没说哪里错。
		if (detail.killed) return { ok: false, error: say().remoteTimeout };
		return { ok: false, error: explainGitFailure(detail.stderr ?? detail.message ?? "") };
	}
}
