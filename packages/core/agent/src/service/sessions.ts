import { randomUUID } from "node:crypto";
import { isImageModel } from "@plume/llm/image-models";
import { THINKING_LEVELS } from "@plume/llm/thinking-options";
import type { AgentService, Log, SessionSummary, SessionView } from "@plume/contract";
import { contextBreakdown, historyFor, keptRecord, marks, RepetitionWatch, rewrittenAt, runsOf } from "@plume/loop";
import type { PluginHost } from "../host.ts";
import { text } from "../i18n.ts";
import type { ModelSettings } from "../model-settings.ts";
import { lookup, resolveModel } from "../models.ts";
import { projectLayerView } from "../project-config.ts";
import type { Projects } from "../projects.ts";
import type { SessionDb } from "../session-db.ts";
import { sessionTrees, storageUse, withinRange } from "../storage.ts";
import type { Events } from "../session/events.ts";
import type { Governance } from "../session/governance.ts";
import type { Idle } from "../session/idle.ts";
import type { Lifecycle } from "../session/lifecycle.ts";
import type { Queueing } from "../session/queueing.ts";
import type { Registry } from "../session/registry.ts";

export interface SessionsServiceDeps {
	log: Log;
	modelSettings: Pick<ModelSettings, "read" | "change">;
	projects: Pick<Projects, "list" | "find" | "save">;
	store: Pick<SessionDb, "stats" | "spendOf" | "sizes" | "copy">;
	host: Pick<PluginHost, "sessionContextReset" | "status">;
	events: Pick<Events, "emit">;
	registry: Pick<
		Registry,
		"sessions" | "summaries" | "find" | "modelOf" | "withChildren" | "readMessages" | "messagesOf" | "readRecord" | "recordOf" | "saveSummary"
	>;
	governance: Pick<Governance, "refreshProject" | "readSessionSettings">;
	idle: Pick<Idle, "backgroundCallsField">;
	lifecycle: Pick<Lifecycle, "createPlain" | "deleteTree" | "archive" | "moveSession">;
	queueing: Pick<Queueing, "handedOf" | "queues">;
}

export function sessionsService(
	deps: SessionsServiceDeps,
): Pick<
	AgentService,
	| "projectLayer"
	| "setPermissionMode"
	| "setSessionModel"
	| "setSessionThinking"
	| "reorderProjectSessions"
	| "sessionStats"
	| "listSessions"
	| "createSession"
	| "getSession"
	| "deleteSession"
	| "renameSession"
	| "setSessionArchived"
	| "revokeSteward"
	| "setSessionManager"
	| "setSessionPinned"
	| "setSessionUnread"
	| "moveSessionProject"
	| "deleteArchivedSessions"
	| "contextBreakdown"
	| "storageUse"
	| "clearSessions"
	| "forkSession"
> {
	const {
		log,
		modelSettings,
		projects,
		store,
		host,
		events: { emit },
		registry: { sessions, summaries, find, modelOf, withChildren, readMessages, messagesOf, readRecord, recordOf, saveSummary },
		governance: { refreshProject, readSessionSettings },
		idle: { backgroundCallsField },
		lifecycle: { createPlain, deleteTree, archive, moveSession },
		queueing: { handedOf, queues },
	} = deps;
	return {
		async projectLayer(cwd) {
			// 人在设置页看这份项目配置时，同一目录里读过它的会话也重读一次：文件改过以后，输入框的权限签和这张卡说的是同一份。
			for (const session of sessions.values()) if (session.projectLayer && session.summary.cwd === cwd) refreshProject(session);
			return projectLayerView(await modelSettings.read(), cwd);
		},
		async setPermissionMode(mode) {
			if (mode !== "ask" && mode !== "auto" && mode !== "full") throw new Error(text("permission.unknown", { mode: String(mode) }));
			await modelSettings.change((settings) => {
				settings.permissionMode = mode;
			});
			// 项目配置里哪一档算收紧是和本机比的（`withoutLoosening`）：本机换了档，读过项目配置的会话重新比一次。
			for (const session of sessions.values()) if (session.projectLayer) refreshProject(session);
		},
		async setSessionModel(sessionId, model) {
			const session = find(sessionId);
			const previous = session.summary.model;
			if (model === undefined) delete session.summary.model;
			else {
				const found = lookup(await modelSettings.read(), model);
				if (!found) throw new Error(text("model.unavailable", { model }));
				if (isImageModel(found.model)) throw new Error(text("model.imageNotChat", { model: found.model.name }));
				session.summary.model = model;
			}
			saveSummary(session);
			if (previous === model) return;
			for (const id of withChildren(sessionId)) host.sessionContextReset(id);
			if (session.switching?.size) {
				// 正在等的那个请求放手，换成这一个重发（`StreamTurn.onSwitch`）。认不出就不放：留着旧的总比没人接强。
				const next = await readSessionSettings(session)
					.then((settings) => resolveModel(settings, modelOf(session)).model)
					.catch(() => undefined);
				if (next) for (const listener of session.switching ?? []) listener({ id: next.id, name: next.name });
			}
		},
		async setSessionThinking(sessionId, thinking) {
			const session = find(sessionId);
			if (thinking === undefined) delete session.summary.thinking;
			else {
				if (!THINKING_LEVELS.includes(thinking)) throw new Error(text("thinking.unknown", { level: String(thinking) }));
				session.summary.thinking = thinking;
			}
			saveSummary(session);
		},
		async reorderProjectSessions(projectId, sessionIds) {
			projects.find(projectId);
			if (
				!Array.isArray(sessionIds) ||
				new Set(sessionIds).size !== sessionIds.length ||
				sessionIds.some((id) => {
					const session = sessions.get(id)?.summary;
					return !session || session.project !== projectId || session.parentId || session.pinned || session.archived;
				})
			)
				throw new Error("Invalid session order");
			/*
			 * 置顶、归档的会话不在拖动的那份名单里，名次照旧留着：插回旧顺序里它前面那一个之后。不留的话取消置顶、取消归档后
			 * 它没有名次，跳到最前面。已经不在这个项目里的（删了、挪走了）顺手丢掉。
			 */
			const previous = projects.list().find((entry) => entry.id === projectId)?.sessionOrder ?? [];
			const order = [...sessionIds];
			previous.forEach((id, index) => {
				if (order.includes(id) || sessions.get(id)?.summary.project !== projectId) return;
				const before = previous.slice(0, index).findLast((other) => order.includes(other));
				order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
			});
			await projects.save(projects.list().map((entry) => (entry.id === projectId ? { ...entry, sessionOrder: order } : entry)));
		},
		async sessionStats(sessionId) {
			find(sessionId);
			return {
				...store.stats(sessionId),
				children: withChildren(sessionId)
					.slice(1)
					.map((id) => ({ owner: sessions.get(id)?.summary.owner, usage: store.spendOf(id) })),
			};
		},
		listSessions: () => summaries(),
		createSession: (target) => createPlain(target),
		async getSession(sessionId): Promise<SessionView> {
			const session = find(sessionId);
			// 打开会话时读一次它的项目配置，权限签一打开就是这个会话实际按的那一档（重开应用后还没跑过一轮的会话也是）。
			await readSessionSettings(session).catch(() => undefined);
			const record = readRecord(session);
			return {
				summary: session.summary,
				messages: readMessages(session),
				draft: session.draft,
				approval: session.approvals?.[0]?.request,
				...((session.approvals?.length ?? 0) > 1 ? { queuedApprovals: session.approvals!.length - 1 } : {}),
				progress: Object.fromEntries(session.progress),
				startedAt: Object.fromEntries(session.startedAt),
				hiccups: session.hiccups,
				compactions: marks(record),
				compacting: session.compacting === true,
				queue: queues.list(session.summary.id),
				compactionRuns: runsOf(record),
				...(session.summary.parentId ? { tasks: handedOf(session.summary.id) } : {}),
				...backgroundCallsField(session.summary.id),
			};
		},
		async deleteSession(sessionId) {
			deleteTree([find(sessionId).summary.id]);
		},
		async renameSession(sessionId, title) {
			const session = find(sessionId);
			if (typeof title !== "string" || !title.trim()) throw new Error(text("session.emptyTitle"));
			session.summary.title = title.trim();
			session.summary.titleEdited = true;
			saveSummary(session);
		},
		async setSessionArchived(sessionId, archived) {
			archive(find(sessionId), archived);
		},
		async revokeSteward(sessionId) {
			const session = find(sessionId);
			const plugin = session.summary.steward;
			if (!plugin) return;
			delete session.summary.steward;
			saveSummary(session);
			// 它转进来、还没轮到的几条一起拿掉：停止代管是不要它再往这里说话，排着的也是它说的。
			queues.remove(session.summary.id, (entry) => entry.origin === "plugin" && entry.fromPlugin === plugin);
			log("agent", "info", `会话 ${session.summary.id} 停止由插件 ${plugin} 代管`);
		},
		async setSessionManager(plugin) {
			const next = plugin === null ? undefined : String(plugin);
			if (next !== undefined && !host.status().some((status) => status.name === next && status.manage === "sessions"))
				throw new Error(text("session.cannotManage", { plugin: next }));
			const previous = await modelSettings.change((settings) => {
				const before = settings.sessionManager;
				if (next === undefined) delete settings.sessionManager;
				else settings.sessionManager = next;
				return before;
			});
			if (previous === next) return;
			// 收回、换人同停止代管：原来那个转进它管着的会话、还没轮到的几条一起拿掉。它自己代管的会话不归这份授权，不动。
			if (previous !== undefined)
				for (const session of sessions.values())
					if (session.summary.kind === "top" && session.summary.steward === undefined)
						queues.remove(session.summary.id, (entry) => entry.origin === "plugin" && entry.fromPlugin === previous);
			log("agent", "info", next === undefined ? `收回插件 ${previous} 管理会话的授权` : `把会话交给插件 ${next} 管理`);
		},
		async setSessionPinned(sessionId, pinned) {
			const session = find(sessionId);
			if (pinned) session.summary.pinned = true;
			else delete session.summary.pinned;
			saveSummary(session);
		},
		async setSessionUnread(sessionId, unread) {
			const session = find(sessionId);
			if (unread) session.summary.unread = true;
			else delete session.summary.unread;
			saveSummary(session);
		},
		async moveSessionProject(sessionId, projectId) {
			const session = find(sessionId);
			const project = projectId === undefined ? undefined : projects.find(projectId);
			moveSession(session, project, project?.path ?? session.summary.cwd);
		},
		/** 归档的全删，正在跑的（自己或子会话）一样：`deleteTree` 先停下再删。 */
		async deleteArchivedSessions() {
			const archived = summaries()
				.filter((summary) => summary.archived)
				.map((summary) => summary.id);
			deleteTree(archived);
			return archived.length;
		},
		async contextBreakdown(sessionId) {
			const session = find(sessionId);
			const record = readRecord(session);
			if (!record.estimate) return null;
			const { model } = resolveModel(await readSessionSettings(session), modelOf(session));
			const messages = readMessages(session);
			return contextBreakdown(record.estimate, historyFor(messages, record), model.contextWindow, rewrittenAt(record, messages));
		},
		async storageUse() {
			return storageUse(summaries(), store.sizes());
		},
		async clearSessions(range) {
			// 先量再删：删完记录就不在了，再量得到的是 0。
			// 只挑顶层会话，子会话跟着它删（`deleteTree`），释放量也连着它们算。
			const matched = sessionTrees(summaries(), store.sizes()).filter(({ summary }) => withinRange(summary, range));
			const bytes = new Map(matched.map(({ summary, bytes: size }) => [summary.id, size]));
			// 正在跑的也删：`deleteTree` 先停下它和它的子会话。
			deleteTree([...bytes.keys()]);
			return { removed: bytes.size, freed: [...bytes.values()].reduce((sum, size) => sum + size, 0) };
		},
		async forkSession(sessionId, index, timestamp, title) {
			const source = find(sessionId);
			if (source.summary.owner) throw new Error(text("session.pluginOwned", { plugin: source.summary.owner }));
			if (typeof title !== "string" || !title.trim()) throw new Error(text("session.emptyTitle"));
			const messages = await messagesOf(source);
			// 界面上的序号可能落后一步（这期间会话变了），按时间戳认回那一条。
			const at = messages[index]?.timestamp === timestamp ? index : messages.findIndex((message) => message.timestamp === timestamp);
			const message = messages[at];
			// 人的话：新会话停在它之前。回复：只认一轮里落定的那句，停在工具调用上的分出去会以一个没有结果的调用结尾。
			const keep = message?.role === "user" && !message.synthetic ? at : message?.role === "assistant" && message.stopReason !== "toolUse" ? at + 1 : -1;
			if (keep < 0) throw new Error(text("session.badMessage"));
			const kept = structuredClone(messages.slice(0, keep));
			const record = keptRecord(await recordOf(source), kept);
			const now = Date.now();
			const { cwd, project, model, thinking } = source.summary;
			const summary: SessionSummary = {
				id: randomUUID(),
				title: title.trim(),
				cwd,
				...(project ? { project } : {}),
				...(model ? { model } : {}),
				...(thinking ? { thinking } : {}),
				createdAt: now,
				updatedAt: now,
				running: false,
				forkedFrom: { sessionId },
				messageCount: kept.length,
				kind: "top",
			};
			store.copy(summary, kept, record);
			sessions.set(summary.id, { summary, messages: kept, record, progress: new Map(), startedAt: new Map(), hiccups: [], repetition: new RepetitionWatch() });
			emit({ type: "sessions", sessions: summaries() });
			return summary;
		},
	};
}
