/**
 * 市场能列出的一切，从三处合成一张表：目录里的条目、本机已有的插件、agent 进程报告的插件状态。
 *
 * 同一个插件可能三处都有，卡片只想说「这是 todo，它做什么，你装了没有、开着没有」，不想先问它是从哪张表
 * 里来的，所以按目录名合并一次，合出来的那一条带着每一半：`entry` 是目录说它是什么，`installed` 是本机那份，
 * `status` 是 agent 进程里它现在的样子。
 */

import type { PluginStatus } from "@plume/contract";
import type { PluginKind } from "@plume/contract";
import type { InstalledPlugin, MarketEntry } from "../../shared/market.ts";

/** 没写货架的条目。不是谁选的分类，见 `shelves`。 */
export const UNFILED = " unfiled";

/** 货架的先后，固定一份；不在表里的排在后面，按条目多少。 */
// i18n-exempt：货架名是条目数据里的值（package.json 的 plume.category），这里只拿来排先后，不是界面文案。
const SHELF_ORDER: readonly string[] = [
	"开发",
	"工作流",
	"浏览器",
	"搜索",
	"文档",
	"数据",
	"设计",
	"办公",
	"协作",
	"思考",
	"科研",
	"云与运维",
	"安全",
	"媒体",
	"本机",
];

export interface CatalogItem {
	/** 目录名：条目 id、安装目录名、agent 进程里的 key，三处是同一个。 */
	key: string;
	/** 摆在「插件市场」页哪一类里。 */
	kind: PluginKind;
	name: string;
	description: string;
	logo?: string;
	category: string;
	version?: string;
	author?: string;
	keywords?: string[];
	homepage?: string;
	license?: string;
	/** 「试试这样问」：本机那份说的，装上才用得到。 */
	prompts?: string[];
	/** 技能合集带几个技能，只有目录里写了才有。 */
	skills?: number;
	/** 目录里有，能装、能更新。 */
	entry: MarketEntry | null;
	/** 本机有。 */
	installed: InstalledPlugin | null;
	/** agent 进程里的状态；刚装上还没加载完时没有。 */
	status: PluginStatus | undefined;
	/** 装的是市场里的，而目录里有更新的版本（主进程按版本号算好的，见 PluginUpdateState.outdated）。 */
	outdated: boolean;
}

export function isInstalled(item: CatalogItem): boolean {
	return item.installed !== null;
}

/** 随应用发的插件：市场不列，不能停用、卸载。 */
export function isBuiltin(item: CatalogItem): boolean {
	return item.installed?.source === "builtin";
}

/** 开着：agent 进程里是 active。停用、加载失败、还没加载都不算。 */
export function isEnabled(item: CatalogItem): boolean {
	return item.status?.state === "active";
}

/**
 * 合成一张表，每个插件只出现一次。
 *
 * 已装的说明优先：本机那份才是正在跑的东西，目录在它装上之后改了说明，不该把它改名。目录那一半照样挂上，
 * 更新、主页这些只有它知道。
 */
export function merge(entries: MarketEntry[], installed: InstalledPlugin[], statuses: PluginStatus[], outdated: readonly string[] = []): CatalogItem[] {
	const byKey = new Map<string, CatalogItem>();
	const statusOf = (key: string) => statuses.find((status) => status.key === key);
	const from = (info: MarketEntry | InstalledPlugin) => ({
		key: info.id,
		kind: info.kind,
		name: info.name,
		description: info.description,
		...(info.logo ? { logo: info.logo } : {}),
		category: info.category ?? UNFILED,
		...(info.version ? { version: info.version } : {}),
		...(info.author ? { author: info.author } : {}),
		...(info.keywords ? { keywords: info.keywords } : {}),
		...(info.homepage ? { homepage: info.homepage } : {}),
		...(info.license ? { license: info.license } : {}),
		...(info.prompts ? { prompts: info.prompts } : {}),
		...(info.skills === undefined ? {} : { skills: info.skills }),
	});
	for (const plugin of installed) {
		byKey.set(plugin.id, { ...from(plugin), entry: null, installed: plugin, status: statusOf(plugin.id), outdated: false });
	}
	for (const entry of entries) {
		const existing = byKey.get(entry.id);
		if (!existing) {
			byKey.set(entry.id, { ...from(entry), entry, installed: null, status: undefined, outdated: false });
			continue;
		}
		existing.entry = entry;
		// 只填空：本机那份说了的，以它为准。
		if (!existing.description) existing.description = entry.description;
		if (existing.category === UNFILED && entry.category) existing.category = entry.category;
		existing.logo ??= entry.logo;
		existing.homepage ??= entry.homepage;
		existing.license ??= entry.license;
		existing.keywords ??= entry.keywords;
		existing.skills ??= entry.skills;
		existing.outdated = existing.installed?.source === "market" && outdated.includes(entry.id);
	}
	return [...byKey.values()];
}

/** 按货架分组，顺序固定：表里的货架在前，其余按条目多少，没写货架的最后。货架里按名字排。 */
export function shelves(items: CatalogItem[]): { category: string; items: CatalogItem[] }[] {
	const groups = new Map<string, CatalogItem[]>();
	for (const item of items) {
		const list = groups.get(item.category);
		if (list) list.push(item);
		else groups.set(item.category, [item]);
	}
	const rank = (category: string) => {
		const index = SHELF_ORDER.indexOf(category);
		return index === -1 ? SHELF_ORDER.length : index;
	};
	return [...groups.entries()]
		.sort(([a, left], [b, right]) => {
			if (a === UNFILED || b === UNFILED) return a === UNFILED ? 1 : -1;
			return rank(a) - rank(b) || right.length - left.length || a.localeCompare(b);
		})
		.map(([category, list]) => ({ category, items: list.sort(byName) }));
}

/** 目录不记安装量，按名字排，来回看顺序不变。 */
export function byName(a: CatalogItem, b: CatalogItem): number {
	return a.name.localeCompare(b.name);
}
