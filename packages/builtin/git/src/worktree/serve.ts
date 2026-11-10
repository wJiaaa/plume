/**
 * 工作树那一半的逻辑：给对话开它自己的 git 工作树，跟着对话的一生收回、检出回来，合回去、同步进来。
 * 由逻辑入口在 `apply` 里调，注册钩子和监听，返回并进 `ctx.serve` 的那一半接口。
 *
 * - 会话第一轮（`prompt.submit` 的 `fresh`）：要工作树、项目是仓库，就开一棵工作树，用 `cwd` 让这个会话从这一轮起在里面跑。
 *   要不要：人在新对话里发的，看输入框上的开关；从某次工具调用开出来的（`spawnedFrom`，比如建议新会话的卡片），看那次调用
 *   有没有经服务 `session.worktree` 登记过；插件开的别的会话（定时任务）不开。这两种都不碰输入框上的开关——那是人给正在写的那个新对话选的。建不成就记下 git 的原话，对话照样在项目里跑，界面上一直有提醒。
 * - 之后的每一轮：目录被收走了就检出回来；检不出来退回项目目录，记下原因。
 * - 删除、归档会话收回目录（有没提交的改动就不收），取消归档检出回来。
 *
 * 不注册工具：agent 在工作树里用 bash 跑 git 就行，这里管的是对话放在哪、人怎么把它收回来。
 * 提供服务 `session.worktree`：别的插件开出来的会话也能要一棵。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginContext, PromptSubmit } from "@plume/contract";
import { canonicalPath } from "../git/paths.ts";
import type { ListedWorktree, SessionWorktree, WorktreeApi, WorktreeSettings } from "./api.ts";
import {
	cleanOldWorktrees,
	createSessionWorktree,
	linkedWorktrees,
	reclaimWorktree,
	removeLinkedWorktree,
	repoRoot,
	restoreWorktree,
	worktreeState,
} from "./lifecycle.ts";
import { abortSync, mergeIntoBase, syncFromBase } from "./merge.ts";
import { createStore } from "./store.ts";

/** 设置里的根目录：开头的 `~` 是家目录，相对路径也从家目录算；留空是 Plume 数据目录下的 `worktrees`。 */
function resolveRoot(rootDir: string, fallback: string): string {
	const trimmed = rootDir.trim();
	if (!trimmed) return fallback;
	if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(1));
	return isAbsolute(trimmed) ? trimmed : resolve(homedir(), trimmed);
}

/** `dir` 是 `root` 本身或在它里面。 */
function within(dir: string, root: string): boolean {
	const inside = relative(canonicalPath(root), canonicalPath(dir));
	return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** 在系统的文件管理器里显示，选中它。 */
function reveal(path: string): Promise<void> {
	const [command, args] =
		process.platform === "darwin" ? ["open", ["-R", path]] : process.platform === "win32" ? ["explorer", [`/select,${path}`]] : ["xdg-open", [dirname(path)]];
	return new Promise((done, fail) => {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.once("error", fail);
		child.once("spawn", () => {
			child.unref();
			done();
		});
	});
}

export function serveWorktrees(ctx: PluginContext): WorktreeApi {
	const store = createStore(ctx.dataDir);
	const defaultRoot = join(ctx.appDataDir, "worktrees");
	/** 输入框上拨过的开关，按项目目录：发出第一条消息时用掉，之后回到关。 */
	const picks = new Map<string, boolean>();
	/** 经服务登记、要工作树的那几次工具调用（`会话 id\n调用 id`）：从它开出来的会话第一轮开始时取走。 */
	const requested = new Set<string>();
	const originKey = (sessionId: string, toolCallId: string) => `${sessionId}\n${toolCallId}`;
	ctx.provide("session.worktree", {
		available: async (cwd) => (await repoRoot(cwd)) !== null,
		requestFor(origin) {
			const key = originKey(origin.sessionId, origin.toolCallId);
			requested.add(key);
			return () => void requested.delete(key);
		},
	});

	/** 同一个会话的事排成一队：建、收回、检出回来不会同时动同一棵工作树。 */
	const queues = new Map<string, Promise<unknown>>();
	const serial = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
		const next = (queues.get(sessionId) ?? Promise.resolve()).then(work);
		const settled = next.catch(() => undefined);
		queues.set(sessionId, settled);
		void settled.then(() => {
			if (queues.get(sessionId) === settled) queues.delete(sessionId);
		});
		return next;
	};

	const summaryOf = async (sessionId: string) => (await ctx.sessions.list()).find((summary) => summary.id === sessionId);
	const running = async (sessionId: string) => (await summaryOf(sessionId))?.running === true;

	/** 自动清理：只在开着时、每建成一棵之后跑；没归档的对话在用的不收。 */
	const cleanUp = async (project: string, settings: WorktreeSettings) => {
		const inUse = (await ctx.sessions.list()).filter((summary) => !summary.archived).map((summary) => summary.cwd);
		// i18n-exempt：日志
		const cleaned = await cleanOldWorktrees(project, settings.keepLimit, inUse).catch(
			(error: unknown) => (ctx.log.warn(`清理旧工作树失败：${String(error)}`), 0),
		);
		// i18n-exempt：日志
		if (cleaned > 0) ctx.log.info(`清理了 ${cleaned} 棵旧工作树`);
	};

	/** 会话第一轮：要工作树、项目是仓库，就开一棵。返回会话该去的目录，不换就是 undefined。 */
	const open = async (input: PromptSubmit): Promise<string | undefined> => {
		const summary = await summaryOf(input.sessionId);
		// 子会话的目录随父会话；不属于项目的聊天没有开关，也不开。
		if (!summary || summary.parentId || !summary.project) return undefined;
		const settings = await store.settings();
		let want: boolean;
		if (summary.spawnedFrom) want = requested.delete(originKey(summary.spawnedFrom.sessionId, summary.spawnedFrom.toolCallId ?? ""));
		// 插件开的、没记来处的（定时任务到点开的）：没人替它选过，输入框上的开关也不是给它的。
		else if (input.launched) want = false;
		else {
			want = picks.get(input.cwd) ?? false;
			picks.delete(input.cwd);
		}
		if (!want || !(await repoRoot(input.cwd))) return undefined;
		const made = await createSessionWorktree(input.cwd, input.sessionId, {
			root: resolveRoot(settings.rootDir, defaultRoot),
			fetchFirst: settings.fetchFirst,
		});
		if ("error" in made) {
			// i18n-exempt：日志
			ctx.log.warn(`会话 ${input.sessionId} 没建成工作树：${made.error}`);
			await store.setRecord(input.sessionId, { error: made.error });
			return undefined;
		}
		await store.setRecord(input.sessionId, { worktree: made.worktree });
		if (settings.autoClean) void cleanUp(input.cwd, settings);
		return made.worktree.cwd;
	};

	/**
	 * 有工作树的会话又开始一轮：目录被收走了就检出回来，检不出来退回项目目录、记下原因。
	 * 会话不在工作树里时：还没发出过消息（第一轮刚建好就停了）就挪进去；发过的是人把它移到了别处，忘掉这棵。
	 */
	const keep = async (input: PromptSubmit, tree: SessionWorktree): Promise<string | undefined> => {
		if (!within(input.cwd, tree.root) && !input.fresh) {
			await store.setRecord(input.sessionId, null);
			return undefined;
		}
		if (!existsSync(tree.root)) {
			const restored = await restoreWorktree(tree);
			if (!restored.ok) {
				// i18n-exempt：日志
				ctx.log.warn(`会话 ${input.sessionId} 的工作树没检出回来：${restored.error}`);
				await store.setRecord(input.sessionId, { error: restored.error });
				return tree.project;
			}
		}
		return within(input.cwd, tree.root) ? undefined : tree.cwd;
	};

	ctx.hook("prompt.submit", async (input, next) => {
		const verdict = await next(input);
		if (verdict.block) return verdict;
		const cwd = await serial(input.sessionId, async () => {
			const record = await store.record(input.sessionId);
			if (record?.worktree) return keep(input, record.worktree);
			// 要过却没建成的不再试：人已经看到它在项目里跑了，下一轮悄悄换地方更糟。
			return input.fresh && !record ? open(input) : undefined;
		});
		return cwd ? { ...verdict, cwd } : verdict;
	});

	// 删了：目录收走，分支上的提交都在基分支里时分支一起删。有没提交的改动就留着目录。
	ctx.sessions.onDeleted((sessionId) => {
		void serial(sessionId, async () => {
			const tree = (await store.record(sessionId))?.worktree;
			if (tree) await reclaimWorktree(tree, { dropMergedBranch: true });
			await store.setRecord(sessionId, null);
			// i18n-exempt：日志
		}).catch((error: unknown) => ctx.log.warn(`收回会话 ${sessionId} 的工作树失败：${String(error)}`));
	});

	// 归档时和删除一样收走；取消归档时在原来的路径检出回来。
	ctx.sessions.onArchived((sessionId, archived) => {
		void serial(sessionId, async () => {
			const tree = (await store.record(sessionId))?.worktree;
			if (!tree) return;
			if (archived) await reclaimWorktree(tree, { dropMergedBranch: true });
			else if (!existsSync(tree.root)) {
				const restored = await restoreWorktree(tree);
				// 下一轮开始时还会再试一次，那时检不出来就退回项目目录。
				// i18n-exempt：日志
				if (!restored.ok) ctx.log.warn(`会话 ${sessionId} 的工作树没检出回来：${restored.error}`);
			}
			// i18n-exempt：日志
		}).catch((error: unknown) => ctx.log.warn(`会话 ${sessionId} 归档时处理工作树失败：${String(error)}`));
	});

	const treeOf = async (sessionId: string) => (await store.record(sessionId))?.worktree ?? null;

	return {
		isRepo: async (cwd) => (await repoRoot(cwd)) !== null,
		worktreePick: async (cwd) => picks.get(cwd) ?? false,
		async chooseWorktree(cwd, on) {
			picks.set(cwd, on);
		},
		worktreeRecord: (sessionId) => store.record(sessionId),
		async worktreeBranches() {
			const found: Record<string, string> = {};
			for (const [sessionId, record] of await store.records()) if (record.worktree) found[sessionId] = record.worktree.branch;
			return found;
		},
		async worktreeState(sessionId) {
			const tree = await treeOf(sessionId);
			return tree ? worktreeState(tree) : null;
		},
		// 合并、同步改的是一轮正在读写的东西，在跑时不开始，和移动会话一样拒绝而不是穿插进去。
		mergeWorktree: (sessionId) =>
			serial(sessionId, async () => {
				const tree = await treeOf(sessionId);
				if (!tree) return { kind: "refused", reason: "gone" } as const;
				if (await running(sessionId)) return { kind: "refused", reason: "running" } as const;
				const outcome = await mergeIntoBase(tree);
				return outcome.kind === "merged" && (await summaryOf(sessionId))?.archived ? { ...outcome, archived: true } : outcome;
			}),
		syncWorktree: (sessionId) =>
			serial(sessionId, async () => {
				const tree = await treeOf(sessionId);
				if (!tree) return { kind: "refused", reason: "gone" } as const;
				if (await running(sessionId)) return { kind: "refused", reason: "running" } as const;
				return syncFromBase(tree);
			}),
		archiveSession: (sessionId) => ctx.sessions.setArchived(sessionId, true),
		abortWorktreeSync: (sessionId) =>
			serial(sessionId, async () => {
				const tree = await treeOf(sessionId);
				if (!tree || (await running(sessionId))) return false;
				return abortSync(tree);
			}),
		reveal: (path) => reveal(path),
		worktreeSettings: async () => ({ ...(await store.settings()), defaultRoot }),
		saveWorktreeSettings: async (patch) => ({ ...(await store.saveSettings(patch)), defaultRoot }),
		async linkedWorktrees(projects) {
			const found: ListedWorktree[] = [];
			for (const project of projects) {
				for (const tree of await linkedWorktrees(project).catch(() => [])) {
					// 两个项目是同一个仓库时只列一次。
					if (found.some((each) => each.path === tree.path)) continue;
					found.push({ path: tree.path, label: tree.path.split(/[\\/]/).findLast(Boolean) ?? tree.path, branch: tree.branch, repo: project });
				}
			}
			return found;
		},
		removeWorktree: async (repo, path) => removeLinkedWorktree((await repoRoot(repo)) ?? repo, path),
	};
}
