/**
 * 模型设置（`settingsFile`）：读、排队改写，和设置页那一组只动设置、不碰会话的 AgentService 方法。
 *
 * 供应商的 key 不落在这个文件里，读写时经 vault 进出（`providerKeys`）；插件提供的供应商读时接上，改和删交回插件（plugin-providers.ts）。
 * 要连带会话的（权限模式、项目层、会话自己的模型）由 agent.ts 用这里的 `read`、`change` 组。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentService, AlwaysAllow, SettingsView } from "@plume/contract";
import { isImageModel } from "@plume/llm/image-models";
import { activeModelCatalog } from "@plume/llm/model-catalog";
import { normalizeRetryPolicy } from "@plume/llm/retry-policy";
import { THINKING_LEVELS } from "@plume/llm/thinking-options";
import { sameGrant } from "@plume/loop";
import { writeFileAtomic } from "./atomic-write.ts";
import { text } from "./i18n.ts";
import type { JsonFiles } from "./json-files.ts";
import { syncModelCatalog } from "./model-catalog-sync.ts";
import { checkProvider, fileSettings, lookup, normalizeSettings, type StoredSettings, settingsView, TONES } from "./models.ts";
import type { PluginProviderSources } from "./plugin-providers.ts";
import { applyImport, parseBundle, planImport, serializeBundle } from "./provider-transfer.ts";
import { fetchModels, testProvider } from "./providers.ts";
import type { providerKeys } from "./vault.ts";

type SettingsService = Pick<
	AgentService,
	| "getSettings"
	| "saveProvider"
	| "deleteProvider"
	| "setDefaultModel"
	| "setImageModel"
	| "setFavoriteModels"
	| "revokeAlwaysAllow"
	| "clearAlwaysAllow"
	| "setDefaultThinking"
	| "setRetryPolicy"
	| "setPersonalization"
	| "testProvider"
	| "fetchModels"
	| "modelCatalog"
	| "updateModelCatalog"
	| "exportProviders"
	| "previewProviderImport"
	| "importProviders"
>;

export interface ModelSettings {
	/** 读一份最新的（每次用到都重读，人可能手改了文件）；顺带让 `retryPolicy`、`sessionManager` 跟上。 */
	read(): Promise<StoredSettings>;
	/** 读、改、写三步排成一队，两次保存挨得近时后一次不会覆盖掉前一次。返回 `edit` 的结果。 */
	change<T>(edit: (settings: StoredSettings) => T | Promise<T>): Promise<T>;
	/** 最近一次读到或写下的重试策略：重试预算在每次等待前同步取它。 */
	retryPolicy(): StoredSettings["retryPolicy"];
	/** 最近一次读到或写下的会话管理者（`StoredSettings.sessionManager`）：判断插件能不能动会话时同步要用。 */
	sessionManager(): string | undefined;
	service: SettingsService;
}

export function createModelSettings(options: {
	files: JsonFiles;
	keys: ReturnType<typeof providerKeys>;
	settingsFile: string;
	/** 模型目录的缓存文件，见 `AgentOptions.catalogFile`；没有时「更新目录」什么都不做。 */
	catalogFile: string | undefined;
	/** 插件经 `ctx.providers` 提供的供应商。 */
	pluginProviders: PluginProviderSources;
}): ModelSettings {
	const { files, keys, settingsFile, catalogFile, pluginProviders } = options;
	let liveRetryPolicy: StoredSettings["retryPolicy"];
	let liveSessionManager: string | undefined;

	const follow = (settings: StoredSettings) => {
		liveRetryPolicy = settings.retryPolicy;
		liveSessionManager = settings.sessionManager;
	};

	/** 正在改的次数：改的时候别处读到的可能是写之前的那份，不拿它盖掉内存里的值。 */
	let changing = 0;

	async function read(): Promise<StoredSettings> {
		const settings = await keys.withKeys(normalizeSettings(await files.read<unknown>(settingsFile)));
		settings.providers = pluginProviders.merge(settings.providers);
		if (changing === 0) follow(settings);
		return settings;
	}

	let queue: Promise<unknown> = Promise.resolve();
	function changeSettings<T>(edit: (settings: StoredSettings) => T | Promise<T>): Promise<T> {
		const run = queue.then(async () => {
			changing++;
			try {
				const settings = await read();
				const result = await edit(settings);
				// 0600：key 已经不在里面了，剩下的照样写着这台机器上的每个项目和连的每个服务。
				await files.write(settingsFile, await keys.takeKeys(fileSettings(settings)), 0o600);
				// 写成了才跟上：写失败时内存里还是盘上那份。
				follow(settings);
				return result;
			} finally {
				changing--;
			}
		});
		queue = run.catch(() => undefined);
		return run;
	}

	const service: SettingsService = {
		async getSettings(): Promise<SettingsView> {
			return settingsView(await read());
		},
		async saveProvider({ apiKey, ...provider }) {
			const managed = provider.id ? (await read()).providers.find((candidate) => candidate.id === provider.id && candidate.managedBy) : undefined;
			if (managed?.managedBy) {
				const saved = checkProvider({ ...provider, apiKey: apiKey?.trim() || managed.apiKey });
				await pluginProviders.save(managed.managedBy, { ...saved, apiKey: saved.apiKey ?? "" });
				return managed.id;
			}
			return changeSettings((settings) => {
				const id = provider.id || `p-${randomUUID().slice(0, 8)}`;
				const index = settings.providers.findIndex((candidate) => candidate.id === id);
				if (provider.id && index < 0) throw new Error(text("provider.notFound", { id: provider.id }));
				const saved = checkProvider({ ...provider, id, apiKey: apiKey?.trim() || settings.providers[index]?.apiKey });
				if (index < 0) settings.providers.push(saved);
				else settings.providers[index] = saved;
				return id;
			});
		},
		async deleteProvider(providerId) {
			const managed = (await read()).providers.find((candidate) => candidate.id === providerId && candidate.managedBy);
			if (managed?.managedBy) return pluginProviders.remove(managed.managedBy, providerId);
			await changeSettings((settings) => {
				settings.providers = settings.providers.filter((provider) => provider.id !== providerId);
			});
		},
		async setDefaultModel(model) {
			await changeSettings((settings) => {
				const found = lookup(settings, model);
				if (!found) throw new Error(text("model.unavailable", { model }));
				if (isImageModel(found.model)) throw new Error(text("model.imageNotChat", { model: found.model.name }));
				settings.defaultModel = model;
			});
		},
		async setImageModel(model) {
			await changeSettings((settings) => {
				if (model === null) {
					delete settings.imageModel;
					return;
				}
				const found = lookup(settings, model);
				if (!found) throw new Error(text("model.unavailable", { model }));
				if (!isImageModel(found.model)) throw new Error(text("model.notImage", { model: found.model.name }));
				settings.imageModel = model;
			});
		},
		async setFavoriteModels(models) {
			await changeSettings((settings) => {
				settings.favoriteModels = [...new Set(models.filter((ref) => typeof ref === "string"))];
			});
		},
		async revokeAlwaysAllow(grant) {
			if (!grant || typeof grant.subject !== "string") throw new Error(text("alwaysAllow.invalid"));
			const target: AlwaysAllow = grant.plugin === undefined ? { subject: grant.subject } : { subject: grant.subject, plugin: grant.plugin };
			await changeSettings((settings) => {
				settings.alwaysAllow = (settings.alwaysAllow ?? []).filter((one) => !sameGrant(one, target));
			});
		},
		async clearAlwaysAllow() {
			await changeSettings((settings) => {
				settings.alwaysAllow = [];
			});
		},
		async setDefaultThinking(thinking) {
			if (!THINKING_LEVELS.includes(thinking)) throw new Error(text("thinking.unknown", { level: String(thinking) }));
			await changeSettings((settings) => {
				settings.thinking = thinking;
			});
		},
		async setRetryPolicy(policy) {
			await changeSettings((settings) => {
				settings.retryPolicy = normalizeRetryPolicy(policy);
			});
		},
		async setPersonalization(change) {
			const { customInstructions, tone } = change ?? {};
			if (customInstructions !== undefined && typeof customInstructions !== "string") throw new Error(text("personalization.invalid"));
			if (tone !== undefined && !TONES.includes(tone)) throw new Error(text("personalization.invalid"));
			await changeSettings((settings) => {
				settings.personalization = {
					...settings.personalization,
					...(customInstructions !== undefined ? { customInstructions } : {}),
					...(tone !== undefined ? { tone } : {}),
				};
			});
		},
		async testProvider(providerId, modelId) {
			const provider = (await read()).providers.find((candidate) => candidate.id === providerId);
			if (!provider) return { ok: false, latencyMs: 0, message: text("provider.notFound", { id: providerId }) };
			return testProvider(provider, modelId || undefined);
		},
		async fetchModels(providerId) {
			const provider = (await read()).providers.find((candidate) => candidate.id === providerId);
			if (!provider) return { ok: false, models: [], error: text("provider.notFound", { id: providerId }) };
			return fetchModels(provider);
		},
		// 版本相同就不传整份目录：界面每次打开设置页都会来问一句。
		async modelCatalog(knownRevision) {
			return activeModelCatalog().source.revision === knownRevision ? null : activeModelCatalog();
		},
		async updateModelCatalog() {
			if (!catalogFile) return { status: "unchanged", source: activeModelCatalog().source };
			return syncModelCatalog(catalogFile);
		},
		async exportProviders(file) {
			const own = fileSettings(await read()).providers;
			const { text: body, containsSecrets } = serializeBundle(own);
			await mkdir(dirname(file), { recursive: true });
			// 不直接 `writeFile`：它只在新建文件时给 `mode`，覆盖一份已有的 0644 文件时，带着明文 key 的导出谁都能读。
			await writeFileAtomic(file, body, { mode: 0o600 });
			return { providers: own.length, containsSecrets };
		},
		async previewProviderImport(file) {
			const parsed = parseBundle(await readFile(file, "utf8").catch(() => ""));
			if (!parsed.ok) return parsed;
			return { ok: true, entries: planImport(parsed.providers, fileSettings(await read()).providers), dropped: parsed.dropped };
		},
		async importProviders(file, providerIds) {
			// 预览之后文件可能被改过，所以按 id 从文件里重新读一遍，而不是信任界面传回来的内容。
			const parsed = parseBundle(await readFile(file, "utf8").catch(() => ""));
			if (!parsed.ok) return 0;
			const wanted = new Set(providerIds);
			const chosen = parsed.providers.filter((provider) => wanted.has(provider.id));
			if (chosen.length === 0) return 0;
			await changeSettings((settings) => {
				settings.providers = applyImport(fileSettings(settings).providers, chosen);
			});
			return chosen.length;
		},
	};

	return { read, change: changeSettings, retryPolicy: () => liveRetryPolicy, sessionManager: () => liveSessionManager, service };
}
