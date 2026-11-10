/**
 * 模型设置：供应商、模型、默认模型怎么存，一轮用哪个模型。
 *
 * 存在 settingsFile（JSON）：{ providers: [...], defaultModel, magpie }。供应商的 API key 不在里面，读写时经 vault.ts 进出；
 * magpie 块里 Magpie 写的 key 原样留在文件里。
 * magpie 块由 Magpie 写，读入时合成一个供应商排在最后，写盘时再拿掉（见 magpie.ts）。
 */

import type { ModelEntry, ModelRef, PermissionMode, Personalization, ProviderSettings, SettingsView, Tone } from "@plume/contract";
import { isImageModel } from "@plume/llm/image-models";
import { normalizeRetryPolicy, type RetryPolicy } from "@plume/llm/retry-policy";
import { resolveModelThinkingOptions, resolveThinkingOption, THINKING_LEVELS } from "@plume/llm/thinking-options";
import type { Message, ModelConfig, ProviderConfig, ThinkingLevel } from "@plume/llm/types";
import { text } from "./i18n.ts";
import { isMagpie, magpieProvider } from "./magpie.ts";

export interface StoredProvider extends ProviderSettings {
	apiKey?: string;
}

export interface StoredSettings {
	providers: StoredProvider[];
	/** 用户设的默认模型；可能已经失效，用 defaultModelOf 取实际生效的那个。Magpie 接管时它也改这一键。 */
	defaultModel?: ModelRef;
	/** 模型菜单里星标的模型。 */
	favoriteModels?: ModelRef[];
	/** 默认生图模型；没设过、或已经不可用时用第一个生图模型。 */
	imageModel?: ModelRef;
	/** 没设过时是 `auto`。 */
	permissionMode?: PermissionMode;
	/** 人答过「以后不再问」的命令和文件路径，见 `ApprovalRequest.subject`。 */
	alwaysAllow?: string[];
	/** Magpie 写的网关，原样留着，写盘时原样写回。 */
	magpie?: unknown;
	/** 没设过的项用 `DEFAULT_PERSONALIZATION`。 */
	personalization?: Partial<Personalization>;
	/** 新会话的思考档位，建会话时记到会话上；没设过是 `DEFAULT_THINKING`。 */
	thinking?: ThinkingLevel;
	/** 模型请求的重试策略，读入时已按 `normalizeRetryPolicy` 收好；没设过用 `@plume/llm` 的默认策略。 */
	retryPolicy?: RetryPolicy;
}

/** 默认中档：几乎所有推理接口都认，模型没有这一档时就近取。 */
export const DEFAULT_THINKING: ThinkingLevel = "medium";

export const TONES: readonly Tone[] = ["friendly", "professional", "concise", "candid", "humorous"];
/** 默认语气是友好：没调过的人得到的是温和的回复，想要干脆的自己调。 */
const DEFAULT_PERSONALIZATION: Personalization = { customInstructions: "", tone: "friendly" };

export function personalizationOf(settings: StoredSettings): Personalization {
	return { ...DEFAULT_PERSONALIZATION, ...settings.personalization };
}

function normalizePersonalization(raw: unknown): Partial<Personalization> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const { customInstructions, tone } = raw as { customInstructions?: unknown; tone?: unknown };
	return {
		...(typeof customInstructions === "string" ? { customInstructions } : {}),
		...(TONES.includes(tone as Tone) ? { tone: tone as Tone } : {}),
	};
}

const API_FORMATS = new Set(["anthropic-messages", "openai-responses", "openai-chat-completions"]);
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 把文件里读到的东西整理成 StoredSettings；读不到、或者不是这个格式，都当作还没有供应商。
 * 只有 Magpie 写过的文件没有 providers，也照样读出它的那一个。
 */
export function normalizeSettings(raw: unknown): StoredSettings {
	if (!raw || typeof raw !== "object") return { providers: [] };
	const { providers, defaultModel, favoriteModels, imageModel, permissionMode, alwaysAllow, magpie, personalization, thinking, retryPolicy } = raw as {
		providers?: unknown;
		defaultModel?: unknown;
		favoriteModels?: unknown;
		imageModel?: unknown;
		permissionMode?: unknown;
		alwaysAllow?: unknown;
		magpie?: unknown;
		personalization?: unknown;
		thinking?: unknown;
		retryPolicy?: unknown;
	};
	const tuned = normalizePersonalization(personalization);
	const own = Array.isArray(providers) ? (providers as StoredProvider[]).filter((provider) => !isMagpie(provider.id)) : [];
	const gateway = magpieProvider(magpie);
	return {
		providers: gateway ? [...own, gateway] : own,
		...(typeof defaultModel === "string" ? { defaultModel } : {}),
		...(Array.isArray(favoriteModels) ? { favoriteModels: favoriteModels.filter((ref): ref is string => typeof ref === "string") } : {}),
		...(typeof imageModel === "string" ? { imageModel } : {}),
		...(permissionMode === "ask" || permissionMode === "auto" || permissionMode === "full" ? { permissionMode } : {}),
		...(Array.isArray(alwaysAllow) ? { alwaysAllow: alwaysAllow.filter((subject): subject is string => typeof subject === "string") } : {}),
		...(magpie === undefined ? {} : { magpie }),
		...(tuned ? { personalization: tuned } : {}),
		...(THINKING_LEVELS.includes(thinking as ThinkingLevel) ? { thinking: thinking as ThinkingLevel } : {}),
		...(retryPolicy === undefined ? {} : { retryPolicy: normalizeRetryPolicy(retryPolicy) }),
	};
}

/** 写盘时的样子：合成的 Magpie 供应商不进 providers，magpie 块和它的 key 原样留在文件里。 */
export function fileSettings(settings: StoredSettings): StoredSettings {
	return { ...settings, providers: settings.providers.filter((provider) => !isMagpie(provider.id)) };
}

function splitRef(ref: ModelRef): { providerId: string; modelId: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** 引用指向一个启用的供应商下存在的模型时返回它们。 */
export function lookup(settings: StoredSettings, ref: ModelRef | undefined): { provider: StoredProvider; model: ModelEntry } | undefined {
	const parts = ref ? splitRef(ref) : undefined;
	if (!parts) return undefined;
	const provider = settings.providers.find((candidate) => candidate.id === parts.providerId && candidate.enabled);
	const model = provider?.models.find((candidate) => candidate.modelId === parts.modelId);
	return provider && model ? { provider, model } : undefined;
}

/**
 * 实际生效的默认模型：设过且还可用就是它，否则第一个启用的供应商的第一个对话模型。
 * 删掉默认模型所在的供应商、或者停用它，默认自己落到下一个，不必在删除时另外收拾。生图模型不进对话，不当默认模型。
 */
export function defaultModelOf(settings: StoredSettings): ModelRef | undefined {
	const set = lookup(settings, settings.defaultModel);
	if (set && !isImageModel(set.model)) return settings.defaultModel;
	for (const provider of settings.providers) {
		const model = provider.enabled ? provider.models.find((candidate) => !isImageModel(candidate)) : undefined;
		if (model) return `${provider.id}/${model.modelId}`;
	}
	return undefined;
}

/** 交给 `@plume/llm` 的样子：模型带上 `供应商 id/模型 id`，没存 key 时是空串。 */
export function providerConfig(provider: StoredProvider): ProviderConfig {
	const models = provider.models.map((model): ModelConfig => ({ id: `${provider.id}/${model.modelId}`, providerId: provider.id, ...model }));
	return { ...provider, apiKey: provider.apiKey ?? "", models };
}

export function settingsView(settings: StoredSettings): SettingsView {
	const defaultModel = defaultModelOf(settings);
	return {
		providers: settings.providers.map(({ apiKey, ...provider }) => ({ ...provider, hasKey: Boolean(apiKey) })),
		...(defaultModel ? { defaultModel } : {}),
		favoriteModels: settings.favoriteModels ?? [],
		...(settings.imageModel ? { imageModel: settings.imageModel } : {}),
		permissionMode: settings.permissionMode ?? "auto",
		personalization: personalizationOf(settings),
		thinking: settings.thinking ?? DEFAULT_THINKING,
		retryPolicy: normalizeRetryPolicy(settings.retryPolicy),
	};
}

/** 一轮用哪个模型：会话选的还可用就用它，否则用默认模型。 */
export function resolveModel(settings: StoredSettings, sessionModel: ModelRef | undefined): { provider: ProviderConfig; model: ModelConfig } {
	const found = lookup(settings, sessionModel) ?? lookup(settings, defaultModelOf(settings));
	if (!found) throw new Error(text("model.none"));
	const { provider, model } = found;
	if (!provider.apiKey) throw new Error(text("model.noKey", { name: provider.name }));
	const config: ModelConfig = { id: `${provider.id}/${model.modelId}`, providerId: provider.id, ...model };
	return { provider: { ...provider, apiKey: provider.apiKey, models: [config] }, model: config };
}

/**
 * 一轮用的思考档位：会话选过就用它（模型没有这一档时就近取一档），没选用模型的默认档；不支持思考的模型是 off。
 * 测试连接不在会话里，传空，发的就是新会话会发的那一档。
 */
export function thinkingFor(model: ModelConfig, chosen: ThinkingLevel | undefined): ThinkingLevel {
	const option = chosen ? resolveThinkingOption(chosen, model) : resolveModelThinkingOptions(model).find((candidate) => candidate.isDefault);
	return option?.id ?? "off";
}

/**
 * 去掉别的模型写下的供应商句柄：思考签名、加密的推理、正文和工具调用上的条目 id（都在 signature 里）。
 *
 * 会话中途换了模型时，旧回复带着上一个供应商的句柄，发给新的那个会被整个拒掉，而且记录里一直留着，之后每一轮都被拒。
 * 按每条回复自己记的 provider 和 model 判断，不记换模型的位置：换模型时还在跑的那条旧回复落在换之后，也一样能认出来。
 * 字留着，界面上读起来不变；工具调用的 id 是和结果配对的，不动。没有要去的就原样返回。
 */
export function stripForeignHandles(messages: Message[], provider: ProviderConfig, model: ModelConfig): Message[] {
	let changed = false;
	const out = messages.map((message) => {
		if (message.role !== "assistant" || (message.provider === provider.id && message.model === model.modelId)) return message;
		let touched = false;
		const content = message.content.map((block) => {
			if (block.type === "thinking") {
				if (block.signature === undefined && block.encrypted === undefined) return block;
				touched = true;
				// redacted 表示「字被滤掉了、加密内容还能回放」；加密内容去掉后它就是个空块。
				const { signature: _signature, encrypted: _encrypted, redacted: _redacted, ...rest } = block;
				return rest;
			}
			if (block.signature === undefined) return block;
			touched = true;
			const { signature: _signature, ...rest } = block;
			return rest;
		});
		if (!touched) return message;
		changed = true;
		return { ...message, content };
	});
	return changed ? out : messages;
}

/** 校验并整理一个要保存的供应商。id 为空时由调用方先分配好。 */
export function checkProvider(provider: StoredProvider): StoredProvider {
	if (!PROVIDER_ID.test(provider.id)) throw new Error(text("check.providerId", { id: provider.id }));
	const name = provider.name.trim();
	if (!name) throw new Error(text("check.providerName"));
	if (!API_FORMATS.has(provider.api)) throw new Error(text("check.api", { api: provider.api }));
	const baseUrl = provider.baseUrl.trim();
	if (!/^https?:\/\//.test(baseUrl)) throw new Error(text("check.baseUrl"));
	const seen = new Set<string>();
	const models = provider.models.map((model) => {
		const modelId = model.modelId.trim();
		if (!modelId) throw new Error(text("check.modelId"));
		if (seen.has(modelId)) throw new Error(text("check.modelIdTaken", { id: modelId }));
		seen.add(modelId);
		for (const [key, value] of [
			["check.contextWindow", model.contextWindow],
			["check.maxOutput", model.maxOutputTokens],
		] as const) {
			if (!Number.isInteger(value) || value <= 0) throw new Error(text(key, { model: modelId }));
		}
		return {
			modelId,
			name: model.name.trim() || modelId,
			contextWindow: model.contextWindow,
			maxOutputTokens: model.maxOutputTokens,
			supportsThinking: Boolean(model.supportsThinking),
			supportsImages: Boolean(model.supportsImages),
			supportsTools: Boolean(model.supportsTools),
			...(model.pricing ? { pricing: model.pricing } : {}),
			...(model.thinkingOptions?.length ? { thinkingOptions: model.thinkingOptions } : {}),
			// 只在人说过时存：没存是「按名字判断」，改了模型 id 跟着变。
			...(typeof model.imageOutput === "boolean" ? { imageOutput: model.imageOutput } : {}),
		};
	});
	return {
		id: provider.id,
		name,
		api: provider.api,
		baseUrl,
		enabled: Boolean(provider.enabled),
		models,
		...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
	};
}
