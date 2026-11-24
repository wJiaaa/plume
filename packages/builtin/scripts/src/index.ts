/**
 * plume.scripts 逻辑入口：
 * - 持久化全局与项目脚本配置（`ctx.settings`）；
 * - 通过服务 `terminal.exec` 在终端中运行脚本、跳转终端、归档/删除会话时停止带标记终端；
 * - 订阅服务 `session.worktree` 的 `onCreated`，在工作树建好后自动触发异步或同步初始化脚本；
 * - 通过 `ctx.sessionStore("setup-status")` 向界面入口推送同步等待状态。
 */

import { resolve } from "node:path";
import type { Plugin } from "@plume/contract";
import type { ScriptsApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { readRepoScripts } from "./repo-file.ts";
import { DEFAULT_SETTINGS, deleteScriptFromList, effectiveScripts, normalizeSettings, setupScript, upsertScript } from "./store.ts";
import type { ScriptsSettings, SetupRunStatus } from "./types.ts";

export const STOP_ON_ARCHIVE_TAG = "script-stop-on-archive";

function sameDirectory(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function buildScriptEnv(projectRoot: string, cwd: string): Record<string, string> {
	const env: Record<string, string> = { PLUME_PROJECT_ROOT: projectRoot };
	if (!sameDirectory(projectRoot, cwd)) env.PLUME_WORKTREE_PATH = cwd;
	return env;
}

export default {
	name: "plume.scripts",
	inject: ["terminal.exec", "session.worktree"],
	async apply(ctx) {
		const terminalExec = ctx.use("terminal.exec");
		const worktree = ctx.use("session.worktree");
		const settings = await ctx.settings<ScriptsSettings>(DEFAULT_SETTINGS, normalizeSettings);
		const setupStatus = ctx.sessionStore<SetupRunStatus | null>("setup-status", null);

		const stopTagged = (sessionId: string) => {
			void terminalExec.closeByTag(sessionId, STOP_ON_ARCHIVE_TAG).catch((error: unknown) => {
				ctx.log.warn(`关闭会话 ${sessionId} 的脚本终端失败：${error instanceof Error ? error.message : String(error)}`);
			});
		};

		ctx.sessions.onArchived((sessionId, archived) => {
			if (archived) stopTagged(sessionId);
		});
		ctx.sessions.onDeleted((sessionId) => {
			stopTagged(sessionId);
		});

		const offWorktree = worktree.onCreated(async (info) => {
			const current = effectiveScripts(settings.get(), info.projectId);
			const script = setupScript(current);
			if (!script) return;
			const env: Record<string, string> = {
				PLUME_PROJECT_ROOT: info.projectRoot,
				PLUME_WORKTREE_PATH: info.worktreePath,
			};
			const tag = script.stopOnArchive ? STOP_ON_ARCHIVE_TAG : undefined;
			if (!script.waitForSetup) {
				void terminalExec
					.run({
						sessionId: info.sessionId,
						cwd: info.worktreePath,
						command: script.command,
						env,
						title: script.name,
						...(tag ? { tag } : {}),
						reuseIdle: false,
						reveal: false,
					})
					.catch((error: unknown) => {
						const reason = error instanceof Error ? error.message : String(error);
						ctx.log.warn(`工作树初始化脚本「${script.name}」启动失败：${reason}`);
						ctx.notice(info.sessionId, reason, "error");
					});
				return;
			}

			const started = await terminalExec.run({
				sessionId: info.sessionId,
				cwd: info.worktreePath,
				command: script.command,
				env,
				title: script.name,
				...(tag ? { tag } : {}),
				reuseIdle: false,
				reveal: false,
				waitForExit: true,
				signal: info.signal,
			});
			setupStatus.set(info.sessionId, { scriptName: script.name, tab: started.tab });
			try {
				const outcome = started.completion ? await started.completion : { exitCode: null };
				if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
					ctx.notice(info.sessionId, MESSAGES[ctx.locale()].setupFailed(script.name, outcome.exitCode), "error");
				} else if (outcome.exitCode === null && !info.signal.aborted) {
					ctx.notice(info.sessionId, MESSAGES[ctx.locale()].setupInterrupted(script.name), "warn");
				}
			} finally {
				setupStatus.delete(info.sessionId);
			}
		});
		ctx.effect(offWorktree);

		const updateProjectScripts = async (
			projectId: string | null,
			mutate: (current: readonly import("./types.ts").ProjectScript[]) => {
				scripts: import("./types.ts").ProjectScript[];
				script?: import("./types.ts").ProjectScript;
			},
		) => {
			const current = settings.get();
			if (projectId === null) {
				const next = mutate(current.globalScripts);
				await settings.set({ globalScripts: next.scripts });
				return next.script;
			}
			const base = effectiveScripts(current, projectId);
			const next = mutate(base);
			await settings.set({ byProject: { ...current.byProject, [projectId]: next.scripts } });
			return next.script;
		};

		const api: ScriptsApi = {
			async runScript(sessionId, scriptId) {
				const session = await ctx.sessions.get(sessionId);
				if (!session) throw new Error(MESSAGES[ctx.locale()].sessionNotFound);
				const scripts = effectiveScripts(settings.get(), session.project);
				const script = scripts.find((entry) => entry.id === scriptId);
				if (!script) throw new Error(MESSAGES[ctx.locale()].scriptNotFound);
				const projectRoot =
					(session.project ? (await ctx.sessions.projects()).find((project) => project.id === session.project)?.path : undefined) ?? session.cwd;
				const result = await terminalExec.run({
					sessionId,
					cwd: session.cwd,
					command: script.command,
					env: buildScriptEnv(projectRoot, session.cwd),
					title: script.name,
					...(script.stopOnArchive ? { tag: STOP_ON_ARCHIVE_TAG } : {}),
					reuseIdle: !script.stopOnArchive,
					reveal: true,
				});
				return {
					tab: result.tab,
					previewUrl: script.previewUrl && script.autoOpenPreview ? script.previewUrl : null,
				};
			},
			async revealTerminal(sessionId, tab) {
				await terminalExec.reveal(sessionId, tab);
			},
			async saveScript(projectId, scriptId, input) {
				const saved = await updateProjectScripts(projectId, (list) => upsertScript(list, scriptId, input));
				return saved!;
			},
			async deleteScript(projectId, scriptId) {
				await updateProjectScripts(projectId, (list) => ({ scripts: deleteScriptFromList(list, scriptId) }));
			},
			async resetProject(projectId) {
				const current = settings.get();
				if (!Object.hasOwn(current.byProject, projectId)) return;
				const nextByProject = { ...current.byProject };
				delete nextByProject[projectId];
				await settings.set({ byProject: nextByProject });
			},
			async importRepoScript(projectId, input) {
				const saved = await updateProjectScripts(projectId, (list) => upsertScript(list, null, input));
				return saved!;
			},
			async readRepoScripts(projectPath) {
				return readRepoScripts(projectPath);
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
