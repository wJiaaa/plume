/**
 * 界面侧的服务（`ui.provide` / `ui.useService`）：插件的界面入口之间按名字配合，宿主只记账，不认服务名。
 *
 * 后提供的生效，撤下后前一个恢复；不照逻辑侧「非内置优先、先加载的生效」那套：界面入口按逻辑入口的加载顺序（先内置、再本地上传和市场的）
 * 装上，后提供的生效就已经让装上的插件换掉内置的实现；也没有 `inject`，没人提供时用的一方拿到 undefined，自己不给那个入口。
 * 单独一个模块、不碰界面：登记的先后要在测试里直接跑。
 */

interface Entry {
	plugin: string;
	name: string;
	service: unknown;
}

let entries: Entry[] = [];

export function provideUiService(plugin: string, name: unknown, service: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof name !== "string" || name === "") throw new Error("ui.provide 需要服务名");
	if ((typeof service !== "object" && typeof service !== "function") || service === null) throw new Error(`ui.provide 的服务 ${name} 需要一个实现`);
	entries = [...entries.filter((entry) => entry.plugin !== plugin || entry.name !== name), { plugin, name, service }];
}

/** 插件停用时撤下它提供的，前一个恢复。 */
export function removeUiServices(plugin: string): void {
	entries = entries.filter((entry) => entry.plugin !== plugin);
}

/** 现在生效的那一份：最后提供的。 */
export function uiService(name: string): unknown {
	return entries.findLast((entry) => entry.name === name)?.service;
}
