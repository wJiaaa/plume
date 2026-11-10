import { isUtf8 } from "node:buffer";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { SandboxProcess, SandboxService } from "@plume/contract";
import { words } from "../messages.ts";
import { beginMutation } from "./change-lock.ts";
import { recordFileChange } from "./file-changes.ts";
import { withinOrIs } from "./home.ts";
import { assessRead } from "./read-access.ts";
import { openRepo, withRepoView, type HostGit, type HostRepo } from "./host-git.ts";
import type { ToolContext, ToolResult } from "./types.ts";

interface Snapshot {
	repo: HostRepo;
	files: Map<string, string | null>;
}
interface CommandChanges {
	changeIds: string[];
	changeWarning?: string;
}
interface Observation {
	read(): Promise<CommandChanges>;
}
const KEY = "commandChanges";

async function names(git: HostGit, head: string | null): Promise<string[]> {
	const [tracked, untracked] = await Promise.all([
		git(
			head
				? ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", head, "--"]
				: ["ls-files", "--cached", "-z"],
		),
		git(["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	return [...new Set((tracked + untracked).split("\0").filter(Boolean))];
}

async function content(root: string, path: string): Promise<string | null> {
	const absolute = join(root, path);
	if (!withinOrIs(root, absolute)) throw new Error(words().changeObserveFailed);
	// 观测不是用户授权读取密钥；这些文件只说明未覆盖，不保存内容副本。
	if (assessRead(absolute, root).decision !== "allow" || /^\.env(?:\.|$)/i.test(basename(absolute)) || /\.(?:pem|key|p12|pfx)$/i.test(absolute))
		throw new Error(words().changeSecret);
	try {
		const stat = await lstat(absolute);
		if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || (await realpath(absolute)) !== absolute) throw new Error(words().changeLargeFile);
		const bytes = await readFile(absolute);
		if (bytes.length > 2 * 1024 * 1024) throw new Error(words().changeLargeFile);
		if (!isUtf8(bytes) || bytes.includes(0)) throw new Error(words().changeBinary);
		return bytes.toString("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function beforeCommand(ctx: ToolContext): Promise<Snapshot | null> {
	if (!ctx.dataDir || !ctx.sessionId) return null;
	const repo = await openRepo(ctx.cwd);
	if (!repo) return null;
	repo.root = await realpath(repo.root);
	const paths = await withRepoView(repo, (git) => names(git, repo.head));
	if (paths.length > 200) throw new Error(words().changeManyBefore);
	const files = new Map<string, string | null>();
	let bytes = 0;
	for (const path of paths) {
		const value = await content(repo.root, path);
		bytes += Buffer.byteLength(value ?? "", "utf8");
		if (bytes > 16 * 1024 * 1024) throw new Error(words().changeLargeBefore);
		files.set(path, value);
	}
	return { repo, files };
}

export async function afterCommand(ctx: ToolContext, before: Snapshot | null): Promise<string[]> {
	if (!before) return [];
	const { root, head } = before.repo;
	return withRepoView(before.repo, async (git) => {
		const paths = [...new Set([...(await names(git, head)), ...before.files.keys()])];
		if (paths.length > 200) throw new Error(words().changeManyAfter);
		const changes: { path: string; before: string | null; after: string | null }[] = [];
		let bytes = 0;
		for (const path of paths) {
			const absolute = join(root, path),
				after = await content(root, path);
			let original = before.files.get(path);
			if (original === undefined) {
				// 隔离视图没有 filter 驱动；这里只做 Git 自带的换行和编码转换，不执行仓库程序。
				try {
					original = head ? await git(["cat-file", "--filters", `${head}:${relative(root, absolute).split("\\").join("/")}`]) : null;
				} catch {
					// 只有初始树里不存在的路径才算新建；缺失对象或转换失败不能伪造空白历史。
					if (head && (await git(["--literal-pathspecs", "ls-tree", "-z", head, "--", path]))) throw new Error(words().changeObserveFailed);
					original = null;
				}
			}
			if (Buffer.byteLength(original ?? "", "utf8") > 2 * 1024 * 1024) throw new Error(words().changeLargeFile);
			bytes += Buffer.byteLength(original ?? "", "utf8") + Buffer.byteLength(after ?? "", "utf8");
			if (bytes > 16 * 1024 * 1024) throw new Error(words().changeLargeAfter);
			if (original !== after) changes.push({ path: absolute, before: original, after });
		}
		const ids: string[] = [];
		for (const change of changes) {
			const id = await recordFileChange(ctx, change.path, change.before, change.after, "command");
			if (id) ids.push(id);
		}
		return ids;
	});
}

function observations(ctx: ToolContext): Map<string, Observation> {
	let found = ctx.state.get(KEY) as Map<string, Observation> | undefined;
	if (!found) ctx.state.set(KEY, (found = new Map()));
	return found;
}

/** 门闩跟进程走，不跟工具结果走；超时、停止请求和转后台都不等于进程已经退出。 */
export async function withCommandChanges(ctx: ToolContext, action: (ctx: ToolContext) => Promise<ToolResult>): Promise<ToolResult> {
	const release = beginMutation();
	const persistent = !!ctx.dataDir && !!ctx.sessionId;
	let before: Snapshot | null = null;
	let changeWarning: string | undefined;
	try {
		before = await beforeCommand(ctx);
	} catch (error) {
		changeWarning = words().changeWarning(
			error instanceof Error && Object.values(words()).includes(error.message) ? error.message : words().changeObserveFailed,
		);
	}
	let started = false,
		ended = false;
	let completion: Promise<CommandChanges> = Promise.resolve({ changeIds: [] });
	const watch = (process: SandboxProcess) => {
		process.onExit((_code, _signal, lingering) => {
			if (lingering) {
				watch(lingering);
				return;
			}
			if (ended) return;
			ended = true;
			completion = (async () => {
				try {
					return { changeIds: await afterCommand(ctx, before), ...(changeWarning ? { changeWarning } : {}) };
				} catch (error) {
					return {
						changeIds: [],
						changeWarning: words().changeWarning(
							error instanceof Error && Object.values(words()).includes(error.message) ? error.message : words().changeObserveFailed,
						),
					};
				} finally {
					release();
				}
			})();
		});
		process.onError(() => {
			if (!ended) {
				ended = true;
				release();
			}
		});
	};
	const observation: Observation = {
		read: () => (ended ? completion : Promise.resolve({ changeIds: [], changeWarning: changeWarning ?? words().changeBackground })),
	};
	const sandbox: SandboxService | undefined = ctx.sandbox
		? {
				looksDenied: (output) => ctx.sandbox!.looksDenied(output),
				run(command, options) {
					const process = ctx.sandbox!.run(command, options);
					started = true;
					watch(process);
					return process;
				},
			}
		: undefined;
	try {
		const result = await action({ ...ctx, ...(sandbox ? { sandbox } : {}) });
		if (!persistent || !started) return result;
		const details = result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
		const id = typeof details.jobId === "string" ? details.jobId : typeof details.id === "string" ? details.id : undefined;
		if (id) observations(ctx).set(id, observation);
		return { ...result, details: { ...details, ...(await observation.read()) } };
	} finally {
		if (!started) release();
	}
}

export async function commandChangesForJob(ctx: ToolContext, id: string): Promise<CommandChanges | undefined> {
	return observations(ctx).get(id)?.read();
}
