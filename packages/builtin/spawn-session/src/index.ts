/**
 * plume.spawn-session 的逻辑入口：开别的会话、把手上的事移交出去、做完归档自己。
 *
 * - `spawn_session` 按 `initiation` 分三种：`offer` 弹一张卡问人「新会话 / 就在这里做」，调用等着人选（`run.request`）；
 *   `user_asked` 当场开；`own_initiative` 只在对话里留一张建议卡，人点了「开始」（或让模型带 `proposal_id` 开）才开。
 *   卡片本身就是同意，所以不审批。人选过「以后不再问」后 offer 不弹卡，直接答「就在这里做」。
 * - 只有人说的话引起的那一轮能开会话、能问：别的会话寄来的信、开出来的会话的第一轮（那是来处交代的）里只能提建议。
 * - 开出来的会话在提出它的对话所在的项目里（不在项目里时是它的目录），记着从哪次调用开出来（`spawnedFrom`，带短名），
 *   侧栏里挂在这个对话下面。`fresh` 只带简报（背景加任务），`fork` 带着来处在这次调用之前的整段对话。
 * - 工作树：开关开着（或模型说要）时，开之前经服务 `session.worktree` 登记这次调用，新会话第一轮就在自己的工作树里跑。
 * - `hand_off_to_session` 把做到一半的事 fork 出去，这一轮转去回答人的新话。
 * - 开出来的会话每结束一轮，把汇报交回来处（`reports.ts`），它自己的系统提示词里多一节说明来处和怎么汇报。
 * - `archive_session` 只在人要它归档时用：经 `ToolRun.archiveAfterTurn` 交给本体，并用 `terminate` 让这一轮停在这一下。
 * - 这几件都只给侧栏里的会话：子 Agent、侧边聊天的工具表里藏起来（`model.context`），调到了也拒绝。
 *
 * 随应用发：一个 coding agent 该有。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, Plugin, SessionLaunch, SessionSummary, ThinkingLevel, ToolOutput, ToolRun } from "@plume/contract";
import type { SpawnSessionApi, StartedSuggestion } from "./api.ts";
import { checkArchive, checkHandOff, checkSpawn } from "./check.ts";
import { MESSAGES } from "./messages.ts";
import {
	ARCHIVE_SESSION_DESCRIPTION,
	ARCHIVE_SESSION_PARAMETERS,
	ARCHIVED,
	childSection,
	DISMISS_TASK_DESCRIPTION,
	DISMISS_TASK_PARAMETERS,
	HAND_OFF_DESCRIPTION,
	HAND_OFF_PARAMETERS,
	handOffMessage,
	results,
	SPAWN_SESSION_DESCRIPTION,
	SPAWN_SESSION_PARAMETERS,
	SUGGESTIONS_PER_TURN,
} from "./prompt.ts";
import { Reports } from "./reports.ts";
import {
	ARCHIVE_SESSION,
	type Briefing,
	DISMISS_TASK,
	HAND_OFF,
	isDismissed,
	isOffer,
	isSuggestion,
	SESSION_OFFER,
	type SessionStarted,
	type SessionSuggestion,
	SPAWN_SESSION,
	SUGGESTION_TTL_MS,
} from "./suggestion.ts";
import { humanTurn, suggestionsThisTurn } from "./turns.ts";

const TOOLS = new Set([SPAWN_SESSION, HAND_OFF, DISMISS_TASK, ARCHIVE_SESSION]);

/** offer 卡上人能选的。 */
type OfferChoice = "new" | "here" | "never";

function failed(output: string): ToolOutput {
	return { output, isError: true };
}

/** 一条提议（建议卡、offer）现在怎样：还能开、开过了、不能开（为什么）。 */
type Proposal =
	| { state: "open"; title: string; briefing?: Briefing; suggestion?: SessionSuggestion }
	| { state: "started"; sessionId: string; name?: string }
	| { state: "closed"; reason: string };

export default {
	name: "plume.spawn-session",
	inject: ["session.worktree"],
	// 开出来的会话每一轮都要交回：认它们的收场要看全部会话。
	observe: "all",
	apply(ctx) {
		const worktrees = ctx.use("session.worktree");
		const reports = new Reports({
			get: (id) => ctx.sessions.get(id),
			messages: (id) => ctx.sessions.messages(id),
			reportBack: (id, text, options) => ctx.sessions.reportBack(id, text, options),
			warn: (message) => ctx.log.warn(message),
		});
		ctx.sessions.observe((observation) => reports.observe(observation));
		ctx.sessions.onDeleted((sessionId) => reports.deleted(sessionId));

		/** 要不要先弹卡问（offer 卡上的「以后不再问」、设置 › 常规里的开关）：存在插件的数据目录里，只这一项。 */
		const settingsFile = join(ctx.dataDir, "settings.json");
		let offersOn: Promise<boolean> | undefined;
		const offers = () =>
			(offersOn ??= readFile(settingsFile, "utf8").then(
				(raw) => (JSON.parse(raw) as { offers?: boolean }).offers !== false,
				() => true,
			));
		const setOffers = async (on: boolean) => {
			offersOn = Promise.resolve(on);
			await writeFile(settingsFile, JSON.stringify({ offers: on }));
		};

		ctx.hook("model.context", async (input, next) => {
			// 子会话和插件的独立会话（比如 SSH 的运维助手）都不是侧栏里那段对话（`session.kind` 不是 `top`）：不开会话，也不归档自己。
			if (input.session.kind !== "top") return next({ ...input, tools: input.tools.filter((tool) => !TOOLS.has(tool.name)) });
			const origin = input.session.spawnedFrom;
			if (origin?.toolCallId && (await reports.isOurs(input.sessionId, origin)))
				return next({ ...input, sections: [...input.sections, { id: "spawnedSession", text: childSection(origin.sessionId, origin.name) }] });
			return next(input);
		});

		/** 这条提议开出来的会话：从会话列表的 `spawnedFrom` 认，重启后也对。 */
		async function startedFrom(parentId: string, callId: string): Promise<SessionSummary | undefined> {
			return (await ctx.sessions.list()).find((summary) => summary.spawnedFrom?.sessionId === parentId && summary.spawnedFrom.toolCallId === callId);
		}

		/** 从记录里读一条提议，不信界面和模型交来的：开出来的会话照记录里的那段话做事。 */
		async function proposal(parentId: string, callId: string, messages?: readonly Message[]): Promise<Proposal> {
			const text = MESSAGES[ctx.locale()];
			const already = await startedFrom(parentId, callId);
			if (already) return { state: "started", sessionId: already.id, ...(already.spawnedFrom?.name ? { name: already.spawnedFrom.name } : {}) };
			const log = messages ?? (await ctx.sessions.messages(parentId));
			const result = log.find((message) => message.role === "toolResult" && message.toolCallId === callId && message.toolName === SPAWN_SESSION);
			const details = result?.role === "toolResult" && !result.isError ? result.details : undefined;
			if (log.some((message) => message.role === "toolResult" && isDismissed(message.details) && message.details.proposalId === callId))
				return { state: "closed", reason: text.withdrawn };
			if (isSuggestion(details)) {
				if (details.expiresAt <= Date.now()) return { state: "closed", reason: text.expired };
				return { state: "open", title: details.title, suggestion: details };
			}
			if (isOffer(details) && details.choice === "new") return { state: "open", title: details.title };
			return { state: "closed", reason: text.gone };
		}

		/** 两次点得太快时只开一个。 */
		const launching = new Map<string, Promise<SessionSummary>>();
		// 新会话开在父会话的项目目录里；父会话的目录是它，或是它的一棵工作树，同一个仓库，问哪个都一样。
		const offersWorktree = async (parent: SessionSummary) => (parent.project ? worktrees.available(parent.cwd) : false);

		/** 从 `parentId` 里 `callId` 那次调用开出一个会话；同一次调用只开一次。 */
		function launch(parentId: string, callId: string, briefing: Briefing, choice: { model?: string; thinking?: ThinkingLevel } = {}): Promise<SessionSummary> {
			const key = `${parentId}\n${callId}`;
			const pending =
				launching.get(key) ??
				(async () => {
					const already = await startedFrom(parentId, callId);
					if (already) return already;
					const parent = await ctx.sessions.get(parentId);
					if (!parent) throw new Error(MESSAGES[ctx.locale()].parentGone);
					// 登记在开之前：新会话第一轮的 prompt.submit 里取走它。开出来以后不撤，撤了会和第一轮抢。
					// 能不能开在这里现问，不信界面交来的结论：卡片刚画出来、还没问到能不能开时点了「开始」，交来的只是开关的起始值。
					const undo =
						briefing.worktree === true && (await offersWorktree(parent)) ? worktrees.requestFor({ sessionId: parent.id, toolCallId: callId }) : undefined;
					const spawnedFrom = { sessionId: parent.id, toolCallId: callId, ...(briefing.name ? { name: briefing.name } : {}) };
					const options: SessionLaunch = {
						...(parent.project ? { project: parent.project } : { cwd: parent.cwd }),
						message: briefing.message,
						// 新会话叫提议的标题，不叫那段写给模型的话的开头。
						title: briefing.title,
						...(choice.model ? { model: choice.model } : {}),
						...(choice.thinking ? { thinking: choice.thinking } : {}),
						...(briefing.fork ? { fork: true } : {}),
						spawnedFrom,
					};
					try {
						const launched = await ctx.sessions.launch(options);
						reports.launched(launched.session.id, spawnedFrom, briefing.title);
						return launched.session;
					} catch (error) {
						undo?.();
						throw error;
					}
				})().finally(() => launching.delete(key));
			launching.set(key, pending);
			return pending;
		}

		/** 当场开，答模型开出了谁。 */
		async function startNow(run: ToolRun, callId: string, briefing: Briefing, extra: Partial<SessionStarted> = {}): Promise<ToolOutput> {
			try {
				const session = await launch(run.sessionId, callId, briefing);
				const details: SessionStarted = {
					kind: "session_started",
					title: briefing.title,
					...(briefing.name ? { name: briefing.name } : {}),
					sessionId: session.id,
					...extra,
				};
				const output = extra.handOff
					? results.handedOff(briefing.title, briefing.name, session.id)
					: results.started(briefing.title, briefing.name, session.id);
				return { output, details };
			} catch (error) {
				return failed(error instanceof Error ? error.message : String(error));
			}
		}

		ctx.tools.register({
			name: SPAWN_SESSION,
			description: SPAWN_SESSION_DESCRIPTION,
			parameters: SPAWN_SESSION_PARAMETERS,
			async execute(args, run) {
				if (run.session.kind !== "top") return failed(results.onlyTop);
				const request = checkSpawn(args);
				if ("error" in request) return failed(request.error);
				const messages = await ctx.sessions.messages(run.sessionId);
				// 开出来的会话的第一轮是来处交代的：那句话看着像人说的，其实不是。
				const human = humanTurn(messages) && !reports.inFirstTurn(run.sessionId);
				if (request.kind === "suggest") {
					const earlier = suggestionsThisTurn(messages);
					for (const call of run.calls) {
						if (call.id === run.toolCallId) break;
						if (call.name === SPAWN_SESSION && call.args.initiation === "own_initiative" && call.args.proposal_id === undefined) earlier.add(call.id);
					}
					if (earlier.size >= SUGGESTIONS_PER_TURN) return failed(results.tooMany);
					const details: SessionSuggestion = {
						kind: "session_suggestion",
						...request.briefing,
						summary: request.summary,
						expiresAt: Date.now() + SUGGESTION_TTL_MS,
					};
					return { output: results.suggested(details.title), details };
				}
				if (!human) return failed(results.notHuman);
				if (request.kind === "now") return startNow(run, run.toolCallId, request.briefing);
				if (request.kind === "offer") {
					const title = request.title;
					if (!(await offers())) return { output: results.offerSkipped(title), details: { kind: "session_offer", title, choice: "here" } };
					const text = MESSAGES[ctx.locale()];
					const reply = await run.request<OfferChoice>({ kind: SESSION_OFFER, title: text.offerTitle, payload: { title }, waiting: text.offerWaiting });
					const choice = reply.answered ? reply.value : "here";
					if (choice === "never") await setOffers(false);
					if (choice === "new") return { output: results.offerNew(title, run.toolCallId), details: { kind: "session_offer", title, choice: "new" } };
					return {
						output: choice === "never" ? results.offerNever(title) : results.offerHere(title),
						details: { kind: "session_offer", title, choice: "here" },
					};
				}
				// 带 proposal_id：开一张建议卡，或者补上人选了「新会话」的那次 offer 的简报。
				const found = await proposal(run.sessionId, request.proposalId, messages);
				if (found.state === "started") return { output: results.alreadyStarted(found.name, found.sessionId) };
				if (found.state === "closed") return failed(found.reason);
				const briefing: Briefing | undefined = found.suggestion ?? (request.briefing ? { title: found.title, ...request.briefing } : undefined);
				// i18n-exempt：发给模型的话。
				if (!briefing) return failed('That offer has no brief yet: call again with proposal_id plus prompt and background (or context "fork").');
				const name = typeof args.name === "string" ? args.name : found.suggestion?.name;
				return startNow(run, request.proposalId, { ...briefing, ...(name ? { name } : {}) }, { proposalId: request.proposalId });
			},
		});

		ctx.tools.register({
			name: HAND_OFF,
			description: HAND_OFF_DESCRIPTION,
			parameters: HAND_OFF_PARAMETERS,
			async execute(args, run) {
				if (run.session.kind !== "top") return failed(results.onlyTop);
				const briefing = checkHandOff(args);
				if ("error" in briefing) return failed(briefing.error);
				if (!humanTurn(await ctx.sessions.messages(run.sessionId)) || reports.inFirstTurn(run.sessionId)) return failed(results.notHuman);
				return startNow(run, run.toolCallId, { ...briefing, message: handOffMessage(briefing.message) }, { handOff: true });
			},
		});

		ctx.tools.register({
			name: DISMISS_TASK,
			description: DISMISS_TASK_DESCRIPTION,
			parameters: DISMISS_TASK_PARAMETERS,
			async execute(args, run) {
				if (run.session.kind !== "top") return failed(results.onlyTop);
				// i18n-exempt：发给模型的话。
				if (typeof args.proposal_id !== "string" || !args.proposal_id) return failed("proposal_id is required.");
				const found = await proposal(run.sessionId, args.proposal_id);
				if (found.state === "started") return { output: results.alreadyStarted(found.name, found.sessionId) };
				if (found.state === "closed") return failed(found.reason);
				// i18n-exempt：发给模型的话。
				if (!found.suggestion) return failed("Only a suggestion card (own_initiative) can be dismissed.");
				return { output: results.dismissed, details: { kind: "session_dismissed", proposalId: args.proposal_id } };
			},
		});

		ctx.tools.register({
			name: ARCHIVE_SESSION,
			description: ARCHIVE_SESSION_DESCRIPTION,
			parameters: ARCHIVE_SESSION_PARAMETERS,
			async execute(args, run) {
				// 工具表里已经藏起来了；这里再认一次，挡住别的路子把它放回子会话的工具表。本体也只给顶层会话 `archiveAfterTurn`。
				// i18n-exempt：发给模型的话。
				if (!run.archiveAfterTurn || run.session.kind !== "top")
					return failed("Only the conversation itself can archive itself; a sub-agent or plugin-owned session cannot.");
				const checked = checkArchive(args);
				if ("error" in checked) return failed(checked.error);
				run.archiveAfterTurn();
				// 这一轮就停在这里：归档等这一轮收场，之后再说的话会跟着对话一起收起来，没人读。
				return { output: ARCHIVED, details: { kind: "session_archive", ...checked }, terminate: "done" };
			},
		});

		const api: SpawnSessionApi = {
			async started(parentId) {
				return (await ctx.sessions.list()).flatMap((summary): StartedSuggestion[] => {
					const from = summary.spawnedFrom;
					return from?.sessionId === String(parentId) && from.toolCallId ? [{ callId: from.toolCallId, sessionId: summary.id }] : [];
				});
			},
			async offersWorktree(parentId) {
				const parent = await ctx.sessions.get(String(parentId));
				return parent ? offersWorktree(parent) : false;
			},
			offers,
			async setOffers(on) {
				await setOffers(on === true);
			},
			async start(parentId, callId, choice) {
				const found = await proposal(String(parentId), String(callId));
				if (found.state === "started") return found.sessionId;
				if (found.state === "closed" || !found.suggestion) throw new Error(found.state === "closed" ? found.reason : MESSAGES[ctx.locale()].gone);
				const { worktree: _worktree, ...rest } = found.suggestion;
				const briefing: Briefing = { ...rest, ...(choice.worktree === true ? { worktree: true } : {}) };
				const session = await launch(String(parentId), String(callId), briefing, {
					// 卡片上没动过就不给，用默认模型、默认推理强度。
					...(choice.model ? { model: choice.model } : {}),
					...(choice.thinking ? { thinking: choice.thinking } : {}),
				});
				return session.id;
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
