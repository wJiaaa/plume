/**
 * 界面这边的模型设置：agent 进程给的 SettingsView 换成模型选择、设置页用的形状，改动经 AgentService 写回。
 *
 * 界面里说「哪个模型」用的是 `供应商 id/模型 id`（ModelRef，也是 ModelConfig.id）：同一个模型 id 可以配在两个供应商下，
 * key、上下文窗口都不同。发给供应商的是 modelId，只有请求和品牌识别用它。
 * key 不出 agent 进程：这里只知道存没存（hasKey），改 key 是保存时带上新填的那个。
 */

import type { AgentService, ProviderSettings, ProviderView, SettingsView } from "@plume/contract";
import type { ModelConfig } from "@plume/llm/types";
import type { Remote } from "@plume/rpc";
import { useSyncExternalStore } from "react";

export type { ModelConfig };

export interface ProviderEntry extends Omit<ProviderView, "models"> {
	models: ModelConfig[];
}

export interface ModelsState {
	providers: ProviderEntry[];
	/** 实际生效的默认模型；一个可用的都没有时为 null。 */
	defaultModelId: string | null;
	favoriteModelIds: string[];
	/** 设置里选的默认生图模型，原样（可能已经不可用）；null 是「自动」，用第一个生图模型。 */
	imageModelId: string | null;
}

let agent: Remote<AgentService> | undefined;
let state: ModelsState | undefined;
let view: SettingsView | undefined;
const listeners = new Set<() => void>();

export function connectModels(service: Remote<AgentService>): void {
	agent = service;
}

/** 调 agent 进程。连上之前没有界面能调到这里，所以不判空。 */
export function modelsAgent(): Remote<AgentService> {
	if (!agent) throw new Error("agent not connected");
	return agent;
}

function toState(settings: SettingsView): ModelsState {
	return {
		providers: settings.providers.map((provider) => ({
			...provider,
			models: provider.models.map((model) => ({ id: `${provider.id}/${model.modelId}`, providerId: provider.id, ...model })),
		})),
		defaultModelId: settings.defaultModel ?? null,
		favoriteModelIds: settings.favoriteModels,
		imageModelId: settings.imageModel ?? null,
	};
}

/** 重新向 agent 进程要一次设置。每次改动之后调，侧栏、输入框、设置页一起跟着变。 */
export async function refreshModels(): Promise<ModelsState> {
	view = await modelsAgent().getSettings();
	state = toState(view);
	for (const listener of listeners) listener();
	return state;
}

export function modelsState(): ModelsState | undefined {
	return state;
}

export function settingsView(): SettingsView | undefined {
	return view;
}

export function subscribeModels(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useModels(): ModelsState | undefined {
	return useSyncExternalStore(subscribeModels, modelsState);
}

/** 存回一个供应商（id 为空是新建），返回它的 id。apiKey 只在填了新 key 时带。 */
export async function saveProvider(provider: Omit<ProviderEntry, "hasKey"> & { apiKey?: string }): Promise<string> {
	const { hasKey: _hasKey, apiKey, models, ...rest } = provider as ProviderEntry & { apiKey?: string };
	const settings: ProviderSettings & { apiKey?: string } = {
		...rest,
		models: models.map(({ id: _id, providerId: _providerId, ...model }) => ({
			modelId: model.modelId,
			name: model.name,
			contextWindow: model.contextWindow,
			maxOutputTokens: model.maxOutputTokens,
			supportsThinking: model.supportsThinking,
			supportsImages: model.supportsImages,
			supportsTools: model.supportsTools,
			...(model.pricing ? { pricing: model.pricing } : {}),
			...(model.thinkingOptions ? { thinkingOptions: model.thinkingOptions } : {}),
			...(model.imageOutput !== undefined ? { imageOutput: model.imageOutput } : {}),
		})),
		...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
	};
	const id = await modelsAgent().saveProvider(settings);
	await refreshModels();
	return id;
}

/** 用最新的那份改一个供应商再存回：弹窗可能开着跨过了一次保存。 */
export async function updateProvider(providerId: string, change: (provider: ProviderEntry) => ProviderEntry & { apiKey?: string }): Promise<void> {
	const current = (state ?? (await refreshModels())).providers.find((provider) => provider.id === providerId);
	if (!current) return;
	await saveProvider(change(current));
}

export async function deleteProvider(providerId: string): Promise<void> {
	await modelsAgent().deleteProvider(providerId);
	await refreshModels();
}

export async function setDefaultModel(modelId: string): Promise<void> {
	await modelsAgent().setDefaultModel(modelId);
	await refreshModels();
}

/** 设默认生图模型；null 回到「自动」。 */
export async function setImageModel(modelId: string | null): Promise<void> {
	await modelsAgent().setImageModel(modelId);
	await refreshModels();
}

export async function setFavoriteModels(modelIds: string[]): Promise<void> {
	await modelsAgent().setFavoriteModels(modelIds);
	await refreshModels();
}

/** 这个 id 对应的模型（ModelConfig.id，不是 modelId）。 */
export function findModel(settings: ModelsState | undefined, modelId: string | null | undefined): ModelConfig | null {
	if (!settings || !modelId) return null;
	for (const provider of settings.providers) {
		const model = provider.models.find((candidate) => candidate.id === modelId);
		if (model) return model;
	}
	return null;
}
