/**
 * 一条命令改了哪些文件：命令起来之前、结束以后各问一次 git 工作区里改动着的文件，对比原文，改了的记进快照（`change-store.ts`，来源记 `command`，
 * 不能自动撤销，只供汇总和撤回时说清）。`ToolRun.exec` 带 `recordChanges` 时本体替工具做（`@plume/agent` 的 `run-files.ts`）。
 *
 * 问 git 经隔离视图（`host-git.ts`）：仓库配置是沙箱可写的。观测不是用户授权读取：密钥、`.env`、证书只说明没记全，不保存内容副本；
 * 太大、太多、二进制的同样只说明没记全。观测期间占着改动门闩，直到进程（连同它留下的进程）真正退出：超时、停止请求、转后台都不等于进程已经退出。
 */

import { isUtf8 } from "node:buffer";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { SandboxProcess } from "@plume/contract";
import { withinOrIs } from "@plume/platform";
import type { ChangeLock } from "./change-lock.ts";
import type { ChangeStore } from "./change-store.ts";
import type { ChangeWords } from "./change-words.ts";
import { openRepo, withRepoView, type HostGit, type HostRepo } from "./host-git.ts";
import { SECRET_PATH } from "./read-access.ts";

interface Snapshot {
	repo: HostRepo;
	files: Map<string, string | null>;
}

/** 一条命令观测到的改动：快照标识、改了的文件（真实绝对路径），没记全时给人看的话。 */
interface CommandRecord {
	ids: string[];
	paths: string[];
	warning?: string;
}

/** 一条正在观测的命令。 */
export interface CommandObservation {
	/** 观测的是这个会话里的命令。 */
	readonly sessionId: string;
	/**
	 * 盯住起来的进程：它退出时（留下的进程也退出以后）对比、记快照、放开门闩。`adopt` 在它留下进程时调，交出那个进程。
	 */
	watch(process: SandboxProcess, adopt: (lingering: SandboxProcess) => void): void;
	/** 命令没起来：放开门闩，什么都不记。 */
	abandon(): void;
	/** 已经结束的交回记下的改动；还在跑的交回一句「结束后才记」。 */
	read(): Promise<CommandRecord>;
}

/** 超过这些就不记了，只说明没记全。 */
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

class Refused extends Error {}

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

async function content(root: string, path: string, words: ChangeWords): Promise<string | null> {
	const absolute = join(root, path);
	if (!withinOrIs(root, absolute)) throw new Refused(words.changeObserveFailed);
	// 观测不是用户授权读取密钥；这些文件只说明未覆盖，不保存内容副本。
	if (SECRET_PATH.test(absolute) || /^\.env(?:\.|$)/i.test(basename(absolute)) || /\.(?:pem|key|p12|pfx)$/i.test(absolute))
		throw new Refused(words.changeSecret);
	try {
		const stat = await lstat(absolute);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (await realpath(absolute)) !== absolute) throw new Refused(words.changeLargeFile);
		const bytes = await readFile(absolute);
		if (bytes.length > MAX_FILE_BYTES) throw new Refused(words.changeLargeFile);
		if (!isUtf8(bytes) || bytes.includes(0)) throw new Refused(words.changeBinary);
		return bytes.toString("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export class CommandChanges {
	constructor(
		private readonly dataDir: string,
		private readonly store: ChangeStore,
		private readonly lock: ChangeLock,
		private readonly words: () => ChangeWords,
	) {}

	/** 命令起来之前：占住门闩（撤销进行中抛错），拍下工作区里已经改动着的文件。拍不了的不挡命令，只记一句没记全。 */
	async begin(scope: { sessionId: string; cwd: string }): Promise<CommandObservation> {
		const release = this.lock.beginMutation();
		let before: Snapshot | null = null;
		let warning: string | undefined;
		try {
			before = await this.snapshot(scope.cwd);
		} catch (error) {
			warning = this.words().changeWarning(this.reason(error));
		}
		let ended = false;
		let completion: Promise<CommandRecord> = Promise.resolve({ ids: [], paths: [] });
		const watch = (process: SandboxProcess, adopt: (lingering: SandboxProcess) => void) => {
			process.onExit((_code, _signal, lingering) => {
				if (lingering) {
					adopt(lingering);
					watch(lingering, adopt);
					return;
				}
				if (ended) return;
				ended = true;
				completion = (async () => {
					try {
						return { ...(await this.compare(scope.sessionId, before)), ...(warning ? { warning } : {}) };
					} catch (error) {
						return { ids: [], paths: [], warning: this.words().changeWarning(this.reason(error)) };
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
		return {
			sessionId: scope.sessionId,
			watch,
			abandon: () => {
				ended = true;
				release();
			},
			read: () => (ended ? completion : Promise.resolve({ ids: [], paths: [], warning: warning ?? this.words().changeBackground })),
		};
	}

	/** 说给人听的原因：认得的就是那一句，别的一律说「读不了 Git 工作区」。 */
	private reason(error: unknown): string {
		return error instanceof Refused ? error.message : this.words().changeObserveFailed;
	}

	private async snapshot(cwd: string): Promise<Snapshot | null> {
		const words = this.words();
		const repo = await openRepo(cwd);
		if (!repo) return null;
		repo.root = await realpath(repo.root);
		const paths = await withRepoView(repo, this.dataDir, (git) => names(git, repo.head));
		if (paths.length > MAX_FILES) throw new Refused(words.changeManyBefore);
		const files = new Map<string, string | null>();
		let bytes = 0;
		for (const path of paths) {
			const value = await content(repo.root, path, words);
			bytes += Buffer.byteLength(value ?? "", "utf8");
			if (bytes > MAX_TOTAL_BYTES) throw new Refused(words.changeLargeBefore);
			files.set(path, value);
		}
		return { repo, files };
	}

	private async compare(sessionId: string, before: Snapshot | null): Promise<{ ids: string[]; paths: string[] }> {
		if (!before) return { ids: [], paths: [] };
		const words = this.words();
		const { root, head } = before.repo;
		const changes = await withRepoView(before.repo, this.dataDir, async (git) => {
			const paths = [...new Set([...(await names(git, head)), ...before.files.keys()])];
			if (paths.length > MAX_FILES) throw new Refused(words.changeManyAfter);
			const found: { path: string; before: string | null; after: string | null }[] = [];
			let bytes = 0;
			for (const path of paths) {
				const absolute = join(root, path),
					after = await content(root, path, words);
				let original = before.files.get(path);
				if (original === undefined) {
					// 隔离视图没有 filter 驱动；这里只做 Git 自带的换行和编码转换，不执行仓库程序。
					try {
						original = head ? await git(["cat-file", "--filters", `${head}:${relative(root, absolute).split("\\").join("/")}`]) : null;
					} catch {
						// 只有初始树里不存在的路径才算新建；缺失对象或转换失败不能伪造空白历史。
						if (head && (await git(["--literal-pathspecs", "ls-tree", "-z", head, "--", path]))) throw new Refused(words.changeObserveFailed);
						original = null;
					}
				}
				if (Buffer.byteLength(original ?? "", "utf8") > MAX_FILE_BYTES) throw new Refused(words.changeLargeFile);
				bytes += Buffer.byteLength(original ?? "", "utf8") + Buffer.byteLength(after ?? "", "utf8");
				if (bytes > MAX_TOTAL_BYTES) throw new Refused(words.changeLargeAfter);
				if (original !== after) found.push({ path: absolute, before: original, after });
			}
			return found;
		});
		const ids: string[] = [];
		const paths: string[] = [];
		for (const change of changes) {
			const id = await this.store.record(sessionId, change.path, change.before, change.after, "command");
			if (!id) continue;
			ids.push(id);
			paths.push(change.path);
		}
		return { ids, paths };
	}
}
