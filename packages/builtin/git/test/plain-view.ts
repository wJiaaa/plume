/**
 * 测试用的视图替身：直接在真实仓库上跑 git，不做隔离。
 *
 * 隔离（读不到仓库的配置、引用和浅克隆边界照着抄、获取搬引用）是宿主的事，测在 `@plume/workspace` 的
 * `test/host-git.test.ts`：插件只经 `ctx.workspace.git` 用它，自己不再搭视图。这里给的是同样的形状、没有那层保护，
 * 用来看插件自己的读法对不对（status 怎么解析、diff 怎么分边、日志怎么认）。
 */

import { execFile, spawn } from "node:child_process";
import type { PluginGitView, PluginWorkspace } from "@plume/contract";
import { setGitView } from "../src/git/view.ts";

/** 一次 git 最多读多少：和宿主那边一样，够整个仓库的 diff。 */
const MAX_OUTPUT = 64 * 1024 * 1024;

function run(cwd: string, args: string[], buffer: true): Promise<Buffer>;
function run(cwd: string, args: string[], buffer: false): Promise<string>;
function run(cwd: string, args: string[], buffer: boolean): Promise<string | Buffer> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, maxBuffer: MAX_OUTPUT, encoding: buffer ? "buffer" : "utf8", windowsHide: true }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout as string | Buffer);
		});
	});
}

/** 要往 stdin 写的那一个：`cat-file --batch` 一次问很多个对象。 */
function withInput(cwd: string, args: string[], input: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, windowsHide: true });
		const chunks: Buffer[] = [];
		let size = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_OUTPUT) child.kill();
			chunks.push(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ${args.join(" ")} exited ${code}`))));
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

const view = (cwd: string): PluginGitView => ({
	cwd,
	git: (args) => run(cwd, args, false),
	gitBuffer: (args) => run(cwd, args, true),
	gitWithInput: (args, input) => withInput(cwd, args, input),
	async fetch({ signal, timeoutMs }) {
		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawn("git", ["fetch", "--prune"], { cwd, signal, windowsHide: true, stdio: "ignore" });
				const timer = setTimeout(() => child.kill(), timeoutMs);
				child.on("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					if (code === 0) resolve();
					else reject(Object.assign(new Error("fetch failed"), { killed: code === null }));
				});
			});
			return { ok: true };
		} catch (error) {
			const detail = error as { name?: string; killed?: boolean };
			if (detail.name === "AbortError") return { ok: false, cancelled: true };
			return { ok: false, timedOut: detail.killed };
		}
	},
});

/** 和 `ctx.workspace.git` 同形状的替身：测试直接调函数时用它接上 `view.ts`。 */
export const plainGit: PluginWorkspace["git"] = async (root, work) => work(view(root));

/** 让插件后面的读都走这个替身。 */
export function usePlainView(): void {
	setGitView(plainGit);
}
