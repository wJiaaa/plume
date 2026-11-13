/**
 * 内置插件 plume.git 的逻辑入口：在 agent 进程里跑 git，经 `ctx.serve` 开给自己的界面入口（Git 面板、输入框上方的分支签和改动计数）；
 * 给对话开它自己的工作树、跟着对话的一生收回和检出回来（`worktree/serve.ts`），那一半的接口并进同一个对象开出去。
 *
 * 不注册工具：agent 用 bash 就能跑 git，这里服务的是人看的那一面。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import type { GitApi } from "./api.ts";
import { listBranches, switchBranch } from "./git/branches.ts";
import { buildCommitPrompt, cleanCommitMessage, collectCommitPatch } from "./git/commit-message.ts";
import { collectWorkspaceDiff, readDiffBlob } from "./git/diff.ts";
import {
	commitDiff,
	commitDiffSummary,
	commitStaged,
	createBranch,
	deleteBranch,
	diffRefs,
	fetchRemotes,
	gitLog,
	pullBranch,
	pushBranch,
} from "./git/history.ts";
import { gitBranch, probeRepo } from "./git/probe.ts";
import { initRepo, listRepos, listWorktrees } from "./git/repos.ts";
import { say, setLocaleSource } from "./git/say.ts";
import { discardPaths, gitStatus, stagePaths, unstagePaths, upstreamDistance, workspaceStat } from "./git/status.ts";
import { setGitView } from "./git/view.ts";
import { serveWorktrees } from "./worktree/serve.ts";

const COMMIT_LANGUAGE_IDS = new Set(["zh", "en", "ja", "ko", "es", "fr", "de", "pt", "ru"]);
const DEFAULT_COMMIT_LANGUAGE = "zh";

/** 模型写一句提交说明最多等多久：比这还久，人已经自己写完了。 */
const COMMIT_MESSAGE_TIMEOUT_MS = 45_000;

export default {
	name: "plume.git",
	apply(ctx) {
		setLocaleSource(() => ctx.locale());
		// 读仓库经本体的隔离视图（见 `git/view.ts`）：视图建在 Plume 的数据目录下，沙箱里的命令写不到那里。
		setGitView(ctx.workspace.git);
		const settingsFile = join(ctx.dataDir, "settings.json");

		const readSettings = async (): Promise<{ commitLanguage?: unknown }> => {
			try {
				const parsed: unknown = JSON.parse(await readFile(settingsFile, "utf8"));
				return typeof parsed === "object" && parsed !== null ? (parsed as { commitLanguage?: unknown }) : {};
			} catch {
				return {};
			}
		};
		const commitLanguage = async (): Promise<string> => {
			const stored = (await readSettings()).commitLanguage;
			return typeof stored === "string" && COMMIT_LANGUAGE_IDS.has(stored) ? stored : DEFAULT_COMMIT_LANGUAGE;
		};

		const api: GitApi = {
			async probe(root) {
				const { repo, problem } = await probeRepo(root);
				return { repo, branch: repo ? await gitBranch(root) : null, ...(problem ? { problem } : {}) };
			},
			repos: (root) => listRepos(root),
			worktrees: (cwd) => listWorktrees(cwd),
			init: (cwd) => initRepo(cwd),
			status: (cwd) => gitStatus(cwd),
			stat: (cwd) => workspaceStat(cwd),
			upstream: (cwd) => upstreamDistance(cwd),
			branches: (cwd) => listBranches(cwd),
			switchBranch: (cwd, branch) => switchBranch(cwd, branch),
			createBranch: (cwd, name, from) => createBranch(cwd, name, from ?? undefined),
			deleteBranch: (cwd, name, force) => deleteBranch(cwd, name, force),
			log: (cwd, limit, ref) => gitLog(cwd, limit, ref ?? undefined),
			commitDiff: (cwd, sha) => commitDiff(cwd, sha),
			commitDiffSummary: (cwd, sha) => commitDiffSummary(cwd, sha),
			diffRefs: (cwd, base, head) => diffRefs(cwd, base, head),
			workspaceDiff: (cwd, base) => collectWorkspaceDiff(cwd, base),
			blob: (cwd, path, side) => readDiffBlob(cwd, path, side),
			stage: (cwd, paths) => stagePaths(cwd, paths),
			unstage: (cwd, paths) => unstagePaths(cwd, paths),
			discard: (cwd, paths) => discardPaths(cwd, paths),
			commitStaged: (cwd, message) => commitStaged(cwd, message),
			async generateCommitMessage(cwd, call) {
				const collected = await collectCommitPatch(cwd);
				if (!collected) return { ok: false, error: say().noPatch };
				const prompt = buildCommitPrompt(collected.patch, await commitLanguage(), collected.source);
				try {
					const reply = await ctx.model.complete({
						systemPrompt: prompt.system,
						prompt: prompt.user,
						maxTokens: 400,
						signal: AbortSignal.any([call.signal, AbortSignal.timeout(COMMIT_MESSAGE_TIMEOUT_MS)]),
					});
					const message = cleanCommitMessage(reply);
					return message ? { ok: true, message } : { ok: false, error: say().modelSilent };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			},
			commitLanguage: () => commitLanguage(),
			async setCommitLanguage(id) {
				if (!COMMIT_LANGUAGE_IDS.has(id)) return;
				await writeFile(settingsFile, `${JSON.stringify({ ...(await readSettings()), commitLanguage: id }, null, "\t")}\n`);
			},
			push: (cwd, call) => pushBranch(cwd, { signal: call.signal }),
			pull: (cwd, call) => pullBranch(cwd, { signal: call.signal }),
			fetch: (cwd, quiet, call) => fetchRemotes(cwd, { signal: call.signal, quiet }),
		};
		ctx.serve({ ...api, ...serveWorktrees(ctx) });
	},
} satisfies Plugin;
