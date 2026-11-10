/**
 * agent 和装配它的应用之间的约定：应用提供要加载的插件，接收日志。
 */

/** 待加载的插件。load 导入逻辑入口，返回模块的默认导出。 */
export interface PluginEntry {
	/** 出错时用来指认插件；拿不到名字时（导入失败、导出不合法）状态里也用它。 */
	key: string;
	load(): Promise<unknown>;
	/** 界面入口的地址。 */
	ui?: string;
	/** 随应用发的插件，见 `PluginStatus.builtin`。 */
	builtin?: boolean;
	/** 插件目录（`package.json` 所在处），经 `ctx.plugins.list()` 告诉别的插件。只测宿主时可以不给。 */
	dir?: string;
}

export type Log = (source: string, level: "info" | "warn" | "error", message: string) => void;
