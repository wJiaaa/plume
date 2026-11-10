/**
 * 模型目录：一个模型的上下文窗口、最大输出、思考能力与档位、图片能力，以及参考价格，都从这里查。
 *
 * 数据来自 pi 的公开模型目录（https://pi.dev/api/models）。仓库里打包一份压缩过的快照
 * `catalog/model-catalog.json`，桌面主进程运行时定期拉最新的换上（`model-catalog-sync.ts`），
 * 所以离线也能用，联网时自动更新。这个文件不碰文件系统和网络——渲染进程也要用它。
 *
 * 目录只是参考：导入模型、在编辑器里搜索选中时，把条目的上限、能力、思考档位和价格一次性填进模型配置，
 * 之后配置归用户，目录更新不会改动它。用量页给没有配置价格的历史记录估算费用时也查这里。
 *
 * 自动匹配顺序：同一端点（Base URL）下的同名模型 → 按型号家族找厂商官方条目和 OpenRouter 的参考值。
 * 发送给供应商的模型 ID 从不改写。
 */

import snapshotJson from "./catalog/model-catalog.json" with { type: "json" };
import { thinkingOptionsFor } from "./ai/thinking-options.ts";
import { thinkingDialect } from "./ai/vendors/index.ts";
import { parseModelCatalog, type CatalogModel, type CatalogProvider, type ModelCatalogDocument } from "./model-catalog-format.ts";
import type { ModelConfig, ModelPricing, ProviderConfig } from "./types/provider.ts";

export type { CatalogModel, CatalogProvider, ModelCatalogDocument } from "./model-catalog-format.ts";

export interface CatalogMatch {
	provider: CatalogProvider;
	model: CatalogModel;
	match: "exact" | "alias" | "reference";
}

/** 从目录填进模型配置的那几项。 */
export type CatalogFill = Pick<ModelConfig, "contextWindow" | "maxOutputTokens" | "supportsThinking" | "thinkingOptions" | "supportsImages" | "supportsTools" | "pricing">;

/**
 * 目录里找不到时的初始值：新建模型和导入时没匹配上的模型用它。
 *
 * 能力全开：这一档接的是中转起的私有名字、刚发布的型号、自建端点，如今几乎都会思考、看图、调工具。
 * 猜错的代价不对等——开着而不支持，供应商回一个说得清楚的错；关着而支持，是能力凭空少一块还不报错。
 */
export const DEFAULT_MODEL_LIMITS: Omit<CatalogFill, "pricing"> = {
	contextWindow: 200_000,
	maxOutputTokens: 32_000,
	supportsThinking: true,
	supportsImages: true,
	supportsTools: true,
};

interface Indexed {
	document: ModelCatalogDocument;
	providers: Map<string, CatalogProvider>;
	/** 每个供应商：小写 ID → 条目，另收一份去掉 `vendor/` 前缀的写法（OpenRouter 等聚合商）。 */
	byProvider: Map<string, Map<string, CatalogModel>>;
	/** 规整后的端点地址 → 该端点下的模型索引。 */
	byEndpoint: Map<string, { provider: CatalogProvider; models: Map<string, CatalogModel> }[]>;
}

function index(document: ModelCatalogDocument): Indexed {
	const byProvider = new Map<string, Map<string, CatalogModel>>();
	const byEndpoint: Indexed["byEndpoint"] = new Map();
	for (const provider of document.providers) {
		const models = new Map<string, CatalogModel>();
		const endpoints = new Map<string, Map<string, CatalogModel>>();
		for (const model of provider.models) {
			const id = model.id.toLowerCase();
			const bare = id.replace(/^~/, "").split("/").at(-1) ?? id;
			if (!models.has(id)) models.set(id, model);
			if (!models.has(bare)) models.set(bare, model);
			const endpoint = normalizeEndpoint(model.baseUrl);
			if (!endpoint) continue;
			const local = endpoints.get(endpoint) ?? new Map<string, CatalogModel>();
			if (!local.has(id)) local.set(id, model);
			endpoints.set(endpoint, local);
		}
		byProvider.set(provider.id, models);
		for (const [endpoint, local] of endpoints) {
			byEndpoint.set(endpoint, [...(byEndpoint.get(endpoint) ?? []), { provider, models: local }]);
		}
	}
	return { document, providers: new Map(document.providers.map((provider) => [provider.id, provider])), byProvider, byEndpoint };
}

const BUNDLED = parseModelCatalog(snapshotJson);
let active = index(BUNDLED);

/** 当前生效的目录：打包的那份，或更新过的远程版本。 */
export function activeModelCatalog(): ModelCatalogDocument {
	return active.document;
}

/** 目录版本，进计价缓存的 key 和价格快照：目录一换，旧的估价重算。 */
export function modelCatalogVersion(): string {
	return `pi:${active.document.source.revision.replace(/^sha256-/, "").slice(0, 12)}`;
}

/**
 * 换上一份目录，只在它比当前的新时生效。返回是否真的换了。
 *
 * 按 `updatedAt` 比而不是无条件替换：应用升级后打包的快照可能比本地缓存的远程版本还新。
 */
export function installModelCatalog(document: ModelCatalogDocument): boolean {
	const current = active.document.source;
	if (document.source.revision === current.revision || Date.parse(document.source.updatedAt) < Date.parse(current.updatedAt)) return false;
	active = index(document);
	return true;
}

/** 测试用：回到打包的快照。 */
export function resetModelCatalog(): void {
	active = index(BUNDLED);
}

/**
 * 把端点地址规整成可比较的形式：小写主机、去掉查询和尾斜杠，再去掉末尾的 `/v1`。
 *
 * 请求地址是 `baseUrl` 再补 `/v1/...`（已经以 `/v1` 结尾就不重复），所以 `https://x/v1`
 * 和 `https://x` 是同一个端点；目录里 Anthropic 系不带 `/v1`、OpenAI 系带，统一去掉再比。
 */
function normalizeEndpoint(baseUrl: string): string | null {
	if (!baseUrl || baseUrl.includes("{")) return null;
	try {
		const url = new URL(baseUrl);
		return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/v1$/, "");
	} catch {
		return null;
	}
}

/** 型号家族的厂商官方供应商，中转上的同名模型按它取参考值。 */
function familyProvider(id: string): string | undefined {
	if (/^(gpt-|o[134](?:-|$))/.test(id)) return "openai";
	if (id.startsWith("claude-")) return "anthropic";
	if (id.startsWith("gemini-")) return "google";
	if (/^(kimi-|moonshot-)/.test(id)) return "moonshotai";
	if (id.startsWith("glm-")) return "zai";
	if (id.startsWith("deepseek-")) return "deepseek";
	if (id.startsWith("grok-")) return "xai";
	if (id.startsWith("minimax-")) return "minimax";
	if (id.startsWith("mimo-")) return "xiaomi";
	if (/^(mistral|magistral|codestral|devstral|ministral)/.test(id)) return "mistral";
	return undefined;
}

/** Only recognised decorations may be removed; unknown versions and paid/free variants stay distinct. */
function modelCandidates(id: string): string[] {
	let current = id.trim().toLowerCase().replace(/claude-(opus|sonnet|haiku|fable)-(\d+)\.(\d+)/, "claude-$1-$2-$3");
	const candidates = [current];
	const bare = current.split("/").at(-1);
	if (bare && bare !== current) candidates.push(bare);
	current = bare ?? current;
	const suffix = /[-_:](?:extra-low|minimal|low|medium|high|xhigh|max|ultra|thinking|reasoning|preview|latest|agent|tiered|\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;
	while (suffix.test(current)) {
		current = current.replace(suffix, "");
		candidates.push(current);
	}
	return candidates;
}

/** 四项价格全是 0 的是订阅制端点，不按次计费——当作没有价格，而不是「免费」。 */
function priced(model: CatalogModel): boolean {
	return model.inputPrice !== undefined && model.outputPrice !== undefined &&
		[model.inputPrice, model.outputPrice, model.cacheReadPrice ?? 0, model.cacheWritePrice ?? 0].some((value) => value > 0);
}

export function catalogModelFor(
	provider: Pick<ProviderConfig, "baseUrl">,
	modelId: string,
): CatalogMatch | null {
	const candidates = modelCandidates(modelId);
	const endpoint = normalizeEndpoint(provider.baseUrl);
	const local = endpoint ? active.byEndpoint.get(endpoint) ?? [] : [];
	for (const candidate of candidates) {
		for (const entry of local) {
			const model = entry.models.get(candidate);
			if (model) return { provider: entry.provider, model, match: candidate === modelId.trim().toLowerCase() ? "exact" : "alias" };
		}
	}
	const bare = modelId.trim().toLowerCase().split("/").at(-1) ?? modelId;
	// OpenRouter supplies reference values for families without an upstream API entry.
	const sources = [...new Set([familyProvider(bare), "openrouter"])].filter((id) => id !== undefined);
	for (const candidate of candidates) {
		for (const sourceId of sources) {
			const source = active.providers.get(sourceId);
			const model = active.byProvider.get(sourceId)?.get(candidate);
			if (source && model) return { provider: source, model, match: "reference" };
		}
	}
	return null;
}

export function catalogPricing(model: CatalogModel): ModelPricing | undefined {
	if (!priced(model)) return undefined;
	return {
		input: model.inputPrice!,
		output: model.outputPrice!,
		cacheRead: model.cacheReadPrice,
		cacheWrite: model.cacheWritePrice,
		tiers: model.tiers,
		source: "catalog",
	};
}

/**
 * 一个目录条目要填进模型配置的值。输出上限不超过窗口；全零价格的订阅制条目不填价格。
 *
 * 关不掉思考的模型（`vendors/` 的 `alwaysOn`）不给「关闭」这一档：目录里的档位不一定知道这一点，而界面上
 * 多一个点了没用的「关闭」，用户以为省了钱。给了端点就连端点一起看，规则可以按端点写。
 */
export function catalogFill(model: CatalogModel, provider?: Pick<ProviderConfig, "baseUrl">): CatalogFill {
	const levels = model.thinkingLevels && thinkingDialect(provider?.baseUrl ?? "", model.id).alwaysOn
		? model.thinkingLevels.filter((level) => level !== "off")
		: model.thinkingLevels;
	return {
		contextWindow: model.contextWindow,
		maxOutputTokens: Math.min(model.maxOutputTokens, model.contextWindow),
		supportsThinking: model.supportsThinking,
		...(model.supportsThinking && levels ? { thinkingOptions: thinkingOptionsFor(levels) } : {}),
		supportsImages: model.supportsImages,
		// pi 的目录只收编码代理用的对话模型，都能调工具，所以没有这一项。
		supportsTools: true,
		pricing: catalogPricing(model),
	};
}
