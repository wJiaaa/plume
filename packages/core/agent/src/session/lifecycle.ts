import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentEvent, AgentService, Log, Message, SessionAccess, SessionSummary, SessionTarget } from "@plume/contract";
import { isImageModel } from "@plume/llm/image-models";
import { THINKING_LEVELS } from "@plume/llm/thinking-options";
import { errorText, kindOf, RepetitionWatch, type ContextRecord } from "@plume/loop";
import type { BackgroundRuns } from "../background.ts";
import type { ChildTasks } from "../child-tasks.ts";
import type { PluginHost } from "../host.ts";
import { text } from "../i18n.ts";
import type { BackgroundJobs } from "../jobs.ts";
import { removeImages } from "../media.ts";
import type { ModelSettings } from "../model-settings.ts";
import { DEFAULT_THINKING, lookup } from "../models.ts";
import { layerProjectSettings } from "../project-config.ts";
import type { Projects } from "../projects.ts";
import type { SessionQueues } from "../queue.ts";
import type { SessionDb } from "../session-db.ts";
import type { SessionWakeups } from "../wakeups.ts";
import type { Session } from "./session.ts";

type ProjectConfig = Awaited<ReturnType<typeof layerProjectSettings>>;

export interface LifecycleDeps {
	chatsDir: string;
	mediaDir: string;
	/** 回边：项目列表在生命周期模块之后创建，在 `createAgent` 里接上。 */
	projects: Pick<Projects, "find">;
	modelSettings: Pick<ModelSettings, "read">;
	store: Pick<SessionDb, "copy" | "create" | "delete" | "saveSummary">;
	sessions: Map<string, Session>;
	applyProjectConfig(session: Session, configured: ProjectConfig): void;
	emit(event: AgentEvent): void;
	summaries(): SessionSummary[];
	withChildren(sessionId: string): string[];
	find(sessionId: string): Session;
	saveSummary(session: Session): void;
	refreshProject(session: Session): void;
	scratchDir(sessionId: string): string;
	shownBackgroundCalls: Map<string, string>;
	idleWaiters: Map<string, Array<() => void>>;
	quitting(): boolean;
	/** 回边：后台运行在生命周期模块之后创建，在 `createAgent` 里接上。 */
	background: Pick<BackgroundRuns, "cancelSession">;
	/** 回边：后台任务在生命周期模块之后创建，在 `createAgent` 里接上。 */
	jobs: Pick<BackgroundJobs, "forget" | "stopRunning">;
	/** 回边：唤醒管理在生命周期模块之后创建，在 `createAgent` 里接上。 */
	wakeups: Pick<SessionWakeups, "forget" | "cancelSession">;
	/** 回边：插件宿主后建，在 `createAgent` 里接上。 */
	host: Pick<PluginHost, "sessionEnded" | "sessionDeleted" | "sessionArchived" | "sessionStopped" | "sessionContextReset">;
	/** 回边：队列模块后建，在 `createAgent` 里接上。 */
	queues: Pick<SessionQueues, "forget">;
	/** 回边：队列模块的子任务状态后建，在 `createAgent` 里接上。 */
	handed: Pick<ChildTasks, "forget">;
	/** 回边：占用模块后建，在 `createAgent` 里接上。 */
	held(session: Session): boolean;
	/** 回边：服务对象后建，在 `createAgent` 里接上。 */
	service: Pick<AgentService, "setSessionModel" | "setSessionThinking">;
	log: Log;
}

export interface Lifecycle {
	createPlain(
		target: SessionTarget,
		extra?: Partial<Pick<SessionSummary, "title" | "model" | "thinking" | "spawnedFrom" | "owner" | "steward">>,
		history?: { messages: Message[]; record: ContextRecord },
	): Promise<SessionSummary>;
	deleteTree(sessionIds: string[]): void;
	archive(session: Session, archived: boolean): void;
	stopSession(session: Session): void;
	runnableParent(session: Session): Session;
	owned(owner: string, sessionId: string): Session;
	relocate(session: Session, cwd: string): Promise<void>;
	existingCwd(options: { project?: unknown; cwd?: unknown } | undefined): Promise<string | undefined>;
	checkChoice(options: { model?: string; thinking?: SessionSummary["thinking"] } | undefined): Promise<void>;
	moveSession(session: Session, project: { id: string } | undefined, cwd: string): void;
	configureOwn(owner: string, sessionId: string, change: Parameters<SessionAccess["configure"]>[1]): Promise<SessionSummary>;
	createStandalone(owner: string, options: Parameters<SessionAccess["create"]>[0] | undefined): Promise<SessionSummary>;
	createChild(owner: string, options: Parameters<SessionAccess["create"]>[0] | undefined): Promise<SessionSummary>;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
	const {
		chatsDir,
		mediaDir,
		projects,
		modelSettings,
		store,
		sessions,
		applyProjectConfig,
		emit,
		summaries,
		withChildren,
		find,
		saveSummary,
		refreshProject,
		scratchDir,
		shownBackgroundCalls,
		idleWaiters,
		quitting,
		background,
		jobs,
		wakeups,
		host,
		queues,
		handed,
		held,
		service,
		log,
	} = deps;

	/**
	 * 不挂在别的会话下的会话：人在侧栏新建的，插件经 `ctx.sessions.launch` 开的（`extra` 带上它给的标题、模型、来处、代管插件），
	 * 和插件经 `ctx.sessions.create` 建的独立会话（`extra` 带上 `owner`，见 `createStandalone`）。
	 */
	async function createPlain(
		target: SessionTarget,
		extra: Partial<Pick<SessionSummary, "title" | "model" | "thinking" | "spawnedFrom" | "owner" | "steward">> = {},
		history?: { messages: Message[]; record: ContextRecord },
	): Promise<SessionSummary> {
		const project = target.project ? projects.find(target.project) : undefined;
		let cwd = project?.path ?? target.cwd?.trim();
		if (cwd === "") throw new Error(text("session.emptyCwd"));
		if (cwd === undefined) {
			await mkdir(chatsDir, { recursive: true });
			cwd = chatsDir;
		}
		const now = Date.now();
		// 新会话记下此刻的默认档位：之后改设置里的默认，已有的会话不跟着变。
		const configured = await layerProjectSettings(await modelSettings.read(), cwd);
		const thinking = configured.settings.thinking ?? DEFAULT_THINKING;
		const summary: SessionSummary = {
			id: randomUUID(),
			title: "",
			cwd,
			...(project ? { project: project.id } : {}),
			createdAt: now,
			updatedAt: now,
			running: false,
			thinking,
			messageCount: history?.messages.length ?? 0,
			...extra,
			kind: kindOf(extra),
		};
		if (history) store.copy(summary, history.messages, history.record);
		else store.create(summary);
		const session: Session = {
			summary,
			messages: history?.messages ?? [],
			...(history ? { record: history.record } : {}),
			progress: new Map(),
			startedAt: new Map(),
			hiccups: [],
			repetition: new RepetitionWatch(),
		};
		sessions.set(summary.id, session);
		applyProjectConfig(session, configured);
		emit({ type: "sessions", sessions: summaries() });
		return summary;
	}

	/** 删掉这几个会话和它们的子会话：正在跑的先停下。停下的那一轮之后还会写几条，库里已经没有这个会话，那些写入什么都不做。 */
	function deleteTree(sessionIds: string[]): void {
		const ids = [...new Set(sessionIds.flatMap(withChildren))].filter((id) => sessions.has(id));
		for (const id of ids) {
			background.cancelSession(id, "closed");
			jobs.forget(id);
			wakeups.forget(id);
			const session = sessions.get(id)!;
			session.stopped = true;
			session.steering = [];
			session.controller?.abort();
			sessions.delete(id);
			shownBackgroundCalls.delete(id);
			void host.sessionEnded(id, "deleted");
			// 插件按会话记的东西（读过的文件之类）跟着清掉。
			host.sessionDeleted(id);
		}
		// 没有会话再用的图连文件、缩略图一起删；删不掉的下次启动再清。
		const released = store.delete(ids);
		void removeImages(mediaDir, released).catch((error: unknown) => log("agent", "warn", `删不掉没人用的图：${errorText(error)}`));
		queues.forget(ids);
		handed.forget(ids);
		// 等它闲下来的人不用再等了：它不在了。
		for (const id of ids) for (const resolve of idleWaiters.get(id) ?? []) resolve();
		for (const id of ids) idleWaiters.delete(id);
		// 草稿只为那次对话而写，跟着会话一起走；删不掉只记日志，不挡删除本身。
		for (const id of ids)
			void rm(scratchDir(id), { recursive: true, force: true }).catch((error: unknown) =>
				log("agent", "warn", `删不掉会话 ${id} 的临时目录：${errorText(error)}`),
			);
		emit({ type: "sessions", sessions: summaries() });
	}

	/**
	 * 归档、取消归档：人点的和插件经 `ctx.sessions.setArchived` 的都走这里，状态变了才告诉插件。
	 * 归档就是这个会话收工了：它和子会话约的唤醒取消、还在跑的后台任务停掉（记录留着），不在人看不见的地方接着跑、接着叫醒它。
	 * 环境卡片因此不另放「全部停止」：要一次清掉，归档、删会话或退出应用。取消归档不恢复，要用再让 agent 起。
	 */
	function archive(session: Session, archived: boolean): void {
		const changed = (session.summary.archived === true) !== archived;
		if (archived) session.summary.archived = true;
		else delete session.summary.archived;
		saveSummary(session);
		if (changed) host.sessionArchived(session.summary.id, archived);
		if (changed && archived)
			for (const id of withChildren(session.summary.id)) {
				wakeups.cancelSession(id);
				jobs.stopRunning(id);
				/*
				 * 归档就是收工：攒着、留着的信按「不在了」结掉（发信方的回执有个着落，不再等一个不会读它的会话），交回的汇报丢掉，
				 * 派出去的后台运行停掉、它们的结果不再送来。不收干净的话，凑批窗口里的信、跑完的子 Agent 都会把一个侧栏里看不到的
				 * 会话叫起来接着花钱。在跑的那一轮照旧做完（归档不停它），之后也不再被叫醒，见 `wakeReports`。
				 */
				background.cancelSession(id, "closed");
				void host.sessionEnded(id, "archived");
			}
	}

	/** 明确停止同时撤掉派发和待送达；正常结束和打断换轮不走这里。 */
	function stopSession(session: Session): void {
		session.stopped = true;
		session.steering = [];
		// 只连带取消登记过的后台运行；独立 send 的侧边聊天不属于父任务。
		background.cancelSession(session.summary.id);
		/*
		 * 约好的唤醒一起取消（续跑是模型的决定，按停就是收回它），取消了就说一声：那是模型说过「过一会儿再看」的事，
		 * 悄悄没了，人会一直等。后台任务不停（渠道作废了，它们再结束也叫不醒会话），停不停归起它的工具。
		 */
		const cancelled = wakeups.cancelSession(session.summary.id);
		if (cancelled > 0)
			emit({
				type: "notice",
				sessionId: session.summary.id,
				text: text(cancelled === 1 ? "session.wakeupCancelled" : "session.wakeupsCancelled", { n: cancelled }),
			});
		session.controller?.abort();
		host.sessionStopped(session.summary.id);
	}

	function runnableParent(session: Session): Session {
		if (!session.summary.parentId) throw new Error(text("session.notChild"));
		const parent = find(session.summary.parentId);
		if (quitting() || parent.stopped || parent.controller?.signal.aborted) throw new Error(text("session.parentStopped"));
		return parent;
	}

	/** 插件动一个子会话：只能是它自己建的。 */
	function owned(owner: string, sessionId: string): Session {
		const session = find(String(sessionId));
		if (session.summary.owner !== owner) throw new Error(text("session.notOwned", { id: session.summary.id, plugin: owner }));
		return session;
	}

	/**
	 * 钩子 prompt.submit 让这个会话换个目录跑（工作树插件给对话开了自己的检出），子会话跟着。只在一轮开头、写进这条消息之前换：
	 * 这一轮的工具、提示词都现读 `summary.cwd`，从头到尾在新目录里。子会话的目录随父会话，自己不换；插件的独立会话不是人的对话，不换；不是已有目录就不换。
	 */
	async function relocate(session: Session, cwd: string): Promise<void> {
		if (session.summary.kind !== "top" || cwd === session.summary.cwd) return;
		const isDirectory =
			isAbsolute(cwd) &&
			(await stat(cwd).then(
				(entry) => entry.isDirectory(),
				() => false,
			));
		if (!isDirectory) {
			log("agent", "error", `会话 ${session.summary.id} 没换目录：prompt.submit 给的 ${cwd} 不是已有目录的绝对路径`);
			return;
		}
		for (const id of withChildren(session.summary.id)) {
			const each = sessions.get(id);
			if (!each) continue;
			each.summary.cwd = cwd;
			delete each.projectLayer;
			delete each.projectNotices;
			host.sessionContextReset(each.summary.id);
			store.saveSummary(each.summary);
		}
		emit({ type: "sessions", sessions: summaries() });
	}

	/** 插件给的工作目录（`launch`、独立会话）：给了项目就不看它；要是已有目录的绝对路径，插件给的路径没人看过，错了当场说清楚。 */
	async function existingCwd(options: { project?: unknown; cwd?: unknown } | undefined): Promise<string | undefined> {
		const cwd = options?.project ? undefined : typeof options?.cwd === "string" && options.cwd.trim() ? options.cwd.trim() : undefined;
		if (cwd === undefined) return undefined;
		const isDirectory =
			isAbsolute(cwd) &&
			(await stat(cwd).then(
				(entry) => entry.isDirectory(),
				() => false,
			));
		if (!isDirectory) throw new Error(text("session.badCwd", { cwd }));
		return cwd;
	}

	/** 插件建子会话、独立会话时给的模型和思考档位：不认识就当场抛错。 */
	async function checkChoice(options: { model?: string; thinking?: SessionSummary["thinking"] } | undefined): Promise<void> {
		if (options?.model !== undefined && !lookup(await modelSettings.read(), options.model))
			throw new Error(text("model.unavailable", { model: options.model }));
		if (options?.thinking !== undefined && !THINKING_LEVELS.includes(options.thinking))
			throw new Error(text("thinking.unknown", { level: String(options.thinking) }));
	}

	/**
	 * 把会话（连同它的子会话）换到项目 `project`（没有就是不属于项目）、目录 `cwd` 里：人在侧栏换项目，插件换自己独立会话的目录。
	 * 正在跑时不换：子会话的工具目录随父会话，检查和更新之间不让一轮插进来。
	 */
	function moveSession(session: Session, project: { id: string } | undefined, cwd: string): void {
		const family = withChildren(session.summary.id).map(find);
		if (family.some(held)) throw new Error(text("session.running"));
		for (const each of family) {
			// 目录换了，在旧目录里的这一段就结束了；下一轮在新目录里重新开始。
			if (cwd !== each.summary.cwd) void host.sessionEnded(each.summary.id, "moved");
			each.summary.cwd = cwd;
			if (project) each.summary.project = project.id;
			else delete each.summary.project;
			delete each.projectLayer;
			delete each.projectNotices;
			store.saveSummary(each.summary);
			host.sessionContextReset(each.summary.id);
		}
		emit({ type: "sessions", sessions: summaries() });
		// 新目录里的项目配置可能定了另一档权限，不等下一轮，权限签现在就跟上。
		for (const each of family) refreshProject(each);
	}

	/**
	 * 插件改自己建的会话怎么跑（`SessionAccess.configure`）：先把要改的都核对一遍，有一项不对就什么都不改；
	 * 目录照人在侧栏换项目的路子（`moveSession`），模型、思考档位照人在输入框里换的路子。
	 */
	async function configureOwn(owner: string, sessionId: string, change: Parameters<SessionAccess["configure"]>[1]): Promise<SessionSummary> {
		const session = owned(owner, sessionId);
		const model = change?.model;
		if (typeof model === "string") {
			const found = lookup(await modelSettings.read(), model);
			if (!found) throw new Error(text("model.unavailable", { model }));
			if (isImageModel(found.model)) throw new Error(text("model.imageNotChat", { model: found.model.name }));
		}
		if (change?.thinking != null && !THINKING_LEVELS.includes(change.thinking)) throw new Error(text("thinking.unknown", { level: String(change.thinking) }));
		const moving = change?.project !== undefined || change?.cwd !== undefined;
		if (moving) {
			if (session.summary.kind !== "standalone") throw new Error(text("session.childCwd"));
			const project = change.project ? projects.find(String(change.project)) : undefined;
			let cwd = project?.path;
			if (!cwd && change.cwd === null) {
				await mkdir(chatsDir, { recursive: true });
				cwd = chatsDir;
			}
			cwd ??= await existingCwd({ cwd: change.cwd });
			if (!cwd) throw new Error(text("session.emptyCwd"));
			if (cwd !== session.summary.cwd || project?.id !== session.summary.project) moveSession(session, project, cwd);
		}
		if (model !== undefined) await service.setSessionModel(session.summary.id, model ?? undefined);
		if (change?.thinking !== undefined) await service.setSessionThinking(session.summary.id, change.thinking ?? undefined);
		return structuredClone(session.summary);
	}

	/**
	 * 插件的独立会话：不挂在任何会话下、记在插件名下（`owner`），给插件自己的页面当一直在的助手。
	 * 和顶层会话一样按项目、目录建（`createPlain`），但不进侧栏，后台结果、会话间的信、闲下来的通知都不碰它（见各处的 `owner`）。
	 */
	async function createStandalone(owner: string, options: Parameters<SessionAccess["create"]>[0] | undefined): Promise<SessionSummary> {
		if (quitting()) throw new Error(text("session.quitting"));
		await checkChoice(options);
		const cwd = await existingCwd(options);
		const title = typeof options?.title === "string" ? options.title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
		return createPlain(
			{ ...(options?.project ? { project: String(options.project) } : {}), ...(cwd ? { cwd } : {}) },
			{
				...(title ? { title } : {}),
				...(options?.model !== undefined ? { model: options.model } : {}),
				...(options?.thinking !== undefined ? { thinking: options.thinking } : {}),
				owner,
			},
		);
	}

	/**
	 * 插件建的子会话：工作目录、项目随父会话，模型跟着父会话（`modelOf`）。只挂一层：子会话下面不再挂，
	 * 侧边聊天、子 Agent 都只挂在用户的会话下面，删、停、列都不用递归。
	 */
	async function createChild(owner: string, options: Parameters<SessionAccess["create"]>[0] | undefined): Promise<SessionSummary> {
		if (options?.project !== undefined || options?.cwd !== undefined) throw new Error(text("session.childCwd"));
		await checkChoice(options);
		const parent = find(String(options?.parentId));
		if (parent.summary.kind !== "top") throw new Error(text("session.nestedChild"));
		const now = Date.now();
		const summary: SessionSummary = {
			id: randomUUID(),
			title: typeof options?.title === "string" ? options.title.trim().slice(0, 80) : "",
			cwd: parent.summary.cwd,
			...(parent.summary.project ? { project: parent.summary.project } : {}),
			createdAt: now,
			updatedAt: now,
			running: false,
			messageCount: 0,
			parentId: parent.summary.id,
			...(options?.model !== undefined ? { model: options.model } : {}),
			...(options?.thinking !== undefined ? { thinking: options.thinking } : {}),
			owner,
			kind: "child",
		};
		store.create(summary);
		sessions.set(summary.id, { summary, messages: [], progress: new Map(), startedAt: new Map(), hiccups: [], repetition: new RepetitionWatch() });
		emit({ type: "sessions", sessions: summaries() });
		return summary;
	}

	return {
		createPlain,
		deleteTree,
		archive,
		stopSession,
		runnableParent,
		owned,
		relocate,
		existingCwd,
		checkChoice,
		moveSession,
		configureOwn,
		createStandalone,
		createChild,
	};
}
