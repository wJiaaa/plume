import { join } from "node:path";
import type { Log, PluginFetch } from "@plume/contract";
import { isImageModel } from "@plume/llm/image-models";
import { resolveModelThinkingOptions } from "@plume/llm/thinking-options";
import type { BackgroundRuns } from "./background.ts";
import { type HostPages, PluginHost } from "./host.ts";
import { drawImages, findImageModel } from "./images.ts";
import { text } from "./i18n.ts";
import type { JsonFiles } from "./json-files.ts";
import type { BackgroundJobs } from "./jobs.ts";
import { imageNameOf, readImage, saveImage } from "./media.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PluginProviderSources } from "./plugin-providers.ts";
import type { Projects } from "./projects.ts";
import type { SessionDb } from "./session-db.ts";
import type { Dispatch } from "./session/dispatch.ts";
import type { Events } from "./session/events.ts";
import type { Governance } from "./session/governance.ts";
import type { Idle } from "./session/idle.ts";
import type { Lifecycle } from "./session/lifecycle.ts";
import type { ModelRequests } from "./session/model-requests.ts";
import type { Occupancy } from "./session/occupancy.ts";
import type { Registry } from "./session/registry.ts";
import type { Steward } from "./session/steward.ts";
import type { Turn } from "./session/turn.ts";
import type { SessionWakeups } from "./wakeups.ts";
import type { Vault } from "./vault.ts";

interface HostOptions {
	sdkVersion?: string;
	pages?: HostPages;
	fetch?: PluginFetch;
	trash?: (path: string) => Promise<void>;
}

export interface CreateHostDeps {
	options: HostOptions;
	dataDir: string;
	mediaDir: string;
	log: Log;
	files: JsonFiles;
	modelSettings: Pick<ModelSettings, "read" | "service">;
	pluginProviders: Pick<PluginProviderSources, "add">;
	vault: Pick<Vault, "pluginSecrets">;
	store: Pick<SessionDb, "usage" | "holdMedia">;
	background: Pick<BackgroundRuns, "start" | "wait" | "report" | "cancelOwner">;
	jobs: Pick<BackgroundJobs, "list" | "stop" | "output" | "stopRunning" | "forgetOwner">;
	wakeups: Pick<SessionWakeups, "list" | "cancel" | "cancelOwner">;
	events: Pick<Events, "emit" | "modelsChanged" | "toolsChanged">;
	registry: Pick<Registry, "sessions" | "readMessages" | "scratchDir" | "rootSession" | "find" | "summaries" | "saveSummary">;
	governance: Pick<Governance, "readSessionSettings">;
	idle: Pick<Idle, "syncBackground">;
	lifecycle: Pick<Lifecycle, "archive" | "createStandalone" | "createChild" | "configureOwn" | "owned" | "runnableParent" | "stopSession" | "deleteTree">;
	modelRequests: Pick<ModelRequests, "completeOnce">;
	projects: Pick<Projects, "list">;
	occupancy: Pick<Occupancy, "held">;
	dispatch: Pick<Dispatch, "launchSession" | "reportBack" | "childMessage" | "sendChild">;
	steward: Pick<Steward, "postToSession" | "settleAsSteward" | "stewarded">;
	turn: Pick<Turn, "compactNow" | "runTurn" | "active">;
}

export async function createHost(deps: CreateHostDeps): Promise<{ host: PluginHost; pluginsFile: string }> {
	const {
		options,
		dataDir,
		mediaDir,
		log,
		files,
		modelSettings,
		pluginProviders,
		vault,
		store,
		background,
		jobs,
		wakeups,
		events: { emit, modelsChanged, toolsChanged },
		registry: { sessions, readMessages, scratchDir, rootSession, find, summaries, saveSummary },
		governance: { readSessionSettings },
		idle: { syncBackground },
		lifecycle: { archive, createStandalone, createChild, configureOwn, owned, runnableParent, stopSession, deleteTree },
		modelRequests: { completeOnce },
		projects,
		occupancy: { held },
		dispatch: { launchSession, reportBack, childMessage, sendChild },
		steward: { postToSession, settleAsSteward, stewarded },
		turn,
	} = deps;
	const { compactNow, runTurn } = turn;
	const pluginsFile = join(dataDir, "plugins.json");
	const config = (await files.read<{ disabled?: unknown }>(pluginsFile)) ?? {};
	const disabled = new Set(Array.isArray(config.disabled) ? config.disabled.filter((key): key is string => typeof key === "string") : []);
	const host = new PluginHost({
		// 不叫 plugins：数据目录下的 plugins/ 是插件市场装插件的地方。
		dataDir: join(dataDir, "plugin-data"),
		appDataDir: dataDir,
		disabled,
		...(options.sdkVersion ? { sdkVersion: options.sdkVersion } : {}),
		log,
		model: {
			complete: (request) => completeOnce(request),
			findImageModel: async (name, sessionId) =>
				findImageModel(sessionId === undefined ? await modelSettings.read() : await readSessionSettings(find(String(sessionId))), name),
			image: async (request) => drawImages(await modelSettings.read(), request),
			usage: async () => ({
				requests: store.usage().map((bucket) => ({ ...bucket, sessions: [...new Set(bucket.sessions.flatMap((id) => rootSession(id) ?? []))] })),
				providerNames: Object.fromEntries((await modelSettings.read()).providers.map((provider) => [provider.id, provider.name])),
				archived: summaries().flatMap((summary) => (!summary.parentId && summary.archived ? [summary.id] : [])),
			}),
		},
		notice: (sessionId, text, level) => emit({ type: "notice", sessionId, text, level }),
		providers: {
			add: (plugin, source) => pluginProviders.add(plugin, source),
			changed: modelsChanged,
			defaultModel: async () => (await modelSettings.read()).defaultModel,
			setDefaultModel: async (model) => {
				await modelSettings.service.setDefaultModel(model);
				modelsChanged();
			},
		},
		media: {
			save: async ({ data, mimeType, sessionId }) => {
				const name = await saveImage(mediaDir, String(data), String(mimeType));
				if (!name) throw new Error(text("media.badType"));
				// 记在说的那个会话名下，随它删；没说会话的算插件的，一直留着（见 `media_refs`）。
				store.holdMedia(typeof sessionId === "string" && sessionId ? sessionId : null, name);
				return { name, path: join(mediaDir, name) };
			},
			read: (name) => readImage(mediaDir, String(name)),
			nameOf: (path) => imageNameOf(mediaDir, String(path)),
		},
		secrets: (plugin) => vault.pluginSecrets(plugin),
		...(options.pages ? { pages: options.pages } : {}),
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(options.trash ? { trash: options.trash } : {}),
		toolsChanged,
		// 给副本：插件改了它手上的那份，不影响会话。
		sessions: {
			list: async () => structuredClone(summaries()),
			get: async (sessionId) => {
				const session = sessions.get(String(sessionId));
				return session ? structuredClone(session.summary) : undefined;
			},
			messages: async (sessionId) => structuredClone(readMessages(find(String(sessionId)))),
			approval: (sessionId) => {
				const pending = sessions.get(String(sessionId))?.approvals?.[0];
				return pending ? structuredClone(pending.request) : undefined;
			},
			jobs: (sessionId) => jobs.list(String(sessionId)),
			stopJob: (sessionId, jobId, force) => jobs.stop(String(sessionId), String(jobId), force === true),
			jobOutput: (sessionId, jobId) => jobs.output(String(sessionId), String(jobId)),
			scratchDir: async (sessionId) => scratchDir(find(String(sessionId)).summary.id),
			wakeups: (sessionId) => wakeups.list(String(sessionId)),
			cancelWakeup: (sessionId, id) => wakeups.cancel(String(sessionId), String(id)),
			compact: (sessionId, options) => compactNow(String(sessionId), typeof options?.instructions === "string" ? options.instructions.trim() : ""),
			setTitle: async (sessionId, title, options) => {
				const session = find(String(sessionId));
				if (options?.automatic && session.summary.titleEdited) return;
				const cleaned = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
				if (!cleaned || cleaned === session.summary.title) return;
				session.summary.title = cleaned;
				saveSummary(session);
			},
			setArchived: async (sessionId, archived) => {
				const session = find(String(sessionId));
				if (session.summary.kind !== "top") throw new Error(text("session.childArchive"));
				archive(session, archived === true);
			},
			create: async (owner, options) =>
				structuredClone(await (options?.parentId === undefined ? createStandalone(owner, options) : createChild(owner, options))),
			configure: (owner, sessionId, change) => configureOwn(owner, sessionId, change),
			launch: (owner, options) => launchSession(owner, options),
			reportBack: (owner, sessionId, words, options) => reportBack(owner, sessionId, words, options),
			post: async (owner, sessionId, message) => ({ started: postToSession(owner, sessionId, message) }),
			respond: async (owner, sessionId, toolCallId, decision) => settleAsSteward(owner, sessionId, toolCallId, { decision }),
			answer: async (owner, sessionId, toolCallId, value) => settleAsSteward(owner, sessionId, toolCallId, { value }),
			models: async () => {
				const settings = await modelSettings.read();
				return settings.providers
					.filter((provider) => provider.enabled)
					.flatMap((provider) =>
						// 生图模型不进对话，子会话也选不了。
						provider.models
							.filter((model) => !isImageModel(model))
							.map((model) => ({
								id: `${provider.id}/${model.modelId}`,
								name: model.name,
								contextWindow: model.contextWindow,
								thinking: structuredClone(resolveModelThinkingOptions({ ...model, id: `${provider.id}/${model.modelId}`, providerId: provider.id })),
							})),
					);
			},
			projects: async () => projects.list().map(({ id, name, path }) => ({ id, name, path })),
			send: async (owner, sessionId, message, options) => sendChild(owned(owner, sessionId), message, options?.signal),
			start: async (owner, sessionId, message) => {
				const session = owned(owner, sessionId);
				const parent = runnableParent(session);
				if (held(session)) throw new Error(text("session.running"));
				const prompt = childMessage(message);
				const controller = new AbortController();
				const run = background.start(
					owner,
					session.summary.id,
					parent.summary.id,
					() => controller.abort(),
					async () => {
						session.controller = controller;
						try {
							return await (session.turn = runTurn(session, prompt, controller, true));
						} finally {
							// 子会话收不到后台送达，这次运行起的后台任务留下来就没人管了：收工时停掉，续跑要用就再起一个。
							jobs.stopRunning(session.summary.id);
						}
					},
				);
				if (syncBackground(parent)) emit({ type: "sessions", sessions: summaries() });
				return run;
			},
			wait: (owner, runId) => background.wait(owner, runId),
			report: async (owner, runId, words, options) => background.report(owner, runId, words, options),
			steer: async (owner, sessionId, message) => {
				const session = owned(owner, sessionId);
				if (!session.controller || session.controller.signal.aborted) throw new Error(text("session.notRunning"));
				(session.steering ??= []).push(childMessage(message));
			},
			disposeOwner: async (owner) => {
				background.cancelOwner(owner);
				// 它登记的后台任务停掉（进程组是分离的，没人停就一直活到关机），它约的唤醒到点时要它给话，也取消。
				jobs.forgetOwner(owner);
				wakeups.cancelOwner(owner);
				const children = [...new Set([...sessions.values(), ...turn.active()])].filter((session) => session.summary.owner === owner);
				for (const child of children) {
					child.steering = [];
					child.controller?.abort();
					host.sessionStopped(child.summary.id);
				}
				await Promise.all(children.map((child) => child.turn));
			},
			// 自己建的会话，或代管、管理着的顶层会话（和人按停止同一条路）。
			stop: (owner, sessionId) => {
				const session = find(String(sessionId));
				stopSession(session.summary.owner === owner ? session : stewarded(owner, sessionId));
			},
			delete: async (owner, sessionId) => deleteTree([owned(owner, sessionId).summary.id]),
		},
	});
	return { host, pluginsFile };
}
