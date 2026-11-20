/**
 * 侧边聊天插件的逻辑入口。侧边聊天是挂在用户会话下面的子会话（`ctx.sessions.create`），所以记录、审批、事件、
 * 删父会话时一起删，都和普通会话一样；这里只管它和普通会话不一样的地方：
 *
 * - `prompt.submit`：每一问后面附上主会话上次之后的新内容（见 main-chat.ts），每一问读到哪里记在插件数据目录的 `marks.json`，
 *   编辑重问截掉的那几问一起作废；
 *   主会话的下一问后面附上侧边聊天这期间改过的文件（见 changes.ts），经本体的 `ctx.changes` 认改动记录。
 * - `model.context`：身份、准则换成侧边聊天的，工具只留读主会话、交出去、控制主会话、读写文件、跑命令、查网页（见 profile.ts）。
 *   普通会话里藏起这三件侧边聊天专用的，`tool.execute` 再拦一次子 Agent 这类别的会话。
 * - `dispatch_task`、`control_main`（见 controls.ts）：经宿主给的父会话（`ToolRun.parent`）把活排进主会话、让它停下或接着做；
 *   人没点名交给主会话时只留一张卡片，人在卡上选交给主会话、开新会话（`launch`），还是就在这里做。
 * - `/btw 问题`：开一个新的侧边聊天问这句话，打开面板；主对话里什么都不留。
 * - 排队条上的「在侧边聊天中打开」（界面入口的 `ui.queueAction`）：那条排着的话拿到最早那段侧边聊天去问，附件跟着走。
 * - 在跑时说的话（见 waiting.ts）：回车插进这一轮（`ctx.sessions.steer`），⌘回车排到这一轮之后，插件自己排，`observe` 看到这一轮以完成收场、
 *   闲下来时一句一句发；插进去没读到的转进队头。
 * - `ctx.serve`：面板列出、新开、提问、插话、排队、停止、关掉侧边聊天；交出去的卡片上「开新会话」。
 * - `ctx.settings`：设置 › 智能体里「侧边聊天默认模型」。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, Plugin, PromptSection, SessionMessage, StopReason } from "@plume/contract";
import { type LaunchChoice, normalizeSettings, type SideChatApi } from "./api.ts";
import { createSideChatBindings } from "./bindings.ts";
import { changeIds, sideChangesNote } from "./changes.ts";
import { CONTROL_MAIN, DISPATCH_TASK, isDispatchSuggestion } from "./controls.ts";
import {
	type HistoryArgs,
	HISTORY_PARAMETERS,
	invalidHistoryArgs,
	type Mark,
	type MarkLog,
	mainChatContext,
	markBefore,
	readHistory,
	withMark,
} from "./main-chat.ts";
import { MESSAGES } from "./messages.ts";
import { GUIDELINES_TEXT, IDENTITY, KINDS, READ_MAIN_CHAT_DESCRIPTION, SIDE_ONLY } from "./profile.ts";
import { createWaiting } from "./waiting.ts";

export default {
	name: "plume.side-chat",
	async apply(ctx) {
		/** 侧边聊天 → 它挂在哪个会话旁边。 */
		const sides = new Map<string, string>();
		const all = await ctx.sessions.list();
		for (const summary of all) if (summary.owner === ctx.name && summary.parentId) sides.set(summary.id, summary.parentId);
		/** 现有的会话：删会话时插件没在跑（停用着、删到一半退出）留下的记录，加载时对着它清掉。 */
		const live = new Set(all.map((summary) => summary.id));
		/**
		 * 每段侧边聊天已经告诉过主会话到哪里：几条消息、最后一条的时刻。读过的那段还原样在就从条数接着读；
		 * 编辑重问截掉过一段（那一条的时刻对不上了）就只认之后写的，截掉后接着写的消息落在旧的条数里面，按条数会漏掉。
		 * 只在内存里：重启前没来得及说的不再补，加载时从现有的末尾算起，免得把早就说过的改动再说一遍。
		 */
		const noted = new Map<string, Mark>();
		const markOf = (messages: readonly Message[]): Mark => ({ seen: messages.length, lastAt: messages.at(-1)?.timestamp ?? 0 });
		for (const sideId of sides.keys()) noted.set(sideId, markOf(await ctx.sessions.messages(sideId).catch(() => [])));

		const marksFile = join(ctx.dataDir, "marks.json");
		const marks = new Map<string, MarkLog>(
			Object.entries(
				await readFile(marksFile, "utf8").then(
					(text) => JSON.parse(text) as Record<string, MarkLog>,
					() => ({}),
				),
			),
		);
		let saving: Promise<void> = Promise.resolve();
		const saveMarks = () => {
			const body = JSON.stringify(Object.fromEntries(marks));
			saving = saving
				.then(async () => {
					await writeFile(`${marksFile}.tmp`, body);
					await rename(`${marksFile}.tmp`, marksFile);
				})
				.catch((error: unknown) => ctx.log.warn(`读到哪里没存上：${String(error)}`));
		};
		const stale = [...marks.keys()].filter((id) => !live.has(id));
		for (const id of stale) marks.delete(id);
		if (stale.length > 0) saveMarks();
		// 新的侧边聊天用哪个模型；没选就跟随主会话。只管新开的，已经开着的沿用它开时的模型。
		const settings = await ctx.settings({ model: undefined }, normalizeSettings);

		/** 用上面的默认模型建；人在面板里要换，会话已经在了，照常经输入框的模型菜单换。 */
		async function open(parentId: string): Promise<string> {
			const model = settings.get().model;
			const side = await ctx.sessions.create({ parentId, ...(model ? { model } : {}) });
			sides.set(side.id, parentId);
			noted.set(side.id, { seen: 0, lastAt: 0 });
			return side.id;
		}

		/** 这个主会话旁边的侧边聊天上次告诉它之后改过的文件，说过的往后挪；没有就是空的。 */
		async function sideChanges(parentId: string): Promise<string | undefined> {
			const paths = new Set<string>();
			for (const [sideId, parent] of sides) {
				if (parent !== parentId) continue;
				const messages = await ctx.sessions.messages(sideId).catch(() => undefined);
				if (!messages) continue;
				const mark = noted.get(sideId) ?? { seen: 0, lastAt: 0 };
				const intact = mark.seen <= messages.length && (mark.seen === 0 || messages[mark.seen - 1]?.timestamp === mark.lastAt);
				const fresh = intact ? messages.slice(mark.seen) : messages.filter((message) => message.timestamp > mark.lastAt);
				const ids = changeIds(fresh);
				noted.set(sideId, markOf(messages));
				if (ids.length === 0) continue;
				// 改动记录读不出来（快照已清掉、会话没了）时少说几个文件，不拦下主会话这一问。
				const summary = await ctx.changes.collect(sideId, ids).catch(() => undefined);
				for (const file of summary?.files ?? []) paths.add(file.path);
			}
			return paths.size > 0 ? sideChangesNote([...paths]) : undefined;
		}

		const bindings = await createSideChatBindings({
			file: join(ctx.dataDir, "tabs.json"),
			parentOf: (sideId) => sides.get(sideId),
			list: async (parentId) =>
				(await ctx.sessions.list())
					.filter((summary) => summary.owner === ctx.name && summary.parentId === parentId)
					.sort((a, b) => b.createdAt - a.createdAt)
					.map((summary) => ({ id: summary.id, title: summary.title, createdAt: summary.createdAt })),
			open,
			close: (sideId) => ctx.sessions.delete(sideId),
			missing: () => new Error(MESSAGES[ctx.locale()].missing),
		});
		await bindings.keepOnly(live);
		ctx.sessions.onDeleted((sessionId) => {
			sides.delete(sessionId);
			noted.delete(sessionId);
			waiting.forget(sessionId);
			lastStop.delete(sessionId);
			if (marks.delete(sessionId)) saveMarks();
			// i18n-exempt：插件数据写入失败的日志。
			void bindings.forget(sessionId).catch((error: unknown) => ctx.log.warn(`侧边聊天标签没存上：${String(error)}`));
		});

		function sideOf(sideId: string): string {
			if (!sides.has(sideId)) throw new Error(MESSAGES[ctx.locale()].missing);
			return sideId;
		}

		const waiting = createWaiting();
		/** 每段侧边聊天上一轮为什么收场：以完成收场才往下发排着的，被人停下的留着等人。 */
		const lastStop = new Map<string, StopReason>();
		/** 等这段侧边聊天跑起来的：`start` 发出去以后，跑起来就返回，不等它答完。 */
		const starting = new Map<string, Set<() => void>>();
		const notify = (sideId: string, error: unknown) => {
			const parentId = sides.get(sideId);
			const message = error instanceof Error ? error.message : String(error);
			if (parentId) ctx.notice(parentId, message, "error");
			else ctx.log.warn(message);
		};

		/** 发一句、开一轮，跑起来（或这一句被拦下、当场收场）就返回；开不了时抛错。跑起来以后的错误在这一轮的记录里，这里只记日志。 */
		async function start(sideId: string, message: string | SessionMessage): Promise<void> {
			let began!: () => void;
			const running = new Promise<void>((resolve) => (began = resolve));
			const waiters = starting.get(sideId) ?? new Set();
			starting.set(sideId, waiters.add(began));
			let started = false;
			const turn = ctx.sessions.send(sideId, message);
			try {
				await Promise.race([turn, running]);
				started = true;
			} finally {
				waiters.delete(began);
				if (waiters.size === 0) starting.delete(sideId);
			}
			// i18n-exempt：日志。
			if (started) turn.catch((error: unknown) => ctx.log.warn(`侧边聊天这一轮出错：${String(error)}`));
		}

		/** 闲着就发排着的队头；发不出去的放回队头，说一声。 */
		async function drain(sideId: string): Promise<void> {
			if (!sides.has(sideId) || (await ctx.sessions.get(sideId))?.running) return;
			const next = waiting.next(sideId);
			if (!next) return;
			try {
				await start(sideId, next.message);
			} catch (error) {
				waiting.requeue(sideId, next);
				notify(sideId, error);
			}
		}

		ctx.sessions.observe((observation) => {
			const sideId = observation.sessionId;
			if (!sides.has(sideId)) return;
			const event = observation.event;
			if (event.type === "turnEnd") lastStop.set(sideId, event.stop.reason);
			else if (event.type === "running" && event.running) for (const began of starting.get(sideId) ?? []) began();
			// 读到的插话会出现在下一次请求里：对着存下的消息认（请求里的经过压缩，位置对不上）。
			else if (event.type === "request" && waiting.hasSteered(sideId))
				void ctx.sessions.messages(sideId).then(
					(messages) => waiting.read(sideId, messages, false),
					() => undefined,
				);
			else if (event.type === "running") {
				// 收场了：读到的插话拿掉，没读到的转进队头；以完成收场的接着发排着的。
				void ctx.sessions
					.messages(sideId)
					.then((messages) => {
						waiting.read(sideId, messages, true);
						if (lastStop.get(sideId) === "done") return drain(sideId);
					})
					// i18n-exempt：日志。
					.catch((error: unknown) => ctx.log.warn(`侧边聊天排着的话没发出去：${String(error)}`));
			}
		});

		/** 界面交来的只取正文、气泡上的字和附件：不能借这条路冒充派发方（`origin`）。 */
		function bodyOf(message: string | SessionMessage): string | SessionMessage {
			return typeof message === "string"
				? message
				: {
						content: message.content,
						...(message.displayText !== undefined ? { displayText: message.displayText } : {}),
						...(message.attachments ? { attachments: message.attachments } : {}),
						...(message.sessionRefs ? { sessionRefs: message.sessionRefs } : {}),
					};
		}

		/** 闲着、前面没有排着的就当场开一轮；否则排到后面（闲着时由这一下推着往前走）。 */
		async function ask(sideId: string, body: string | SessionMessage): Promise<void> {
			const running = (await ctx.sessions.get(sideId))?.running === true;
			if (!running && !waiting.hasQueued(sideId)) return start(sideId, body);
			waiting.queue(sideId, body);
			if (!running) await drain(sideId);
		}

		ctx.hook("prompt.submit", async (input, next) => {
			const parentId = sides.get(input.sessionId);
			if (!parentId) {
				const verdict = await next(input);
				if (verdict.block || ![...sides.values()].includes(input.sessionId)) return verdict;
				const note = await sideChanges(input.sessionId);
				return note ? { ...verdict, context: verdict.context ? `${verdict.context}\n\n${note}` : note } : verdict;
			}
			const verdict = await next(input);
			if (verdict.block) return verdict;
			const parent = await ctx.sessions.get(parentId);
			// 这一问还没写进去：已有几条就是它的位置。
			const at = (await ctx.sessions.messages(input.sessionId)).length;
			const log = marks.get(input.sessionId) ?? [];
			const context = mainChatContext(await ctx.sessions.messages(parentId), parent?.running === true, markBefore(log, at));
			marks.set(input.sessionId, withMark(log, at, context.mark));
			saveMarks();
			return { block: false, context: verdict.context ? `${verdict.context}\n\n${context.text}` : context.text };
		});

		/** 侧边聊天能用的工具：自己的（`SIDE_ONLY`），加上按种类（`KINDS`）、类别（`category: "web"`）挑的别的插件的，不认工具名。 */
		function usable(): (name: string) => boolean {
			const picked = new Set(ctx.tools.list().flatMap((tool) => ((tool.kind && KINDS.has(tool.kind)) || tool.category === "web" ? [tool.name] : [])));
			return (name) => SIDE_ONLY.has(name) || picked.has(name);
		}

		ctx.hook("model.context", async (input, next) => {
			if (!sides.has(input.sessionId)) return next({ ...input, tools: input.tools.filter((tool) => !SIDE_ONLY.has(tool.name)) });
			// 身份、准则两段按类别（`PromptSection.category`）换成侧边聊天自己的，不认提供它们的插件定的段名；段名和位置照旧。
			const sections: PromptSection[] = input.sections.map((section) =>
				section.category === "identity" ? { ...section, text: IDENTITY } : section.category === "guidelines" ? { ...section, text: GUIDELINES_TEXT } : section,
			);
			const allowed = usable();
			return next({ ...input, sections, tools: input.tools.filter((tool) => allowed(tool.name)) });
		});

		ctx.hook("tool.execute", async (input, next) => {
			// i18n-exempt：发给模型的工具结果。
			if (sides.has(input.sessionId) && !usable()(input.call.name))
				return { output: `The "${input.call.name}" tool is not available in a side chat.`, isError: true };
			return next(input);
		});

		ctx.tools.register({
			name: "read_main_chat",
			description: READ_MAIN_CHAT_DESCRIPTION,
			parameters: HISTORY_PARAMETERS,
			async execute(args, run) {
				const parentId = sides.get(run.sessionId);
				// i18n-exempt：发给模型的工具结果。
				if (!parentId) return { output: "read_main_chat only works in a side chat.", isError: true };
				const invalid = invalidHistoryArgs(args);
				if (invalid) return { output: invalid, isError: true };
				return { output: readHistory(parentId, await ctx.sessions.messages(parentId), args as HistoryArgs) };
			},
		});

		ctx.tools.register(DISPATCH_TASK);
		ctx.tools.register(CONTROL_MAIN);

		/** 卡片开过的会话：从会话列表里认，重开窗口也认得出来。 */
		async function startedFrom(sideId: string, callId: string): Promise<string | undefined> {
			const parentId = sides.get(sideId);
			if (!parentId) return undefined;
			return (await ctx.sessions.list()).find((summary) => summary.spawnedFrom?.sessionId === parentId && summary.spawnedFrom.toolCallId === callId)?.id;
		}
		/** 两次点得太快时只开一个。 */
		const launching = new Map<string, Promise<string>>();

		ctx.commands.provide({
			// 侧边聊天里敲 `/btw` 没有意义（它就在侧边聊天里），不列。
			list: ({ sessionId }) => {
				if (sessionId && sides.has(sessionId)) return [];
				const text = MESSAGES[ctx.locale()];
				return [{ name: "btw", description: text.btw, argumentHint: text.btwHint }];
			},
			async expand(_name, rest, context) {
				const parentId = context.sessionId;
				if (!parentId || sides.has(parentId)) throw new Error(MESSAGES[ctx.locale()].btwNoSession);
				// 只打 `/btw`：只开面板。带了话：开一个新的问它，面板新开一格接上。
				if (!rest) return { handled: true, openPanel: "chat" };
				const sideId = await open(parentId);
				void ctx.sessions.send(sideId, rest).catch((error: unknown) => ctx.notice(parentId, error instanceof Error ? error.message : String(error), "error"));
				return { handled: true, openPanel: "chat" };
			},
		});

		ctx.serve({
			bind: (tab: string, parentId: string) => bindings.bind(String(tab), String(parentId)),
			open: (tab: string, parentId: string) => bindings.open(String(tab), String(parentId)),
			ask: (sideId: string, message: string | SessionMessage) => ask(sideOf(String(sideId)), bodyOf(message)),
			async steer(sideId: string, message: string | SessionMessage) {
				const side = sideOf(String(sideId));
				const body = bodyOf(message);
				if (!(await ctx.sessions.get(side))?.running) return ask(side, body);
				// 先记下再交：模型读得快的话，读到时这里已经认得它。
				const id = waiting.steered(side, body, (await ctx.sessions.messages(side)).length);
				try {
					await ctx.sessions.steer(side, body);
				} catch {
					// 这一轮已经收场或在收尾，插不进去了：排到后面，收场后接着发。
					waiting.unsteer(side, id);
					if (!(await ctx.sessions.get(side))?.running) await drain(side);
				}
			},
			async queue(sideId: string, message: string | SessionMessage) {
				const side = sideOf(String(sideId));
				const body = bodyOf(message);
				if (!(await ctx.sessions.get(side))?.running) return ask(side, body);
				waiting.queue(side, body);
			},
			waiting: async (sideId: string) => waiting.list(String(sideId)),
			unqueue: async (sideId: string, id: string) => waiting.take(String(sideId), String(id))?.words,
			async sendNow(sideId: string, id: string) {
				const side = sideOf(String(sideId));
				const taken = waiting.take(side, String(id));
				if (!taken) return;
				if ((await ctx.sessions.get(side))?.running) {
					waiting.requeue(side, { id: String(id), message: taken.message });
					return;
				}
				try {
					await start(side, taken.message);
				} catch (error) {
					waiting.requeue(side, { id: String(id), message: taken.message });
					throw error;
				}
			},
			firstTab: (parentId: string) => bindings.first(String(parentId)),
			stop(sideId: string) {
				ctx.sessions.stop(sideOf(String(sideId)));
			},
			close: (tab: string) => bindings.close(String(tab)),
			started: (sideId: string, callId: string) => startedFrom(String(sideId), String(callId)),
			launch(sideId: string, callId: string, choice: LaunchChoice) {
				const key = `${String(sideId)}:${String(callId)}`;
				const pending =
					launching.get(key) ??
					(async () => {
						const side = sideOf(String(sideId));
						const already = await startedFrom(side, String(callId));
						if (already) return already;
						const parentId = sides.get(side)!;
						const result = (await ctx.sessions.messages(side)).find((message) => message.role === "toolResult" && message.toolCallId === callId);
						const details = result?.role === "toolResult" ? result.details : undefined;
						if (!isDispatchSuggestion(details)) throw new Error(MESSAGES[ctx.locale()].dispatchGone);
						const parent = await ctx.sessions.get(parentId);
						if (!parent) throw new Error(MESSAGES[ctx.locale()].missing);
						// 开在主会话的项目里；不在项目里的聊天开在它的目录里。新会话看不到侧边聊天，第一句就是那条自成一体的指令。
						const { session } = await ctx.sessions.launch({
							...(parent.project ? { project: parent.project } : { cwd: parent.cwd }),
							message: details.instruction,
							title: details.title,
							// 卡上没动过就不给，用默认模型、默认推理强度；认不认得由宿主核。
							...(choice.model ? { model: choice.model } : {}),
							...(choice.thinking ? { thinking: choice.thinking } : {}),
							spawnedFrom: { sessionId: parentId, toolCallId: String(callId) },
						});
						return session.id;
					})().finally(() => launching.delete(key));
				launching.set(key, pending);
				return pending;
			},
		} satisfies SideChatApi);
	},
} satisfies Plugin;
