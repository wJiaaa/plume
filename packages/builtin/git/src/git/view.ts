/**
 * 读仓库：交给本体的隔离视图（`ctx.workspace.git`），这里只负责把结果换成这个插件要的样子。
 *
 * 面板一露面、一轮在跑时每 1.5 秒，这个插件就在宿主进程里（不在沙箱里）读一遍仓库：status、diff、numstat、log、
 * cat-file；面板开着时还每五分钟悄悄获取一次。没有人点任何东西。而 `workspace-write` 下 `.git/config`、
 * `.git/info/attributes`、`.gitattributes` 都是沙箱里的命令写得到的，git 会照着它们去执行程序：`core.fsmonitor`
 * （任何一次读 index）、`filter.<名>.clean/process`、`diff.external`、`diff.<名>.textconv`、`log.showSignature`
 * 带出的 `gpg.program`、写回 index 时的钩子、partial clone 的惰性拉取和获取本身。于是「沙箱写一行配置，面板下一次
 * 刷新在沙箱外替它执行」。
 *
 * 所以不在这里自己压：本体在一个读不到仓库配置的隔离 `GIT_DIR` 里跑，HEAD、引用、分支的上游和远端地址照着真实仓库
 * 抄好，系统和全局配置关掉，没有钩子、没有 promisor（见 `@plume/workspace` 的 `host-git.ts`）。插件只是它的一个调用方：
 * 别的插件要读仓库也走这一条路，改一处就都改了。
 *
 * 边界：人点了按钮才做的事（暂存、提交、推送、拉取、手动获取、切分支、建工作树和它之前的获取、合并同步）仍在真实仓库上跑
 * （`exec.ts`）——人在操作自己的仓库，钩子、凭据助手正是他要的。
 */

import type { PluginGitFetch, PluginWorkspace } from "@plume/contract";
import type { RemoteResult } from "../api.ts";
import { explainGitFailure } from "./errors.ts";
import { say } from "./say.ts";

/** 逻辑入口在 `apply` 里接上本体的 `ctx.workspace.git`；没接上时（直接调函数的测试）读不了仓库。 */
let host: PluginWorkspace["git"] | undefined;

export function setGitView(git: PluginWorkspace["git"]): void {
	host = git;
}

/** 在视图里跑 git：和 `exec.ts` 的 `git` 一样的回答，只是读不到仓库的配置。 */
export interface RepoView {
	/** 调用方给的目录：命令在这里跑，路径和在真实仓库里一样相对于它所在的检出。 */
	cwd: string;
	git(args: string[]): Promise<string>;
	/** 不替调用方决定回答是不是文字：`git show HEAD:logo.png` 回的是 PNG，按 UTF-8 解码就成了乱码。 */
	gitBuffer(args: string[]): Promise<Buffer>;
	/** 要往 stdin 写的那一个调用（`cat-file --batch`）用。 */
	gitWithInput(args: string[], input: string): Promise<Buffer>;
	/** 没人点的那种获取：在视图里取，引用由本体搬回真实仓库。 */
	fetch(options: { signal?: AbortSignal; timeoutMs: number }): Promise<PluginGitFetch>;
}

/** 本体交回的是 `Uint8Array`；转成 `Buffer` 不复制，按缓冲的那几个读法（`toString("utf8", at, end)`）照旧能用。 */
const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * 在视图里做一组读，结束即删。`cwd` 不在检出里时为空。
 * 一组读共用一个视图：搭一个要先在真实仓库上跑几条命令，每条读各搭一个就是每次刷新几十个进程。
 */
export async function withView<T>(cwd: string, work: (view: RepoView) => Promise<T>): Promise<T | null> {
	if (!host) return null;
	return host(cwd, (view) =>
		work({
			cwd: view.cwd,
			git: (args) => view.git(args),
			gitBuffer: (args) => view.gitBuffer(args).then(asBuffer),
			gitWithInput: (args, input) => view.gitWithInput(args, input).then(asBuffer),
			fetch: (options) => view.fetch(options),
		}),
	);
}

/**
 * 没人点的那种获取（面板露面时、之后每五分钟）：在视图里取，引用由本体搬回真实仓库。
 * 失败的说法在这里挑，git 的原话经 `explainGitFailure` 翻成人该做什么。
 */
export async function fetchInView(cwd: string, { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number }): Promise<RemoteResult> {
	const result = await withView(cwd, (view) => view.fetch({ signal, timeoutMs }));
	if (result === null) return { ok: false, error: say().actionFailed };
	if (result.ok) return { ok: true };
	if (result.cancelled) return { ok: false, cancelled: true };
	if (result.timedOut) return { ok: false, error: say().remoteTimeout };
	return { ok: false, error: result.stderr ? explainGitFailure(result.stderr) : say().actionFailed };
}
