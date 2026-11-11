/**
 * 「插件市场」页的状态：agent 进程报告的插件状态、主进程读到的目录和本机插件、更新状态，看的是哪一类，以及打开的是
 * 哪一个插件的详情页。侧栏那一行的更新数目和市场页读同一份，才不会一处说装了、一处还说没装。
 */

import type { AgentService, PluginStatus } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import { translate } from "@plume/ui";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { MarketResult, MarketState, PluginUpdateState } from "../../shared/market.ts";
import { loadPluginUis } from "../plugins.tsx";
import { type CatalogItem, merge } from "./catalog.ts";

export type MarketNotice = { tone: "error" | "note"; text: string };

/** 「插件市场」的三类：插件由产品画，技能、连接器由管它们的插件画（`page: "extensions-skills"`、`"extensions-connectors"`）。 */
export type MarketTab = "plugins" | "skills" | "connectors";

/** 由管它们的插件画「已安装」的那两类。 */
export type ExtensionTab = Exclude<MarketTab, "plugins">;

/** 筛选条上「已安装」那一颗。和货架的 UNFILED 一样前面带空格，不会撞上哪个货架的名字。 */
export const INSTALLED = " installed";

interface MarketStore {
	plugins: PluginStatus[];
	market?: MarketState;
	/** 读目录还没回来。 */
	loading: boolean;
	/** 看的是哪一类。 */
	tab: MarketTab;
	/** 「技能」「连接器」两类各自的筛选：INSTALLED 是本机有的，null 是市场里的全部，别的是某个货架。 */
	filters: Record<ExtensionTab, string | null>;
	/** 「技能 › 已安装」看的是哪个项目的技能（目录），null 是只看个人的。活在这次运行里，离开再回来还停在上次那个。 */
	skillsProject: string | null;
	/** 「已安装」页头的刷新点了几次：管它们的插件那一节跟着重读。 */
	refreshKey: number;
	/** 市场里打开的详情页，按目录名。 */
	focus: string | null;
	updates?: PluginUpdateState;
	notice?: MarketNotice;
}

let store: MarketStore = {
	plugins: [],
	loading: false,
	tab: "plugins",
	filters: { skills: null, connectors: null },
	skillsProject: null,
	refreshKey: 0,
	focus: null,
};
const listeners = new Set<() => void>();
let agent: Remote<AgentService>;

function set(patch: Partial<MarketStore>): void {
	store = { ...store, ...patch };
	for (const listener of listeners) listener();
}

export function useMarketStore(): MarketStore {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => store,
	);
}

/** 插件名（`plume.side-chat`）→ 插件市场里的显示名；停用、卸载了或还没读到时没有。 */
export function usePluginDisplayName(): (plugin: string) => string | undefined {
	const catalog = useCatalog();
	return useCallback((plugin: string) => catalog.find((item) => item.status?.name === plugin)?.name, [catalog]);
}

/** 合好的目录，见 catalog.ts。 */
export function useCatalog(): CatalogItem[] {
	const { market, plugins, updates } = useMarketStore();
	const outdated = (updates ?? market?.updates)?.outdated;
	return useMemo(
		() =>
			merge(
				market?.entries ?? [],
				market?.installed ?? [],
				plugins,
				outdated?.map((item) => item.id),
			),
		[market, plugins, outdated],
	);
}

export function startMarket(service: Remote<AgentService>): void {
	agent = service;
	window.plume.market.onChanged((updates) => set({ updates }));
	agent.listPlugins().then(
		(plugins) => set({ plugins }),
		(error: unknown) => console.error("没拿到插件状态：", error),
	);
	// 侧栏的待更新数要在打开市场之前就有。
	void reloadMarket();
}

/** agent 进程推来的插件状态：界面入口跟着装上、撤下，市场和设置页重读一次本机插件。 */
export function pluginsChanged(plugins: PluginStatus[]): void {
	set({ plugins });
	void loadPluginUis(plugins, agent);
	void reloadMarket();
}

/** 重读目录和本机插件；主进程顺便对一遍账，自动更新开着就更新。 */
export async function reloadMarket(): Promise<void> {
	set({ loading: true });
	try {
		const market = await window.plume.market.read();
		// 连不上市场时目录是上次读到的（或空的），说一声；已装的插件照常列着。
		const notice = market.catalogError ? { tone: "error" as const, text: translate("market.unreachable", { reason: market.catalogError }) } : undefined;
		set({ market, updates: market.updates, loading: false, ...(notice ? { notice } : {}) });
	} catch (error) {
		set({ loading: false, notice: { tone: "error", text: errorText(error) } });
	}
}

/** 打开一个插件的详情（null 是回到网格）。看的是哪一类不动：从哪一类点进去的，返回时回到哪一类。 */
export function focusPlugin(key: string | null): void {
	set({ focus: key });
}

/** 换到另一类；开着的详情页一起关掉。 */
export function setMarketTab(tab: MarketTab): void {
	set({ tab, focus: null });
}

export function setExtensionFilter(tab: ExtensionTab, filter: string | null): void {
	set({ filters: { ...store.filters, [tab]: filter } });
}

export function setSkillsProject(skillsProject: string | null): void {
	set({ skillsProject });
}

export function refreshInstalled(): void {
	set({ refreshKey: store.refreshKey + 1 });
}

export function setMarketNotice(notice: MarketNotice | undefined): void {
	set({ notice });
}

/** 装、卸、更新的结果翻成一句话；成功时没有话说。 */
function resultText(name: string, result: MarketResult): string | undefined {
	if (result.ok) return undefined;
	const message =
		result.error === "failed"
			? result.message
			: translate(
					result.error === "local"
						? "market.localOwned"
						: result.error === "builtin"
							? "market.builtinOwned"
							: result.error === "invalid"
								? "market.notAPlugin"
								: "market.notInCatalog",
				);
	return translate("install.failedWith", { name, message });
}

export async function installPlugin(item: CatalogItem): Promise<boolean> {
	return report(item.name, await window.plume.market.install(item.key));
}

/** 「从文件夹安装」：人选一个构建好的插件文件夹，装上后打开它的详情；取消了什么都不做。 */
export async function installFromFolder(): Promise<void> {
	const dir = await window.plume.pickFolder(translate("market.pickPluginFolder"));
	if (!dir) return;
	// 和主进程一样，文件夹名就是插件的目录名；Windows 的路径用反斜杠分隔。
	const id = dir.split(/[/\\]/).pop() ?? dir;
	if (await report(id, await window.plume.market.installFolder(dir))) focusPlugin(id);
}

export async function uninstallPlugin(item: CatalogItem): Promise<boolean> {
	return report(item.name, await window.plume.market.uninstall(item.key));
}

/** 更新这几个（缺省全部落后的）；失败的逐个说。 */
export async function updatePlugins(keys?: string[]): Promise<void> {
	const updates = await window.plume.market.update(keys);
	set({ updates });
	const failed = updates.failed.filter((failure) => !keys || keys.includes(failure.id));
	if (failed.length > 0) {
		set({
			notice: { tone: "error", text: failed.map((failure) => translate("install.failedWith", { name: failure.name, message: failure.message })).join("\n") },
		});
	}
	await reloadMarket();
}

export async function setAutoUpdate(auto: boolean): Promise<void> {
	set({ updates: await window.plume.market.setAutoUpdate(auto) });
	await reloadMarket();
}

/** 开关一个插件，立即生效；新的状态经 plugins 事件回来。`label` 是出错时说给人听的名字。 */
export async function setPluginEnabled(name: string, label: string, enabled: boolean): Promise<void> {
	try {
		await agent.setPluginEnabled(name, enabled);
	} catch (error) {
		set({ notice: { tone: "error", text: translate("install.failedWith", { name: label, message: errorText(error) }) } });
	}
}

async function report(name: string, result: MarketResult): Promise<boolean> {
	const text = resultText(name, result);
	if (text) set({ notice: { tone: "error", text } });
	await reloadMarket();
	return result.ok;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
