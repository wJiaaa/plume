/**
 * 哪个模型是谁的。
 *
 * 一个中转能提供五家的模型，两个供应商也能用同一个名字提供同一个模型，key、端点、上下文窗口却各不相同。
 * 平铺一列名字的话「grok-4.6」会一模一样地出现两次，选哪个全凭运气。
 *
 * 算法放在这里、和绘制分开：「哪些行有歧义」「搜索匹配什么」是规则，只写成 JSX 的规则没法测。
 */

import { isImageModel } from "@plume/llm/image-models";
import { translate } from "@plume/ui";
import { brandOf, type Brand } from "./model-brand.ts";
import type { ModelConfig, ProviderEntry, ModelsState } from "./store.ts";

export interface ModelGroup {
	provider: ProviderEntry;
	models: ModelConfig[];
}

/** 菜单里的一行，按绘制顺序。 */
export interface ModelRow {
	provider: ProviderEntry;
	model: ModelConfig;
}

/**
 * 启用且有模型的供应商，按配置的顺序。
 *
 * 故意不按「最近使用」排，也不把当前供应商提到前面：列表是人记位置的地方，在指针下自己挪动的列表省下的那一行
 * 抵不上它的代价。没有模型的供应商不出现——一个下面什么都没有的标题读起来像加载失败。
 */
export function groupModels(providers: ProviderEntry[] | undefined, kind: "chat" | "image" = "chat"): ModelGroup[] {
	/*
	 * 对话的选择器不列生图模型，生图的选择器只列它们。生图模型接不了对话——选了它，每一轮第一次请求就失败；
	 * 画不了图的模型交给生图，每张图都失败。
	 */
	const wanted = (model: ModelConfig) => isImageModel(model) === (kind === "image");
	return (providers ?? [])
		.filter((provider) => provider.enabled)
		.map((provider) => ({ provider, models: provider.models.filter(wanted) }))
		.filter((group) => group.models.length > 0);
}

/** 所有行，按绘制顺序——数字键数的就是这个。 */
export function flattenGroups(groups: ModelGroup[]): ModelRow[] {
	return groups.flatMap((group) => group.models.map((model) => ({ provider: group.provider, model })));
}

/**
 * 星标的模型，按星标的先后。
 *
 * 不按供应商排：常用列表是人亲手排的，按别的重排会挪走放好的行。已经找不到的 id（供应商停用、模型删了）跳过，
 * 不画成一行死行。
 */
export function favouriteRows(groups: ModelGroup[], favourites: string[] | undefined): ModelRow[] {
	if (!favourites?.length) return [];
	const byId = new Map(flattenGroups(groups).map((row) => [row.model.id, row]));
	const rows: ModelRow[] = [];
	for (const id of favourites) {
		const row = byId.get(id);
		if (row) rows.push(row);
	}
	return rows;
}

/** 加或去掉一颗星，顺序不变。加在末尾而不是开头：每星标一次就重排的常用列表，每次打开都得重读。 */
export function toggleFavourite(favourites: string[] | undefined, id: string): string[] {
	const current = favourites ?? [];
	return current.includes(id) ? current.filter((each) => each !== id) : [...current, id];
}

/**
 * 匹配搜索的分组，每组只留匹配的行。
 *
 * 供应商名也匹配：输一个厂商名就收窄到那一家，配了四个中转的人实际就是这么搜的。不分大小写、忽略空格和连字符，
 * 因为模型 id 的写法五花八门（`GLM-5.3`、`glm 5.3`）。
 */
export function filterGroups(groups: ModelGroup[], query: string): ModelGroup[] {
	const needle = query
		.trim()
		.toLowerCase()
		.replace(/[\s_-]/g, "");
	if (!needle) return groups;
	const hit = (text: string) =>
		text
			.toLowerCase()
			.replace(/[\s_-]/g, "")
			.includes(needle);

	return groups
		.map((group) => ({
			provider: group.provider,
			models: hit(group.provider.name) ? group.models : group.models.filter((model) => hit(model.name) || hit(model.modelId)),
		}))
		.filter((group) => group.models.length > 0);
}

/** 选择器左侧那一列按谁做的分：认得的品牌，或者谁都不认领的「其他」。 */
export type House = Brand | "other";

function houseOf(model: ModelConfig): House {
	return brandOf(model.modelId, model.name) ?? "other";
}

/** 出现过的厂商，按第一次出现的顺序，「其他」放最后。不按数量排：中转多加两个模型，标就换位置的话，每次都得重新读。 */
export function housesOf(groups: ModelGroup[]): House[] {
	const seen = new Set<House>();
	for (const row of flattenGroups(groups)) seen.add(houseOf(row.model));
	const houses = [...seen].filter((house) => house !== "other");
	return seen.has("other") ? [...houses, "other"] : houses;
}

/** 只留一家的模型，仍按提供它们的供应商分组：厂商定了，剩下要选的就是走哪个供应商——同一个 Claude 走两个中转是两把 key、两份账单。 */
export function filterHouse(groups: ModelGroup[], house: House): ModelGroup[] {
	return groups
		.map((group) => ({ provider: group.provider, models: group.models.filter((model) => houseOf(model) === house) }))
		.filter((group) => group.models.length > 0);
}

/**
 * 不止一个供应商提供的模型名。
 *
 * 比的是显示名而不是 modelId：混淆完全是视觉上的。两行都写 `grok-4.6` 就分不清，不管线上的 id 是什么；
 * `Grok 4.6 (fast)` 和 `grok-4.6` 分得清，哪怕 id 一样。
 */
export function ambiguousNames(groups: ModelGroup[]): Set<string> {
	const seen = new Map<string, string>();
	const clashes = new Set<string>();
	for (const group of groups) {
		for (const model of group.models) {
			const key = model.name.trim().toLowerCase();
			const owner = seen.get(key);
			if (owner === undefined) seen.set(key, group.provider.id);
			else if (owner !== group.provider.id) clashes.add(key);
		}
	}
	return clashes;
}

/**
 * 输入框说它在用什么，以及光说名字够不够认出它。
 *
 * provider 总是知道的；ambiguous 决定要不要显示它。每个按钮都写上供应商是诚实但读不下去的——输入框那一行只放得下
 * 一个短标签——所以只在只写模型名会造成误解时才写。
 */
export function modelIdentity(
	settings: ModelsState | undefined,
	modelId: string | null | undefined,
): { model: ModelConfig; provider: ProviderEntry; ambiguous: boolean } | null {
	if (!settings || !modelId) return null;
	for (const provider of settings.providers) {
		const model = provider.models.find((each) => each.id === modelId);
		if (!model) continue;
		const clashes = ambiguousNames(groupModels(settings.providers));
		return { model, provider, ambiguous: clashes.has(model.name.trim().toLowerCase()) };
	}
	return null;
}

/** 「BigModel · GLM-5.3 · 128K 上下文」——完整的答案，给放得下的悬停提示。 */
export function modelTooltip(identity: { model: ModelConfig; provider: ProviderEntry } | null, window: (tokens: number) => string): string {
	if (!identity) return translate("modelGrouping.pick");
	return `${identity.provider.name} · ${identity.model.name} · ${window(identity.model.contextWindow)} ${translate("modelGrouping.contextSuffix")}`;
}
