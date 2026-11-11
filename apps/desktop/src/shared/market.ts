/**
 * 插件市场在主进程和渲染进程之间的约定。
 *
 * 目录在网上：插件仓库 plume-plugins 发到 GitHub Pages 的 marketplace.json（见 main/market-remote.ts），说明来自
 * 各插件的 package.json 和 README.md。装上是下载这台机器的那份包、核对后解进安装目录（~/.plume/plugins/<目录名>），
 * agent 进程随即加载；卸载删掉那个目录。按版本号判断有没有更新：发出去的版本不可变。
 */

import type { PluginKind } from "@plume/contract";

/** 条目和已装插件共有的说明，读自插件的 package.json 和 icon.png（目录里的条目由市场的索引转述），读法见 `@plumeai/plugin-sdk/manifest`。 */
export interface MarketInfo {
	/** 目录名：条目的 id，也是安装目录名和 plume-plugin:// 的主机名。 */
	id: string;
	/** 摆在「插件市场」页哪一类里：插件、技能、连接器，`plume.kind`，没写是插件。 */
	kind: PluginKind;
	/** 显示名，`plume.displayName`，没写时用目录名。 */
	name: string;
	description: string;
	/** 根目录 icon.png 的 PNG data URL；没提供或文件无效时省略。 */
	logo?: string;
	/** 市场按它判断更新：目录里的比装下的新就是有更新。 */
	version?: string;
	author?: string;
	/** 货架，`plume.category`。 */
	category?: string;
	keywords?: string[];
	homepage?: string;
	license?: string;
	/** 详情页「试试这样问」的几句话，`plume.defaultPrompt`：装上并开着时列出，点一句开新对话、写进输入框。 */
	prompts?: string[];
}

/** 目录里的一个条目。 */
export type MarketEntry = MarketInfo;

/** 本机已有的一个插件。 */
export interface InstalledPlugin extends MarketInfo {
	dir: string;
	/** 发给插件的文件（package.json、README.md、icon.png、dist/、skills/）的指纹：文件变了（重新构建、重新装）它就变。 */
	hash: string;
	/**
	 * market：从市场装进安装目录的，可以更新、卸载；upload：本地上传进本地上传目录的，可以卸载，不跟市场更新；
	 * local：PLUME_PLUGIN_PATHS 下直接放的，市场不管它的文件；builtin：随应用发的，不在市场里列，不能卸载、停用。
	 */
	source: "market" | "upload" | "local" | "builtin";
}

/** 自动更新和「谁落后了」：主进程算好，有变化就推给窗口。 */
export interface PluginUpdateState {
	outdated: { id: string; name: string; version?: string }[];
	/** 自动更新开着没有，缺省开。 */
	auto: boolean;
	/** 正在更新的条目 id。 */
	updating: string[];
	failed: { id: string; name: string; message: string }[];
}

export interface MarketState {
	entries: MarketEntry[];
	installed: InstalledPlugin[];
	updates: PluginUpdateState;
	/** 这次没读到市场的目录（断网、地址不对）：entries 是上次读到的，一次都没读到过就是空的。原因是系统给的原文。 */
	catalogError?: string;
}

/**
 * 装、卸、更新的结果。主进程没有文案目录，失败只给原因的种类，由界面翻译：目录里已经没有这一条、
 * 是本机直接放的（市场不动它的文件）、随应用发的（不能卸）、选的文件夹不是构建好的插件（目录名不合规矩或没有
 * dist/index.mjs）、或者文件操作出错（message 是系统给的原文）。
 */
export type MarketResult = { ok: true } | { ok: false; error: "not-found" | "local" | "builtin" | "invalid" } | { ok: false; error: "failed"; message: string };
