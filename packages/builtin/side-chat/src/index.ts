/**
 * 侧边聊天插件的逻辑入口。侧边聊天是挂在用户会话下面的子会话（`ctx.sessions.create`），所以记录、审批、事件、
 * 删父会话时一起删，都和普通会话一样；这里只管它和普通会话不一样的地方：
 *
 * - `prompt.submit`：每一问后面附上主会话上次之后的新内容（见 main-chat.ts），每一问读到哪里记在插件数据目录的 `marks.json`，
 *   编辑重问截掉的那几问一起作废；
 *   主会话的下一问后面附上侧边聊天这期间改过的文件（见 changes.ts），经 `file.changes` 认改动记录。
 * - `model.context`：身份、准则换成侧边聊天的，工具只留读主会话、交出去、控制主会话、读写文件、跑命令、查网页（见 profile.ts）。
 *   普通会话里藏起这三件侧边聊天专用的，`tool.execute` 再拦一次子 Agent 这类别的会话。
 * - `dispatch_task`、`control_main`（见 controls.ts）：经宿主给的父会话（`ToolRun.parent`）把活排进主会话、让它停下或接着做；
 *   人没点名交给主会话时只留一张卡片，人在卡上选交给主会话、开新会话（`launch`），还是就在这里做。
 * - `/btw 问题`：开一个新的侧边聊天问这句话，打开面板；主对话里什么都不留。
 * - 排队条上的「在侧边聊天中打开」（界面入口的 `ui.queueAction`）：那条排着的话拿到最早那段侧边聊天去问，附件跟着走。
 * - `ctx.serve`：面板列出、新开、提问、停止、关掉侧边聊天；设置 › 智能体里「侧边聊天默认模型」读写 `settings.json`；
 *   交出去的卡片上「开新会话」。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, Plugin, PromptSection, SessionMessage } from "@plume/contract";
import type { SessionChoice } from "@plume/contract/ui";
import type { SideChatApi } from "./api.ts";
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

export default {
	name: "plume.side-chat",
	inject: ["file.changes"],
	async apply(ctx) {
		const changes = ctx.use("file.changes");
		/** 侧边聊天 → 它挂在哪个会话旁边。 */
		const sides = new Map<string, string>();
		for (const summary of await ctx.sessions.list()) if (summary.owner === ctx.name && summary.parentId) sides.set(summary.id, summary.parentId);
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
		// 新的侧边聊天用哪个模型；没选就跟随主会话。只管新开的，已经开着的沿用它开时的模型。
		const settingsFile = join(ctx.dataDir, "settings.json");
		const saved = await readFile(settingsFile, "utf8").then(
			(text) => (JSON.parse(text) as { model?: unknown }).model,
			() => undefined,
		);
		let model = typeof saved === "string" ? saved : undefined;
		let writingSettings: Promise<void> = Promise.resolve();

		/** `choice`：人在面板里第一句之前选的模型和档位（只取这两样，不对时 `create` 抛错）；`/btw`、排队条新开的没有，用上面的默认。 */
		async function open(parentId: string, choice?: SessionChoice): Promise<string> {
			const picked = choice
				? { ...(choice.model ? { model: choice.model } : {}), ...(choice.thinking ? { thinking: choice.thinking } : {}) }
				: model
					? { model }
					: {};
			const side = await ctx.sessions.create({ parentId, ...picked });
			sides.set(side.id, parentId);
			noted.set(side.id, { seen: 0, lastAt: 0 });
			return side.id;
		}

		/** 这个主会话旁边的侧边聊天上次告诉它之后改过的文件，说过的往后挪；没有就是空的。 */
		async function sideChanges(parentId: string): Promise<string | undefined> {
			const summaries = new Map((await ctx.sessions.list()).map((summary) => [summary.id, summary]));
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
				const cwd = summaries.get(sideId)?.cwd;
				if (ids.length === 0 || !cwd) continue;
				// 改动记录读不出来（快照已清掉）时少说几个文件，不拦下主会话这一问。
				const summary = await changes.collect(sideId, cwd, ids).catch(() => undefined);
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
		ctx.sessions.onDeleted((sessionId) => {
			sides.delete(sessionId);
			noted.delete(sessionId);
			if (marks.delete(sessionId)) saveMarks();
			// i18n-exempt：插件数据写入失败的日志。
			void bindings.forget(sessionId).catch((error: unknown) => ctx.log.warn(`侧边聊天标签没存上：${String(error)}`));
		});

		function sideOf(sideId: string): string {
			if (!sides.has(sideId)) throw new Error(MESSAGES[ctx.locale()].missing);
			return sideId;
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
			list: () => {
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
			open: (tab: string, parentId: string, choice?: SessionChoice) => bindings.open(String(tab), String(parentId), choice),
			async ask(sideId: string, message: string | SessionMessage) {
				// 界面交来的只取正文、气泡上的字和附件：不能借这条路冒充派发方（`origin`）。
				const body: string | SessionMessage =
					typeof message === "string"
						? message
						: {
								content: message.content,
								...(message.displayText !== undefined ? { displayText: message.displayText } : {}),
								...(message.attachments ? { attachments: message.attachments } : {}),
								...(message.sessionRefs ? { sessionRefs: message.sessionRefs } : {}),
							};
				await ctx.sessions.send(sideOf(String(sideId)), body);
			},
			firstTab: (parentId: string) => bindings.first(String(parentId)),
			stop(sideId: string) {
				ctx.sessions.stop(sideOf(String(sideId)));
			},
			close: (tab: string) => bindings.close(String(tab)),
			model: async () => model,
			started: (sideId: string, callId: string) => startedFrom(String(sideId), String(callId)),
			launch(sideId: string, callId: string) {
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
							spawnedFrom: { sessionId: parentId, toolCallId: String(callId) },
						});
						return session.id;
					})().finally(() => launching.delete(key));
				launching.set(key, pending);
				return pending;
			},
			setModel(next: string | undefined) {
				const value = typeof next === "string" && next ? next : undefined;
				writingSettings = writingSettings
					.catch(() => undefined)
					.then(async () => {
						await writeFile(`${settingsFile}.tmp`, JSON.stringify(value ? { model: value } : {}, null, 2));
						await rename(`${settingsFile}.tmp`, settingsFile);
						model = value;
					});
				return writingSettings;
			},
		} satisfies SideChatApi);
	},
} satisfies Plugin;
