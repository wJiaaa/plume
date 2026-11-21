/** 产品本体：会话、模型调用、agent 循环和 AgentService。
 * 一轮的流程：用户消息写进会话 → 组上下文，经钩子 model.context → 调模型（流式草稿推给界面）→ 回复写进会话 → 有工具调用就逐个经钩子
 * tool.execute 执行（最里层先审批，再执行工具表里的工具）→ 结果写回 → 再调模型，直到模型不再调用工具。工具全是插件注册的（read、write、edit、bash
 * 这些是内置插件 plume.tools 的）；审批是本体的，见 tool-run.ts。 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RequestOptions } from "@plume/llm/types";
import type { AgentService, Locale, Log, PluginEntry, PluginStatus } from "@plume/contract";
import { errorText } from "@plume/loop";
import { ChangeStore } from "@plume/workspace";
import { BackgroundRuns } from "./background.ts";
import type { HostPages, PluginHost } from "./host.ts";
import { createHost } from "./host-wiring.ts";
import { setLocale, text } from "./i18n.ts";
import { jsonFiles } from "./json-files.ts";
import { BackgroundJobs } from "./jobs.ts";
import { sessionFilePath } from "./files.ts";
import { managedMediaPath } from "./media-access.ts";
import { removeImages, sweepImages } from "./media.ts";
import { loadCachedModelCatalog, MODEL_CATALOG_SYNC_INTERVAL_MS, syncModelCatalog } from "./model-catalog-sync.ts";
import { createModelSettings } from "./model-settings.ts";
import { DEFAULT_THINKING, lookup } from "./models.ts";
import { PluginProviderSources } from "./plugin-providers.ts";
import { layerProjectSettings } from "./project-config.ts";
import { projectRootsFor } from "./project-roots.ts";
import { openProjects } from "./projects.ts";
import { conversationService } from "./service/conversation.ts";
import { exportService } from "./service/export.ts";
import { filesService } from "./service/files.ts";
import { pluginsService } from "./service/plugins.ts";
import { sessionsService } from "./service/sessions.ts";
import { createApprovals } from "./session/approvals.ts";
import { createDispatch } from "./session/dispatch.ts";
import { createEvents } from "./session/events.ts";
import { createGovernance } from "./session/governance.ts";
import { createIdle } from "./session/idle.ts";
import { createLifecycle } from "./session/lifecycle.ts";
import { createMessages } from "./session/messages.ts";
import { createModelRequests } from "./session/model-requests.ts";
import { createOccupancy } from "./session/occupancy.ts";
import { createQueueing } from "./session/queueing.ts";
import { createRegistry } from "./session/registry.ts";
import { userMessage } from "./session/session.ts";
import { createSteward } from "./session/steward.ts";
import { createTurn } from "./session/turn.ts";
import { createWake } from "./session/wake.ts";
import { openSessionDb } from "./session-db.ts";
import { createVault, providerKeys } from "./vault.ts";
import { SessionWakeups } from "./wakeups.ts";
/** 退出应用时等插件收拾会话结束（`ctx.sessions.onEnded`）多久：人按了退出，过了这一会儿就不再等。 */
const SESSION_END_GRACE_MS = 2_000;
export interface AgentOptions {
	/** 会话、插件数据都在这里。 */
	dataDir: string;
	/** 模型设置存在这个 JSON 文件里；供应商的 API key 不在里面，加密存在 `dataDir` 的 `credentials.json`（见 `vault.ts`）。 */
	settingsFile: string;
	/** 按顺序加载。工具重名时后登记的生效。 */
	plugins: PluginEntry[];
	/** 随应用带的插件 SDK 的版本（和应用版本一致），插件加载失败时用来说明版本对不上，见 `PluginEntry.sdk`。 */
	sdkVersion?: string;
	log: Log;
	/** 启动时的界面语言，插件加载失败的原因用它写；之后界面经 setLocale 再告诉。默认中文。 */
	locale?: Locale;
	/** 模型目录的缓存文件。给了才在启动时读缓存、启动后拉一次 pi.dev、之后每小时一次；不给就只用打包的快照（测试和冒烟不访问外网，断言的目录值也不能随上游变）。 */
	catalogFile?: string;
	/** 模型请求的重试策略。不给用默认策略；测试给短间隔，免得一次重试等五秒。 */
	retryPolicy?: RequestOptions["retryPolicy"];
	/** 插件的 `ctx.pages`：网页在桌面应用的主进程里，由装配方转过去。不给时插件调用它报错。 */
	pages?: HostPages;
	/** 插件网络请求的系统实现，不影响模型调用的网络栈。 */
	fetch?: import("@plume/contract").PluginFetch;
	/** 系统废纸篓由桌面进程实现；无界面宿主没有时明确拒绝该操作。 */
	trash?: (path: string) => Promise<void>;
	/** 卡片没人答时等多久（毫秒）：`permission` 是审批（`askUser`），`question` 是 `run.request`（`requestUser`）。不给用 5 分钟和 30 分钟；测试给短的，免得真等。 */
	approvalTimeoutMs?: { permission?: number; question?: number };
}
export interface Agent {
	service: AgentService;
	host: PluginHost;
	/** 运行中装上一个插件（插件市场安装、更新后），并告诉界面。 */
	addPlugin(entry: PluginEntry): Promise<PluginStatus[]>;
	/** 运行中卸下一个插件（插件市场卸载、更新前），并告诉界面。 */
	removePlugin(key: string): Promise<PluginStatus[]>;
	/** 有会话在跑一轮（顶层、子会话、插件的独立会话、一轮之外的压缩都算），或有还没送达的后台运行。插件市场的自动更新等它为假再换插件。 */
	busy(): boolean;
	/** 会话工作目录里这个文件的真实路径，不在目录里、不是文件时是 null。主进程按它发图片、PDF、音视频。 */
	filePath(sessionId: string, path: string): Promise<string | null>;
	shutdown(): Promise<void>;
}
export async function createAgent(options: AgentOptions): Promise<Agent> {
	const { dataDir, settingsFile, catalogFile, log } = options;
	if (options.locale) setLocale(options.locale);
	// 模型目录：先换上缓存的那份，启动后拉一次，之后每小时一次；设置页也能手动更新。
	let catalogTimer: ReturnType<typeof setInterval> | undefined;
	if (catalogFile) {
		await loadCachedModelCatalog(catalogFile);
		const sync = () =>
			void syncModelCatalog(catalogFile).then((result) => {
				if (result.status === "failed") log("agent", "warn", `模型目录同步失败：${result.error ?? ""}`);
			});
		sync();
		catalogTimer = setInterval(sync, MODEL_CATALOG_SYNC_INTERVAL_MS);
		catalogTimer.unref();
	}
	const files = jsonFiles();
	const vault = createVault(dataDir);
	const events = createEvents({
		sessions: { get: (sessionId) => registry.sessions.get(sessionId) },
		host: { observe: (observation, concerned) => host.observe(observation, concerned), status: () => host.status(), toolOwners: () => host.toolOwners() },
		concerned: (session) => governance.concerned(session),
	});
	const { emit, observe } = events;
	const pluginProviders = new PluginProviderSources((message) => log("agent", "warn", message), events.modelsChanged);
	const modelSettings = createModelSettings({ files, keys: providerKeys(vault), settingsFile, catalogFile, pluginProviders });
	// 会话、消息、压缩记录都在这个库里，见 `session-db.ts`；打不开就启动失败，日志里有路径和原因。
	const store = openSessionDb(join(dataDir, "sessions", "sessions.db"), (message) => log("agent", "warn", message));
	const mediaDir = join(dataDir, "session-media");
	/** 不属于任何项目的聊天都开在这里：会话总得有个工作目录，又不该拿哪个项目的目录凑数。 */
	const chatsDir = join(dataDir, "workspaces", "general");
	const registry = createRegistry({
		...{ dataDir, store, emit },
		sessionContextReset: (sessionId) => host.sessionContextReset(sessionId),
		projectRoots: (cwd, project) => projectRootsFor(projects.list(), cwd, project),
	});
	const { sessions, scratchDir, lineageScratchDirs, summaries, saveSummary, find, modelOf, thinkingOf, withChildren, messagesOf, attachedPaths, recordOf } =
		registry;
	const governance = createGovernance({ modelSettings, hostStatus: () => host.status(), sessions, emit, summaries });
	const { governs, readSessionSettings } = governance;
	const idle = createIdle({
		...{ sessions, emit, summaries },
		background: { pending: (sessionId) => background.pending(sessionId), hasReady: (sessionId) => background.hasReady(sessionId) },
		jobs: { calls: (sessionId) => jobs.calls(sessionId), pending: (sessionId) => jobs.pending(sessionId) },
		wakeups: { cancelled: (sessionId) => wakeups.cancelled(sessionId) },
		queues: { list: (sessionId) => queues.list(sessionId) },
		held: (session) => held(session),
	});
	const { shownBackgroundCalls, idleWaiters, backgroundChanged, emitBackgroundCalls, parentStatus, syncBackground, waiting, checkIdle, whenIdle } = idle;
	const approvals = createApprovals({ approvalTimeoutMs: options.approvalTimeoutMs, modelSettings, emit, log });
	const messages = createMessages({
		...{ mediaDir, messagesOf },
		partsOf: (message) => modelRequests.partsOf(message),
		...{ store, emit, summaries, recordOf },
		background: {
			cancelCalls: (sessionId, toolCallIds) => background.cancelCalls(sessionId, toolCallIds),
			cancelRuns: (sessionId) => background.cancelRuns(sessionId),
		},
		wakeups: { cancelCalls: (sessionId, toolCallIds) => wakeups.cancelCalls(sessionId, toolCallIds) },
		host: {
			workspace: { revert: (sessionId, cwd, history, restore) => host.workspace.revert(sessionId, cwd, history, restore) },
			sessionContextReset: (sessionId) => host.sessionContextReset(sessionId),
		},
		held: (session) => held(session),
	});
	const { commit } = messages;
	const modelRequests = createModelRequests({
		...{ retryPolicy: options.retryPolicy, modelSettings, readSessionSettings, modelOf, thinkingOf },
		projects: { list: () => projects.list() },
		...{ scratchDir, messagesOf, recordOf },
		host: {
			run: (name, input, inner, runOptions) => host.run(name, input, inner, runOptions),
			toolSpecs: () => host.toolSpecs(),
			tool: (name) => host.tool(name),
		},
		...{ mediaDir, store, find, observe, emit },
		setDraft: (session, draft) => setDraft(session, draft),
		observeDraft: (session, id, draft) => observeDraft(session, id, draft),
		log,
	});
	let quitting = false;
	const lifecycle = createLifecycle({
		...{ chatsDir, mediaDir },
		projects: { find: (projectId) => projects.find(projectId) },
		...{ modelSettings, layerProjectSettings, DEFAULT_THINKING, lookup, text, removeImages, store, sessions },
		...{ applyProjectConfig: governance.applyProjectConfig, emit, summaries, withChildren, find, saveSummary, refreshProject: governance.refreshProject },
		...{ scratchDir, shownBackgroundCalls, idleWaiters },
		quitting: () => quitting,
		background: { cancelSession: (sessionId, fate) => background.cancelSession(sessionId, fate) },
		jobs: { forget: (sessionId) => jobs.forget(sessionId), stopRunning: (sessionId) => jobs.stopRunning(sessionId) },
		wakeups: { forget: (sessionId) => wakeups.forget(sessionId), cancelSession: (sessionId) => wakeups.cancelSession(sessionId) },
		host: {
			sessionEnded: (sessionId, reason) => host.sessionEnded(sessionId, reason),
			sessionDeleted: (sessionId) => host.sessionDeleted(sessionId),
			sessionArchived: (sessionId, archived) => host.sessionArchived(sessionId, archived),
			sessionStopped: (sessionId) => host.sessionStopped(sessionId),
			sessionContextReset: (sessionId) => host.sessionContextReset(sessionId),
		},
		queues: { forget: (sessionIds) => queues.forget(sessionIds) },
		handed: { forget: (sessionIds) => handed.forget(sessionIds) },
		held: (session) => held(session),
		service: {
			setSessionModel: (sessionId, model) => service.setSessionModel(sessionId, model),
			setSessionThinking: (sessionId, thinking) => service.setSessionThinking(sessionId, thinking),
		},
		log,
	});
	const background = new BackgroundRuns((parentId) => {
		const parent = sessions.get(parentId);
		if (parent) wake.wakeReports(parent);
	}, backgroundChanged);
	/** 工具登记的后台任务（`ToolRun.track`，在等结果的算进 `waiting`）和约好的唤醒（`ToolRun.schedule`，挂着的，不算）。 */
	const jobs = new BackgroundJobs(backgroundChanged, (message) => log("agent", "warn", message));
	const wakeups = new SessionWakeups(emitBackgroundCalls, (message) => log("agent", "warn", message));
	const { host, pluginsFile } = await createHost({
		...{ options, dataDir, mediaDir, log, files, modelSettings, pluginProviders, vault, store, background, jobs, wakeups },
		...{ events, registry, governance, idle, lifecycle, modelRequests },
		projects: { list: () => projects.list() },
		occupancy: { held: (session) => occupancy.held(session) },
		dispatch: {
			launchSession: (owner, launchOptions) => dispatch.launchSession(owner, launchOptions),
			reportBack: (owner, sessionId, words, reportOptions) => dispatch.reportBack(owner, sessionId, words, reportOptions),
			childMessage: (message) => dispatch.childMessage(message),
			sendChild: (session, message, signal) => dispatch.sendChild(session, message, signal),
		},
		steward: {
			postToSession: (plugin, sessionId, message) => steward.postToSession(plugin, sessionId, message),
			settleAsSteward: (plugin, sessionId, toolCallId, outcome) => steward.settleAsSteward(plugin, sessionId, toolCallId, outcome),
			stewarded: (plugin, sessionId) => steward.stewarded(plugin, sessionId),
		},
		turn: {
			compactNow: (sessionId, instructions) => turn.compactNow(sessionId, instructions),
			runTurn: (session, prompt, controller, pinModel) => turn.runTurn(session, prompt, controller, pinModel),
			active: () => turn.active(),
		},
	});
	// 删会话删到一半退出（或删的时候删不掉）留下的：没有会话用着的图、不在了的会话的临时目录和改动快照。
	// 在任何会话开跑、插件加载之前清：这时刚存下还没写进会话的图、刚记下的快照都还不会有。
	await sweepImages(mediaDir, store.mediaInUse()).catch((error: unknown) => log("agent", "warn", `清理没人用的图失败：${errorText(error)}`));
	await Promise.all(
		(await readdir(join(dataDir, "scratch")).catch(() => [] as string[]))
			.filter((id) => !sessions.has(id))
			.map((id) => rm(scratchDir(id), { recursive: true, force: true }).catch(() => undefined)),
	);
	await ChangeStore.prune(dataDir, sessions.keys()).catch((error: unknown) => log("agent", "warn", `清理改动快照失败：${errorText(error)}`));
	const projects = await openProjects(files, join(dataDir, "projects.json"), (list) => emit({ type: "projects", projects: list }));
	const occupancy = createOccupancy({
		...{ observe, wakeups },
		nudgeOrigin: (session) => wake.nudgeOrigin(session),
		...{ syncBackground, saveSummary },
		drainQueue: (session) => queueing.drainQueue(session),
		wakeReports: (session) => wake.wakeReports(session),
		...{ checkIdle },
		runTurn: (...args) => turn.runTurn(...args),
		...{ emit, summaries },
	});
	const { held, begin, release, releaseHold, setDraft, observeDraft, setRunning, looping } = occupancy;
	const queueing = createQueueing({
		...{ store, sessions, emit, log },
		quitting: () => quitting,
		...{ held, looping, begin },
		launchedPrompts: { add: (prompt) => dispatch.launchedPrompts.add(prompt) },
		find,
	});
	const { handed, queues, drainQueue, enqueue, enqueueTask } = queueing;
	const wake = createWake({ ...{ background }, quitting: () => quitting, ...{ held, sessions }, runTurn: (...args) => turn.runTurn(...args), emit });
	const dispatch = createDispatch({
		...{ host, messagesOf, observe, lifecycle, find, recordOf, sessions, begin, whenIdle, store, log },
		quitting: () => quitting,
		...{ background, held },
		runTurn: (...args) => turn.runTurn(...args),
		...{ parentStatus, enqueueTask, queues, handed, commit },
	});
	const steward = createSteward({ sessions, find, governs, enqueue, queues });
	const turn = createTurn({
		...{ host, log, emit, store, messagesOf, recordOf, readSessionSettings, modelOf },
		buildContext: modelRequests.buildContext,
		...{ find },
		quitting: () => quitting,
		...{ held, releaseHold, setRunning, projects, attachedPaths, scratchDir, lineageScratchDirs },
		request: modelRequests.request,
		commit,
		dropStaleDraft: occupancy.dropStaleDraft,
		...{ askUser: approvals.askUser, requestUser: approvals.requestUser },
		parentFor: dispatch.parentFor,
		...{ jobs, background, wakeups, queues },
		submitPrompt: dispatch.submitPrompt,
		commitPrompt: messages.commitPrompt,
		relocate: lifecycle.relocate,
		...{ observe },
		handedPrompts: queueing.handedPrompts,
		...{ handed, release, syncBackground, saveSummary },
		archive: lifecycle.archive,
		...{ sessions, drainQueue },
		wakeReports: wake.wakeReports,
		checkIdle,
		admitWake: wake.admitWake,
		queuedPrompt: queueing.queuedPrompt,
		thinkingOf,
	});
	// 会话、设置和写入函数就绪后再加载：插件在 apply 里也可以发起子会话；插件一加载就可能动会话，管理授权（`ModelSettings.sessionManager`）先从设置里读上来。
	await modelSettings.read();
	await host.load(options.plugins);

	const service: AgentService = {
		...modelSettings.service,
		...projects.service,
		...sessionsService({ log, modelSettings, projects, store, host, events, registry, governance, idle, lifecycle, queueing }),
		...conversationService({ registry, messages, lifecycle, occupancy, queueing, userMessage, quitting: () => quitting }),
		...filesService({ dataDir, mediaDir, trash: options.trash, projects, events, registry }),
		...exportService({ dataDir, log, modelSettings, store, host, registry }),
		...pluginsService({ pluginsFile, files, host, events }),
	};

	return {
		service,
		host,
		async addPlugin(entry) {
			await host.add(entry);
			return events.pluginsChanged();
		},
		async removePlugin(key) {
			await host.remove(key);
			return events.pluginsChanged();
		},
		busy() {
			// 列表里删掉了、还没收尾的也算（`active`）；后台看 `waiting`：没跑完的派发、交回了没送达的、刚跑完还在聚合窗口里的、没结束的一次性后台任务；挂着的监视、服务、唤醒不算。
			const running = [...sessions.values(), ...turn.active()].some(held);
			return running || [...sessions.keys()].some((id) => waiting(id));
		},
		async filePath(sessionId, path) {
			const session = sessions.get(sessionId);
			if (!session) return null;
			return (await sessionFilePath(session.summary.cwd, path, registry.sessionRoots(session.summary))) ?? managedMediaPath(mediaDir, path);
		},
		async shutdown() {
			quitting = true;
			background.clear();
			wakeups.clear();
			// 后台任务（开发服务器之类）跟着停：它们的进程组是分离的，agent 进程退出不会带走它们。
			jobs.clear();
			clearInterval(catalogTimer);
			const running = [...new Set([...sessions.values(), ...turn.active()])].filter((session) => session.turn);
			for (const session of running) {
				session.quitting = true;
				session.controller?.abort();
			}
			await Promise.all(running.map((session) => session.turn));
			// 停稳以后再告诉插件会话结束了（钩子插件要在退出前跑 SessionEnd），最多等一会儿，不让一个插件拖住退出。
			await Promise.race([
				Promise.all([...sessions.keys()].map((id) => host.sessionEnded(id, "quit"))),
				sleep(SESSION_END_GRACE_MS, undefined, { ref: false }),
			]);
			// 插件停用时收拾自己的。
			await host.dispose();
			await files.idle();
			store.close();
		},
	};
}
