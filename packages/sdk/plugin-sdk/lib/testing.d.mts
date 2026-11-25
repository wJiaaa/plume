// testing.mjs 的类型。接口的形状定义在 @plume/contract，这里引 typecheck 生成到 dist/ 的那份声明：发到 npm 的包里没有 @plume/contract。
import type {
	CommandProvider,
	HookName,
	Hooks,
	Locale,
	NoticeLevel,
	Plugin,
	PluginContext,
	PluginSessionStore,
	PluginSettings,
	PluginStore,
	RegisteredToolInfo,
	Services,
	SessionAccess,
	ToolDefinition,
	ToolOutput,
	ToolRun,
} from "../dist/contract/src/index.d.ts";

/** 被测的插件：逻辑入口的默认导出。 */
export type TestedPlugin = Pick<Plugin, "name" | "inject" | "apply">;

export interface LoadOptions {
	/** `ctx.locale()` 的值，缺省 `"en"`。 */
	locale?: Locale;
	/** 工具 run 的 `cwd`，缺省是这次测试的临时目录。 */
	cwd?: string;
	/** 别的插件的工具，排在 `ctx.tools.list()`、`run.tools()` 的前面：测「按类别找工具」用。 */
	tools?: RegisteredToolInfo[];
	/** 存着的设置：`ctx.settings(defaults, normalize)` 读到的就是它和 defaults 合并、过 normalize 的结果。 */
	settings?: Record<string, unknown>;
	/** `ctx.use` 拿到的服务；要用的名字还得写进插件的 `inject`。 */
	services?: Partial<Services>;
	/**
	 * 假 ctx 没实现的成员（`fetch`、`model`、`workspace`、`sessions.messages`……），或者要换掉的。
	 * 是普通对象的和默认那份浅合并（给 `sessions: { messages }` 不会丢掉 `onDeleted`），别的整个换掉。
	 */
	ctx?: Partial<Omit<PluginContext, "sessions">> & { sessions?: Partial<SessionAccess> };
}

/** 测试能经 `emit` 触发的 `ctx.sessions` 订阅。 */
export type SessionEvent = "observe" | "onDeleted" | "onArchived" | "onEnded" | "onStopped" | "onContextReset";

type ListenerOf<E extends SessionEvent> = Parameters<SessionAccess[E]>[0];

export interface LoadedPlugin {
	/** 交给 `apply` 的那个 ctx。没实现、也没经 `options.ctx` 给的成员，读到就抛错。 */
	readonly ctx: PluginContext;
	/** 插件注册的工具；没有就抛错。 */
	tool(name: string): ToolDefinition;
	/**
	 * 跑一次插件自己的工具。`run` 缺省有 `sessionId`（`"session"`）、`session`（顶层会话）、`toolCallId`、`cwd`、`scratchDir`、
	 * `signal`、`progress`、`tools`、`calls`；`ask`、`request`、`exec`、`files`、`permissionMode` 这些要的自己给，没给就抛错。
	 * 参数原样交给 `execute`：本体按 `parameters` 做的整理和类型检查这里不做，给的就是整理后的样子。
	 */
	runTool(name: string, args?: Record<string, unknown>, run?: Partial<ToolRun>): Promise<ToolOutput>;
	/**
	 * 把插件给这个钩子加的层按 `order` 串起来（小的在外层，相同时按注册先后）跑一次，最里层是 `inner`：
	 * 它代表本体和别的插件，收到的是插件交给里层的输入。插件没加这个钩子时直接调 `inner`。
	 */
	hook<N extends HookName>(name: N, input: Hooks[N][0], inner: (input: Hooks[N][0]) => Promise<Hooks[N][1]>): Promise<Hooks[N][1]>;
	/** 触发插件在 `ctx.sessions` 上的订阅；`onDeleted` 同时丢掉那个会话在每个 `sessionStore` 里的值，和本体一样。 */
	emit<E extends SessionEvent>(event: E, ...args: Parameters<ListenerOf<E>>): Promise<void>;
	/** 插件 `ctx.serve` 开出的接口。 */
	readonly api: object | undefined;
	/** 插件 `ctx.commands.provide` 供的命令，按先后。 */
	readonly commands: readonly CommandProvider[];
	/** 插件 `ctx.provide` 提供的服务。 */
	readonly provided: ReadonlyMap<keyof Services, unknown>;
	/** `ctx.notice` 发过的提示。 */
	readonly notices: ReadonlyArray<{ sessionId: string; text: string; level: NoticeLevel | undefined }>;
	/** `ctx.log` 写过的日志。 */
	readonly logs: ReadonlyArray<{ level: "info" | "warn" | "error"; message: string }>;
	/** 插件 `ctx.settings` 拿到的那份；没调过是 undefined。 */
	readonly settings: PluginSettings<Record<string, unknown>> | undefined;
	/** 插件登记的 `ctx.store`；没登记就抛错。 */
	store<T = unknown>(key: string): PluginStore<T>;
	/** 插件登记的 `ctx.sessionStore`；没登记就抛错。 */
	sessionStore<T = unknown>(key: string): PluginSessionStore<T>;
	/** 按后登记先执行跑完 `ctx.effect` 登记的清理（和停用时一样），删掉临时目录。 */
	dispose(): Promise<void>;
}

export declare function loadPlugin(plugin: TestedPlugin, options?: LoadOptions): Promise<LoadedPlugin>;
