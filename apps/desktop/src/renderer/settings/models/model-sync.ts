/**
 * 拉取弹窗做的决定，写成数据：一个供应商的模型哪些留、哪些来、哪些走。
 *
 * 勾选框表示「应用之后在不在列表里」：已配置的一开始勾着，取消勾选就是移除；端点列出、还没配置的一开始也勾着，
 * 应用时加进来；手动输入的名字照写的加进来。点「应用」之前什么都不存，所以没勾的一行只是提议，不是删除。
 * 这样弹窗既能加也能删，也能加端点没列出的模型（有的中转只列出一部分）；全都配过了也不会是死路。
 *
 * 写成纯函数：默认模型那些规则在调用处很容易写错，在这里不用界面就能测。
 */

import { isImageModel } from "@plume/llm/image-models";
import { brandOf, houseWords } from "../../models/model-brand.ts";
import type { ModelConfig, ProviderEntry } from "../../models/store.ts";
import { importedModel } from "./model-defaults.ts";

export interface SyncRow {
	/** 发给供应商的 id：端点列出的、人敲进来的都是它。 */
	modelId: string;
	/** 这一行对应的已配置模型（已配置时才有）。 */
	existing?: ModelConfig;
	/** 端点这一次列出了它。 */
	listed: boolean;
	/** 在弹窗里手动输入的，既不是列出的也不是已配置的。 */
	custom: boolean;
}

export interface SyncRows {
	/** 已配置的模型，按供应商自己的顺序。 */
	configured: SyncRow[];
	/** 可以加的：手动输入的在前（新的在上），然后是列出的。 */
	available: SyncRow[];
}

/** 去空白、去空、保留第一次出现的：端点把一个模型列两次也不该有两行。 */
export function cleanModelIds(ids: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of ids) {
		const id = raw.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

export function syncRows(listed: readonly string[], configured: readonly ModelConfig[], custom: readonly string[]): SyncRows {
	const listedIds = cleanModelIds(listed);
	const listedSet = new Set(listedIds);
	const configuredIds = new Set(configured.map((model) => model.modelId));
	const customIds = cleanModelIds(custom).filter((id) => !configuredIds.has(id) && !listedSet.has(id));
	return {
		configured: configured.map((model) => ({ modelId: model.modelId, existing: model, listed: listedSet.has(model.modelId), custom: false })),
		available: [
			...[...customIds].reverse().map((modelId) => ({ modelId, listed: false, custom: true })),
			...listedIds.filter((id) => !configuredIds.has(id)).map((modelId) => ({ modelId, listed: true, custom: false })),
		],
	};
}

export interface ModelChange {
	/** 要加的模型 id，按追加的顺序。 */
	add: string[];
	/** 要从供应商移除的模型 id。 */
	remove: string[];
}

/**
 * 应用弹窗会做什么。
 *
 * 每一行一开始都勾着，所以状态只记取消了哪些；弹窗开着时列表变了、后来冒出来的一行，也按「勾着」算，而不是读成「移除」。
 */
export function changeOf(rows: SyncRows, unchecked: ReadonlySet<string>): ModelChange {
	return {
		add: rows.available.filter((row) => !unchecked.has(row.modelId)).map((row) => row.modelId),
		remove: rows.configured.filter((row) => unchecked.has(row.modelId)).map((row) => row.modelId),
	};
}

/** 一行是否对得上搜索：它的 id、起的名字，或者出品它的厂商（搜「google」能找到 Gemini）。 */
export function rowMatches(row: SyncRow, query: string): boolean {
	const wanted = query.trim().toLowerCase();
	if (!wanted) return true;
	const brand = brandOf(row.modelId, row.existing?.name);
	return [row.modelId, row.existing?.name ?? "", ...(brand ? houseWords(brand) : [])].some((word) => word.toLowerCase().includes(wanted));
}

/**
 * 敲进来的名字在弹窗里是不是新的。
 *
 * 和 id 本身不同，这里不分大小写：在列出的「gpt-4o」旁边敲「GPT-4o」，几乎一定说的是列出的那个，只差大小写的第二行是陷阱。
 */
export function isNewModelName(name: string, rows: SyncRows): boolean {
	const wanted = name.trim().toLowerCase();
	if (!wanted) return false;
	return ![...rows.configured, ...rows.available].some((row) => row.modelId.toLowerCase() === wanted);
}

/**
 * 第一个能拿来对话的模型。
 *
 * 「第一个模型当默认」原先取的是排在最前的那个，而生图模型也是模型：往空的配置里拉一个以 `gemini-3.1-flash-image`
 * 开头的列表，之后每个新对话都发给了一个不会回话的模型。
 */
export function firstChatModelId(models: readonly ModelConfig[]): string | null {
	return models.find((model) => !isImageModel(model))?.id ?? null;
}

/**
 * 改动应用到一个供应商之后的它；什么都没变时原样返回同一个对象。
 * 默认模型不在这里收拾：被删的若是默认模型，agent 进程自己落到下一个可用的，调用方再按需把默认设成新加的第一个。
 */
export function applyModelChange(provider: ProviderEntry, change: ModelChange): { provider: ProviderEntry; added: ModelConfig[]; removedIds: Set<string> } {
	const remove = new Set(change.remove);
	const kept = provider.models.filter((model) => !remove.has(model.modelId));
	const keptIds = new Set(kept.map((model) => model.modelId));
	const added = cleanModelIds(change.add)
		.filter((id) => !keptIds.has(id) && !remove.has(id))
		.map((id) => importedModel(provider, id));
	const removedIds = new Set(provider.models.filter((model) => remove.has(model.modelId)).map((model) => model.id));
	if (added.length === 0 && kept.length === provider.models.length) return { provider, added, removedIds };
	return { provider: { ...provider, models: [...kept, ...added] }, added, removedIds };
}
