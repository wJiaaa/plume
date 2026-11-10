/**
 * 主进程和 agent 进程之间的约定。主进程经 parentPort 上的 RpcChannel 调用 agent 进程，agent 进程在同一条通道上调主进程（网页）；
 * 渲染进程的连接（MessagePort）由主进程用一条 `{ t: "connect" }` 消息转交给 agent 进程。
 */

import type { AgentEvent, CallContext, PluginStatus, SessionSummary, WebPageEvent } from "@plume/contract";

/** 启动 agent 进程时经环境变量传入：数据目录、模型设置文件、插件目录列表（JSON）、界面语言。 */
export const DATA_DIR_ENV = "PLUME_DATA_DIR";
export const SETTINGS_FILE_ENV = "PLUME_SETTINGS_FILE";
export const PLUGINS_ENV = "PLUME_PLUGINS";
export const LOCALE_ENV = "PLUME_LOCALE";
/** 模型目录的缓存文件；不传（冒烟验证）就不访问 pi.dev，只用打包的快照。 */
export const CATALOG_FILE_ENV = "PLUME_CATALOG_FILE";
/** 用户的插件放在哪些目录（JSON 数组）：Windows 上这些目录里的原生模块复制一份再加载（main/native-cache.ts）。 */
export const NATIVE_ROOTS_ENV = "PLUME_NATIVE_ROOTS";

export interface PluginDir {
	/** 目录名，也是 plume-plugin:// 地址里的主机名。 */
	key: string;
	dir: string;
	/** 随应用发的内置插件（仓库的 `packages/builtin/`）：不能停用、卸载。 */
	builtin?: boolean;
}

export interface ConnectMessage {
	t: "connect";
}

/** agent 进程提供给主进程。 */
export interface AgentProcessApi {
	/** 主进程的系统通知订阅，与窗口各自的订阅分开。 */
	watch(call: CallContext): AsyncGenerator<AgentEvent, void>;
	plugins(): Promise<PluginStatus[]>;
	/** 插件市场装上（或更新完）一个插件：加载它，返回全部插件的最新状态。 */
	addPlugin(dir: PluginDir): Promise<PluginStatus[]>;
	/** 插件市场要卸载（或更新）一个插件：先停用并卸下它。 */
	removePlugin(key: string): Promise<PluginStatus[]>;
	/** 会话工作目录或项目源目录里这个文件的真实路径，越界或不是文件时是 null。`plume-media://f/…` 每次请求都先问这里。 */
	filePath(sessionId: string, path: string): Promise<string | null>;
	/** 全部会话的摘要：菜单栏图标的「最近会话」弹出时取一次。 */
	sessions(): Promise<SessionSummary[]>;
	/** 停掉正在跑的轮次、停用插件、写完文件后返回，随后进程自己退出。 */
	shutdown(): Promise<void>;
	/** 插件的网页上发生了一件事，交给那个插件经 `ctx.pages.onEvent` 订阅的监听。 */
	pageEvent(plugin: string, event: WebPageEvent): Promise<void>;
}

/** 主进程提供给 agent 进程。 */
export interface MainProcessApi {
	/** agent 已验证的项目文件移入系统废纸篓。 */
	trash(path: string): Promise<void>;
	/** 插件的 `ctx.pages.<method>(id, ...args)`，见 `WebPages`；只有主进程碰得到页面。 */
	page(plugin: string, id: string, method: string, args: unknown[]): Promise<unknown>;
	/**
	 * agent 起不来（会话库打不开之类）：主进程告诉人在哪、为什么，然后退出应用，所以这个调用不会返回。
	 * path 是打不开的会话库；别的原因时是数据目录。
	 */
	startupFailed(path: string, reason: string): Promise<void>;
}
