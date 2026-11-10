/**
 * 模型目录的数据格式：类型、校验，以及把 pi 的原始目录压成这个格式。
 *
 * 单独成文件而不放在 `model-catalog.ts`：那边一加载就要校验打包的快照，生成快照的脚本和远程同步
 * 不能依赖一份可能还是旧格式的快照。这里没有状态，也不碰文件系统和网络。
 */

import type { ModelPricingTier, ThinkingLevel } from "./types/provider.ts";
import { isRecord } from "./utils/record.ts";

/** 唯一的目录来源：pi 的公开模型目录。 */
export const MODEL_CATALOG_URL = "https://pi.dev/api/models";

export interface CatalogModel {
	id: string;
	name: string;
	/** 这个条目所在端点。个别条目为空或带占位符，那样的只能按型号参考，匹配不到端点。 */
	baseUrl: string;
	contextWindow: number;
	maxOutputTokens: number;
	supportsThinking: boolean;
	/** 可选的思考档位，按 pi 的 `thinkingLevelMap` 折算（见 `thinkingLevels`）。只在支持思考时有。 */
	thinkingLevels?: ThinkingLevel[];
	supportsImages: boolean;
	inputPrice?: number;
	outputPrice?: number;
	cacheReadPrice?: number;
	cacheWritePrice?: number;
	tiers?: ModelPricingTier[];
}

export interface CatalogProvider {
	id: string;
	models: CatalogModel[];
}

export interface ModelCatalogDocument {
	/** 3：条目带上思考档位。旧格式的缓存整份不认，下次同步重新拉。 */
	schema: 3;
	source: {
		name: string;
		url: string;
		/** 上游给的目录版本号（`x-pi-model-catalog-revision`），也进计价缓存的 key。 */
		revision: string;
		/** 上游的 `last-modified`：远程目录只在比当前的新时才换上。 */
		updatedAt: string;
	};
	providers: CatalogProvider[];
}

const positive = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
const price = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);

/** 校验一份目录。远程拉来的内容走同一道校验，不合法就整份拒绝，不会半套生效。 */
export function parseModelCatalog(value: unknown): ModelCatalogDocument {
	if (!isRecord(value) || value.schema !== 3) throw new Error("不支持的模型目录格式");
	const source = value.source;
	if (!isRecord(source) || typeof source.revision !== "string" || typeof source.updatedAt !== "string" || Number.isNaN(Date.parse(source.updatedAt))) {
		throw new Error("模型目录缺少版本信息");
	}
	if (!Array.isArray(value.providers) || value.providers.length === 0) throw new Error("模型目录为空");
	for (const provider of value.providers) {
		if (!isRecord(provider) || typeof provider.id !== "string" || !Array.isArray(provider.models)) throw new Error("供应商条目不合法");
		for (const model of provider.models) {
			const ok = isRecord(model) && typeof model.id === "string" && typeof model.name === "string" && typeof model.baseUrl === "string" &&
				positive(model.contextWindow) && positive(model.maxOutputTokens) &&
				typeof model.supportsThinking === "boolean" && typeof model.supportsImages === "boolean" &&
				(model.thinkingLevels === undefined || (Array.isArray(model.thinkingLevels) && model.thinkingLevels.every((level) => typeof level === "string"))) &&
				[model.inputPrice, model.outputPrice, model.cacheReadPrice, model.cacheWritePrice].every(price);
			if (!ok) throw new Error(`模型条目不合法：${provider.id}/${isRecord(model) ? String(model.id) : "?"}`);
		}
	}
	return value as unknown as ModelCatalogDocument;
}

function rate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tiers(value: unknown): ModelPricingTier[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.flatMap((tier): ModelPricingTier[] => {
		if (!isRecord(tier)) return [];
		const aboveTokens = rate(tier.inputTokensAbove);
		const input = rate(tier.input);
		const output = rate(tier.output);
		if (aboveTokens === undefined || input === undefined || output === undefined) return [];
		return [{ aboveTokens, input, output, cacheRead: rate(tier.cacheRead), cacheWrite: rate(tier.cacheWrite) }];
	});
	return result.length > 0 ? result.sort((a, b) => a.aboveTokens - b.aboveTokens) : undefined;
}

/** pi 认的档位，从浅到深。 */
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * pi 条目的 `thinkingLevelMap` 折算成可选档位，规则照 pi 自己的 `getSupportedThinkingLevels`：
 * 值为 `null` 是不支持；缺省时 `xhigh`/`max` 不支持、其余支持；字符串是实际发给接口的值。
 *
 * 按档位名原样发送，所以只收接口值就是档位名本身的那些。映射到别的档位的（Copilot 上
 * `minimal` 实际发 `low`）去掉：留着它只是菜单里多一档和相邻档一模一样的。`off` 例外，关思考
 * 怎么发是适配器的事，这里只关心它能不能关。
 */
function thinkingLevels(entry: Record<string, unknown>): ThinkingLevel[] {
	const map = isRecord(entry.thinkingLevelMap) ? entry.thinkingLevelMap : {};
	return PI_LEVELS.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (mapped === undefined) return level !== "xhigh" && level !== "max";
		return level === "off" || (typeof mapped === "string" && mapped.toLowerCase() === level);
	});
}

/**
 * pi 目录（`{ 供应商 id: { 模型 id: 条目 } }`）压成自己的目录格式，只留上限、思考与档位、图片、端点和价格。
 * 字段不全的条目跳过，不猜。
 */
export function compactPiCatalog(raw: unknown, source: ModelCatalogDocument["source"]): ModelCatalogDocument {
	if (!isRecord(raw)) throw new Error("模型目录不是对象");
	const providers = Object.entries(raw).flatMap(([id, entries]) => {
		if (!isRecord(entries)) return [];
		const models = Object.values(entries).flatMap((entry): CatalogModel[] => {
			if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) return [];
			const { contextWindow, maxTokens } = entry;
			if (!Number.isInteger(contextWindow) || !Number.isInteger(maxTokens) || (contextWindow as number) <= 0 || (maxTokens as number) <= 0) return [];
			const cost = isRecord(entry.cost) ? entry.cost : {};
			const model: CatalogModel = {
				id: entry.id,
				name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
				baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
				contextWindow: contextWindow as number,
				maxOutputTokens: maxTokens as number,
				supportsThinking: entry.reasoning === true,
				...(entry.reasoning === true ? { thinkingLevels: thinkingLevels(entry) } : {}),
				supportsImages: Array.isArray(entry.input) && entry.input.includes("image"),
			};
			const prices = { inputPrice: rate(cost.input), outputPrice: rate(cost.output), cacheReadPrice: rate(cost.cacheRead), cacheWritePrice: rate(cost.cacheWrite), tiers: tiers(cost.tiers) };
			for (const [key, value] of Object.entries(prices)) if (value !== undefined) Object.assign(model, { [key]: value });
			return [model];
		});
		return models.length > 0 ? [{ id, models }] : [];
	});
	return parseModelCatalog({ schema: 3, source, providers });
}
