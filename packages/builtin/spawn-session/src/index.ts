/**
 * plume.spawn-session 的逻辑入口：作用在「对话本身」上的两件工具。`spawn_session` 建议另开一个会话，`archive_session` 做完后归档自己。
 *
 * - 工具只在对话里留一张建议卡片、当场返回，人点了「开始」才开——卡片本身就是同意，所以不审批。
 * - 只给侧栏里的会话：子 Agent、侧边聊天的工具表里藏起来（`model.context`），调到了也拒绝。替子会话画的卡片没处画。
 * - 「开始」经界面入口调 `start`：开在提建议的对话所在的项目里（不在项目里时是它的目录），第一句是建议里的提示词，
 *   记着从这次调用开出来（`spawnedFrom`），侧栏里挂在这个对话下面。卡片据此认出「开始过了」，重启后也认得。
 * - 卡片上的工作树开关开着时，开之前经服务 `session.worktree` 登记这次调用，新会话第一轮就在自己的工作树里跑。
 * - 要求交回的，第一轮跑完、闲下来以后把最后那段回复送回这个对话（`follow.ts`）。
 * - `archive_session` 只在人要它归档时用：工具里不当场归档（这一轮还在等它的结果），经 `ToolRun.archiveAfterTurn` 交给本体，
 *   并用 `terminate` 让这一轮停在这一下，本体在这一轮以完成收场后归档。同样只给侧栏里的会话：替子会话归档的是派它来的人的对话。
 *
 * 随应用发：一个 coding agent 该有。
 */

import type { Plugin, SessionSummary } from "@plume/contract";
import type { SpawnSessionApi, StartedSuggestion } from "./api.ts";
import { checkArchive, checkSuggestion } from "./check.ts";
import { Followers } from "./follow.ts";
import { MESSAGES } from "./messages.ts";
import { ARCHIVE_SESSION_DESCRIPTION, ARCHIVE_SESSION_PARAMETERS, ARCHIVED, SPAWN_SESSION_DESCRIPTION, SPAWN_SESSION_PARAMETERS, suggested } from "./prompt.ts";
import { ARCHIVE_SESSION, isSuggestion, SPAWN_SESSION } from "./suggestion.ts";

export default {
	name: "plume.spawn-session",
	inject: ["session.worktree"],
	apply(ctx) {
		const worktrees = ctx.use("session.worktree");
		const followers = new Followers({
			title: async (sessionId) => (await ctx.sessions.list()).find((summary) => summary.id === sessionId)?.title,
			warn: (message) => ctx.log.warn(message),
		});
		ctx.sessions.onDeleted((sessionId) => followers.deleted(sessionId));

		/** 子会话和插件的独立会话（`owner`，比如 SSH 的运维助手）都不是侧栏里那段对话：不建议新会话，也不归档自己。 */
		const isChild = async (sessionId: string) => {
			const self = (await ctx.sessions.list()).find((summary) => summary.id === sessionId);
			return Boolean(self?.parentId || self?.owner);
		};

		ctx.hook("model.context", async (input, next) => {
			if (await isChild(input.sessionId))
				return next({ ...input, tools: input.tools.filter((tool) => tool.name !== SPAWN_SESSION && tool.name !== ARCHIVE_SESSION) });
			return next(input);
		});

		ctx.tools.register({
			name: SPAWN_SESSION,
			description: SPAWN_SESSION_DESCRIPTION,
			parameters: SPAWN_SESSION_PARAMETERS,
			async execute(args, run) {
				// i18n-exempt：发给模型的话。
				if (await isChild(run.sessionId))
					return { output: "Only a main conversation can suggest a new session; a sub-agent, side chat or plugin-owned session cannot.", isError: true };
				const suggestion = checkSuggestion(args);
				if ("error" in suggestion) return { output: suggestion.error, isError: true };
				return { output: suggested(suggestion.title, suggestion.reportBack === true), details: suggestion };
			},
		});

		ctx.tools.register({
			name: ARCHIVE_SESSION,
			description: ARCHIVE_SESSION_DESCRIPTION,
			parameters: ARCHIVE_SESSION_PARAMETERS,
			async execute(args, run) {
				// 工具表里已经藏起来了；这里再认一次，挡住别的路子把它放回子会话的工具表。本体也只给顶层会话 `archiveAfterTurn`。
				// i18n-exempt：发给模型的话。
				if (!run.archiveAfterTurn || (await isChild(run.sessionId)))
					return { output: "Only the conversation itself can archive itself; a sub-agent or plugin-owned session cannot.", isError: true };
				const checked = checkArchive(args);
				if ("error" in checked) return { output: checked.error, isError: true };
				run.archiveAfterTurn();
				// 这一轮就停在这里：归档等这一轮收场，之后再说的话会跟着对话一起收起来，没人读。
				return { output: ARCHIVED, details: { kind: "session_archive", ...checked }, terminate: "done" };
			},
		});

		/** 这条建议开出来的会话：从会话列表的 `spawnedFrom` 认，重启后也对。 */
		async function startedFrom(parentId: string, callId: string): Promise<string | undefined> {
			return (await ctx.sessions.list()).find((summary) => summary.spawnedFrom?.sessionId === parentId && summary.spawnedFrom.toolCallId === callId)?.id;
		}
		/** 两次点得太快时只开一个。 */
		const launching = new Map<string, Promise<string>>();
		// 新会话开在父会话的项目目录里；父会话的目录是它，或是它的一棵工作树，同一个仓库，问哪个都一样。
		const offersWorktree = async (parent: SessionSummary) => (parent.project ? worktrees.available(parent.cwd) : false);

		const api: SpawnSessionApi = {
			async started(parentId) {
				return (await ctx.sessions.list()).flatMap((summary): StartedSuggestion[] => {
					const from = summary.spawnedFrom;
					if (from?.sessionId !== String(parentId) || !from.toolCallId) return [];
					const entry = followers.get(summary.id);
					return [{ callId: from.toolCallId, sessionId: summary.id, reportBack: entry?.reportBack ?? false, firstTurn: entry?.firstTurn ?? false }];
				});
			},
			async offersWorktree(parentId) {
				const parent = (await ctx.sessions.list()).find((summary) => summary.id === String(parentId));
				return parent ? offersWorktree(parent) : false;
			},
			start(parentId, callId, choice) {
				const key = `${String(parentId)}\n${String(callId)}`;
				const pending =
					launching.get(key) ??
					(async () => {
						const already = await startedFrom(String(parentId), String(callId));
						if (already) return already;
						const text = MESSAGES[ctx.locale()];
						const parent = (await ctx.sessions.list()).find((summary) => summary.id === String(parentId));
						if (!parent) throw new Error(text.parentGone);
						// 从记录里读，不信界面交来的：开出来的会话照这段话做事。
						const result = (await ctx.sessions.messages(parent.id)).find((message) => message.role === "toolResult" && message.toolCallId === callId);
						const details = result?.role === "toolResult" && !result.isError ? result.details : undefined;
						if (!isSuggestion(details)) throw new Error(text.gone);
						// 登记在开之前：新会话第一轮的 prompt.submit 里取走它。开出来以后不撤，撤了会和第一轮抢。
						// 能不能开在这里现问，不信界面交来的结论：卡片刚画出来、还没问到能不能开时点了「开始」，交来的只是开关的起始值。
						const undo =
							choice.worktree === true && (await offersWorktree(parent))
								? worktrees.requestFor({ sessionId: parent.id, toolCallId: String(callId) })
								: undefined;
						let launched: Awaited<ReturnType<typeof ctx.sessions.launch>>;
						try {
							launched = await ctx.sessions.launch({
								...(parent.project ? { project: parent.project } : { cwd: parent.cwd }),
								message: details.prompt,
								// 新会话叫建议的标题，不叫那段写给模型的提示词的开头。
								title: details.title,
								// 卡片上没动过就不给，用默认模型、默认推理强度。
								...(choice.model ? { model: choice.model } : {}),
								...(choice.thinking ? { thinking: choice.thinking } : {}),
								spawnedFrom: { sessionId: parent.id, toolCallId: String(callId) },
							});
						} catch (error) {
							undo?.();
							throw error;
						}
						followers.follow(launched, { title: details.title, reportBack: choice.reportBack === true });
						return launched.session.id;
					})().finally(() => launching.delete(key));
				launching.set(key, pending);
				return pending;
			},
			async setReportBack(sessionId, on) {
				return followers.set(String(sessionId), on === true);
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
