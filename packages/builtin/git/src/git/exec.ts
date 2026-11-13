/**
 * 跑 git。
 *
 * 只有这一处起进程，所有调用拿到同样的缓冲上限和同样形状的回答：读的返回 stdout、失败就抛；
 * 写的把成没成当值返回。git 在 stderr 上说很多不是错误的话，所以只看退出码。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitEnv, gitFile } from "@plume/platform";

import type { OpResult, RemoteResult } from "../api.ts";
import { explainGitFailure } from "./errors.ts";
import { say } from "./say.ts";

const execFileAsync = promisify(execFile);

/**
 * 远端操作的环境：这里没有地方让人输入凭据。
 *
 * `GIT_TERMINAL_PROMPT=0` 只管 git 自己的提示；Windows 上 Git Credential Manager 会先弹自己的窗口，
 * 超时杀掉 git 也关不掉它，所以 `GCM_INTERACTIVE=never` 也要（新旧 GCM 认的值不同，`never` 两边都认）。
 */
function remoteGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...gitEnv(base), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
}

/** 只建一次：`process.env` 不会变，每次重建会落在两百个文件的 diff 里每一次 `git show` 上。 */
const GIT_ENV = gitEnv(process.env);
const REMOTE_GIT_ENV = remoteGitEnvironment(process.env);

/**
 * 在真实仓库上自动跑的只有这几种：只读引用、目录位置，不读 index、不读对象内容（别的读在视图里跑，见 `view.ts`）。
 * 它们仍可能因为一个引用指着的对象不在而去连 promisor 远端（`show-ref --verify` 会查对象在不在），远端的地址和
 * 传输方式写在沙箱改得到的配置里，所以对它们关掉惰性拉取：缺对象就是失败，不替谁去连网。
 */
const METADATA_COMMANDS = new Set(["rev-parse", "symbolic-ref", "for-each-ref", "show-ref"]);
const METADATA_GIT_ENV = { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" };

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

/** 每处起 git 都带 `windowsHide`：agent 进程没有控制台，Windows 上不带它，面板每刷新一次就闪一串黑窗口。 */
export async function git(cwd: string, args: string[], { timeoutMs }: { timeoutMs?: number } = {}): Promise<string> {
	const env = METADATA_COMMANDS.has(args[0] ?? "") ? METADATA_GIT_ENV : GIT_ENV;
	const { stdout } = await execFileAsync(gitFile(), args, { cwd, maxBuffer: 32 * 1024 * 1024, env, timeout: timeoutMs, windowsHide: true });
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
 * `env` 给视图里的获取用（`view.ts`），它自己带着不等人的那几个变量。
 */
export async function runRemote(
	cwd: string,
	args: string[],
	{ timeoutMs, signal, env = REMOTE_GIT_ENV }: { timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<RemoteResult> {
	try {
		await execFileAsync(gitFile(), ["-c", "credential.interactive=false", ...args], {
			cwd,
			maxBuffer: 32 * 1024 * 1024,
			env,
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
