/**
 * 供应商列表存成文件，从一台机器带到另一台。
 *
 * 不止是 `JSON.stringify`：文件里带着 API key——这是 Plume 写出去的东西里唯一值得偷的——所以文件自己声明这一点
 * （`containsSecrets`），界面在写之前也要先说。读进来的文件来自这个程序看不见的地方，每个字段都逐个检查而不是
 * 直接断言类型：半残的条目一旦过了这一关，就同时进了模型选择、请求构造和设置文件。检查不过的条目丢掉而不是修补，
 * 丢了几条告诉界面，让它说明文件没有全部读懂。
 *
 * 读写都在 agent 进程里做，key 不经过渲染进程；界面只拿到预览（有没有 key），文件路径由主进程的对话框给。
 * 不认的字段（请求头、生图）读的时候丢掉。
 */

import type { ModelEntry, ProviderImportEntry, ProviderImportPreview } from "@plume/contract";
import type { ApiFormat, ModelPricing, ModelPricingTier } from "@plume/llm/types";
import { isMagpie } from "./magpie.ts";
import { checkProvider, type StoredProvider } from "./models.ts";

/** 先认出是不是供应商文件，再读里面的东西。 */
const BUNDLE_KIND = "plume.providers";
const BUNDLE_VERSION = 1;

const API_FORMATS = new Set<string>(["openai-responses", "anthropic-messages", "openai-chat-completions"]);

interface ProviderBundle {
	kind: string;
	version: number;
	exportedAt: string;
	/** 文件自己声明，而不是让拿到它的人（同事、同步盘、工单）读完每个供应商才知道它值多少。 */
	containsSecrets: boolean;
	providers: StoredProvider[];
}

type BundleParse = { ok: true; providers: StoredProvider[]; dropped: number } | { ok: false; problem: Exclude<ProviderImportPreview, { ok: true }>["problem"] };

/** 制表符缩进：人很可能会在编辑器里打开它。 */
export function serializeBundle(providers: StoredProvider[], now = new Date()): { text: string; containsSecrets: boolean } {
	const containsSecrets = providers.some((provider) => Boolean(provider.apiKey?.trim()));
	const bundle: ProviderBundle = { kind: BUNDLE_KIND, version: BUNDLE_VERSION, exportedAt: now.toISOString(), containsSecrets, providers };
	return { text: `${JSON.stringify(bundle, null, "\t")}\n`, containsSecrets };
}

export function parseBundle(text: string): BundleParse {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, problem: "not-json" };
	}
	if (!isRecord(raw) || raw.kind !== BUNDLE_KIND || !Array.isArray(raw.providers)) {
		return { ok: false, problem: "not-a-bundle" };
	}
	// 更新的版本整份拒绝，不读认得的那部分：版本只在旧的读法变错时才升，读一部分会得到一个看着配好了、其实没配好的供应商。
	if (typeof raw.version === "number" && raw.version > BUNDLE_VERSION) return { ok: false, problem: "too-new" };

	const providers: StoredProvider[] = [];
	let dropped = 0;
	for (const entry of raw.providers) {
		const provider = readProvider(entry);
		if (provider) providers.push(provider);
		else dropped += 1;
	}
	if (providers.length === 0) return { ok: false, problem: "no-providers" };
	return { ok: true, providers, dropped };
}

/** 导入每一项会做什么，在写任何东西之前算好。 */
export function planImport(incoming: StoredProvider[], existing: StoredProvider[]): ProviderImportEntry[] {
	const byId = new Map(existing.map((provider) => [provider.id, provider]));
	return incoming.map((provider) => {
		const current = byId.get(provider.id);
		const hasKey = Boolean(provider.apiKey?.trim());
		return {
			id: provider.id,
			name: provider.name,
			api: provider.api,
			baseUrl: provider.baseUrl,
			models: provider.models.length,
			kind: current ? "replace" : "new",
			hasKey,
			// 为手动去掉 key 再发出去的文件准备：拿没 key 的副本替换一个能用的供应商，会悄无声息地把它弄坏。
			keepsLocalKey: !hasKey && Boolean(current?.apiKey?.trim()),
		};
	});
}

/**
 * 一个列表里还没人用的名字。
 *
 * 两个同名供应商是两行分不清的东西，而且会传下去：两个模型同名时选择器靠供应商名区分，供应商再同名就没有可区分的了。
 * 「新供应商」每次按都是同一个名字，导入的条目 id 在这台机器上是新的、名字却来自另一台，两条路都会造出同名。
 * 用编号而不是 id 做后缀：要的是列表里读得懂。
 */
export function uniqueProviderName(taken: Iterable<string>, wanted: string): string {
	const used = new Set<string>();
	for (const name of taken) used.add(name.trim());
	const base = wanted.trim();
	if (!base || !used.has(base)) return wanted;
	for (let n = 2; ; n++) {
		const candidate = `${base} ${n}`;
		if (!used.has(candidate)) return candidate;
	}
}

/**
 * 选中的供应商并进已有的。同 id 的原地替换（保留位置和名字），新的追加在后面并避开重名。
 * 默认模型不用在这里收拾：它指向的模型不在了，`defaultModelOf` 自己落到第一个可用的。
 */
export function applyImport(existing: StoredProvider[], chosen: StoredProvider[]): StoredProvider[] {
	const byId = new Map(existing.map((provider) => [provider.id, provider]));
	const appended: StoredProvider[] = [];
	// 从已有的名字起算：替换同 id 的那一项就是那个供应商本身，和自己同名不算重名。
	const names = new Set(existing.map((provider) => provider.name.trim()));
	for (const provider of chosen) {
		const current = byId.get(provider.id);
		// 文件里 key 为空表示「没导出」，从不表示「清掉我已有的」。
		const merged = current && !provider.apiKey?.trim() ? { ...provider, ...(current.apiKey ? { apiKey: current.apiKey } : {}) } : provider;
		if (current) {
			byId.set(provider.id, merged);
			continue;
		}
		const name = uniqueProviderName(names, merged.name);
		names.add(name.trim());
		appended.push(name === merged.name ? merged : { ...merged, name });
	}
	return [...existing.map((provider) => byId.get(provider.id) ?? provider), ...appended];
}

/** 一个供应商：逐字段读出来，再过一遍保存时的校验（id 格式、地址、模型 id 不重复）。Magpie 的那一项不导入，它由 Magpie 管。 */
function readProvider(raw: unknown): StoredProvider | null {
	if (!isRecord(raw)) return null;
	const id = str(raw.id);
	const baseUrl = str(raw.baseUrl);
	if (!id || !baseUrl || isMagpie(id)) return null;
	const api = typeof raw.api === "string" && API_FORMATS.has(raw.api) ? (raw.api as ApiFormat) : "openai-responses";
	const models = Array.isArray(raw.models) ? raw.models.map(readModel).filter((model): model is ModelEntry => model !== null) : [];
	const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
	try {
		return checkProvider({
			id,
			name: str(raw.name) || id,
			api,
			baseUrl,
			// 停用着导出的照样停用；读不出来的默认启用，和手动新建一样。
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
			models,
			...(apiKey ? { apiKey } : {}),
		});
	} catch {
		return null;
	}
}

/**
 * 一个模型，连同重新推算代价高的字段（价格、思考档位）一起带过来。每项都按自己的字段重建而不是原样传，
 * 这样手改坏了的价格在这里丢掉，而不是以 `NaN` 进用量统计。
 */
function readModel(raw: unknown): ModelEntry | null {
	if (!isRecord(raw)) return null;
	const modelId = str(raw.modelId);
	if (!modelId) return null;
	const pricing = readPricing(raw.pricing);
	return {
		modelId,
		name: str(raw.name) || modelId,
		contextWindow: count(raw.contextWindow, 200_000),
		maxOutputTokens: count(raw.maxOutputTokens, 16_384),
		// 没写就是「有」，写了 false 才是「没有」：手写的、别处生成的配置通常只写 id 和地址，按缺席算不支持的话导进来的模型都不会调工具。
		supportsThinking: raw.supportsThinking !== false,
		supportsImages: raw.supportsImages !== false,
		supportsTools: raw.supportsTools !== false,
		...(pricing ? { pricing } : {}),
		...(Array.isArray(raw.thinkingOptions) ? { thinkingOptions: raw.thinkingOptions as ModelEntry["thinkingOptions"] } : {}),
		// 只在写了时带上：没写是「按名字判断」，手写的文件要的就是这个。
		...(typeof raw.imageOutput === "boolean" ? { imageOutput: raw.imageOutput } : {}),
	};
}

/** 只有每次算费用都要的输入、输出两项都在时才有价格。 */
function readPricing(raw: unknown): ModelPricing | undefined {
	if (!isRecord(raw)) return undefined;
	const input = rate(raw.input);
	const output = rate(raw.output);
	if (input === null || output === null) return undefined;
	const cacheRead = rate(raw.cacheRead);
	const cacheWrite = rate(raw.cacheWrite);
	const tiers = Array.isArray(raw.tiers) ? raw.tiers.map(readTier).filter((tier): tier is ModelPricingTier => tier !== null) : [];
	return {
		input,
		output,
		...(cacheRead !== null ? { cacheRead } : {}),
		...(cacheWrite !== null ? { cacheWrite } : {}),
		...(tiers.length > 0 ? { tiers } : {}),
		// 手填的价格是人敲的，优先于目录；其余的是一次目录查询，那边可以自己再查。
		...(raw.source === "manual" ? { source: "manual" as const } : {}),
	};
}

function readTier(raw: unknown): ModelPricingTier | null {
	if (!isRecord(raw)) return null;
	const aboveTokens = rate(raw.aboveTokens);
	const input = rate(raw.input);
	const output = rate(raw.output);
	if (aboveTokens === null || input === null || output === null) return null;
	const cacheRead = rate(raw.cacheRead);
	const cacheWrite = rate(raw.cacheWrite);
	return { aboveTokens, input, output, ...(cacheRead !== null ? { cacheRead } : {}), ...(cacheWrite !== null ? { cacheWrite } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 价格或门槛：有限且不为负，否则当没有。0 是真实的答案——免费。 */
function rate(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
