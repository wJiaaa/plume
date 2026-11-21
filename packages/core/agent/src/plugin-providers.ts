/**
 * 插件经 `ctx.providers` 提供的模型供应商（见 `PluginProvider`）：每次读模型设置时按登记先后接在人自己的供应商后面，
 * 标上 `managedBy`。写盘、加密 key、导出都只碰人自己的（`fileSettings` 按 `managedBy` 拿掉它们），设置页的改和删交回插件。
 */

import type { ModelEntry, PluginProvider, ProviderSource } from "@plume/contract";
import type { ModelPricing } from "@plume/llm/types";
import { catalogModelFor, catalogPricing } from "@plume/llm/model-catalog";
import { errorText } from "@plume/loop";
import { text } from "./i18n.ts";
import { checkProvider, type StoredProvider } from "./models.ts";

export class PluginProviderSources {
	private sources: { plugin: string; source: ProviderSource }[] = [];
	/** 说过的诊断：每次读设置都合并一遍，同一句不每次都记。 */
	private readonly warned = new Set<string>();

	/** `changed`：供应商多了、少了，告诉界面重取模型设置。 */
	constructor(
		private readonly warn: (message: string) => void,
		private readonly changed: () => void,
	) {}

	/** 登记一个插件的来源；返回撤下它的函数，插件停用时调。 */
	add(plugin: string, source: ProviderSource): () => void {
		const entry = { plugin, source };
		this.sources = [...this.sources, entry];
		this.changed();
		return () => {
			this.sources = this.sources.filter((item) => item !== entry);
			this.changed();
		};
	}

	/** 人自己的供应商后面接上各插件的。不合格的、和已有的重名的跳过并记一句，保留已有的。 */
	merge(own: readonly StoredProvider[]): StoredProvider[] {
		const out = [...own];
		for (const { plugin, source } of this.sources) {
			let listed: unknown;
			try {
				listed = source.list();
			} catch (error) {
				this.log(`插件 ${plugin} 列供应商失败：${errorText(error)}`);
				continue;
			}
			for (const raw of Array.isArray(listed) ? (listed as PluginProvider[]) : []) {
				let provider: StoredProvider;
				try {
					provider = checkProvider({ ...raw, models: raw.models.map((model) => withPricing(model, raw.baseUrl)) });
				} catch (error) {
					this.log(`插件 ${plugin} 的供应商 ${String(raw?.id)} 不合格，已跳过：${errorText(error)}`);
					continue;
				}
				if (out.some((other) => other.id === provider.id)) {
					this.log(`插件 ${plugin} 的供应商 ${provider.id} 和已有的供应商重名，保留已有的`);
					continue;
				}
				out.push({ ...provider, managedBy: plugin });
			}
		}
		return out;
	}

	async save(plugin: string, provider: PluginProvider): Promise<void> {
		await this.sourceOf(plugin, provider.id).save(provider);
	}

	async remove(plugin: string, providerId: string): Promise<void> {
		await this.sourceOf(plugin, providerId).remove(providerId);
	}

	private sourceOf(plugin: string, providerId: string): ProviderSource {
		const found = this.sources.find((entry) => entry.plugin === plugin && entry.source.list().some((provider) => provider.id === providerId));
		// 读设置和改设置之间插件停用了、或不再提供它。
		if (!found) throw new Error(text("provider.notFound", { id: providerId }));
		return found.source;
	}

	/** 记一句诊断，同一句只记一次。 */
	private log(message: string): void {
		if (this.warned.has(message)) return;
		this.warned.add(message);
		this.warn(message);
	}
}

/**
 * 价格不是本体认的形状（按百万 token 的美元数）时不用它：算出来是 NaN，写花销时撞上 `spend.cost` 的非空约束，整条回复存不进去。
 * 不用的和没带的，按网关地址和模型 id 从模型目录补参考价，和新建模型时自动填的是同一套；目录里也没有就不带价格。
 */
function withPricing(model: ModelEntry, baseUrl: string): ModelEntry {
	const { pricing, ...rest } = model;
	if (usablePricing(pricing)) return model;
	const found = catalogModelFor({ baseUrl }, model.modelId);
	const reference = found ? catalogPricing(found.model) : undefined;
	return reference ? { ...rest, pricing: reference } : rest;
}

function usablePricing(pricing: unknown): pricing is ModelPricing {
	if (!pricing || typeof pricing !== "object") return false;
	const { input, output, cacheRead, cacheWrite } = pricing as Record<string, unknown>;
	const rate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
	return rate(input) && rate(output) && (cacheRead === undefined || rate(cacheRead)) && (cacheWrite === undefined || rate(cacheWrite));
}
