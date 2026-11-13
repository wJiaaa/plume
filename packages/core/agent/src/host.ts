/**
 * 插件宿主：加载插件、给每个插件一个 ctx，记下它注册的工具、钩子、服务和清理，停用或 apply 失败时按账整体撤销。
 *
 * 钩子是洋葱：order 小的在外层，相同时按注册先后。任何一层抛错，整个钩子失败（fail-closed），
 * 因为审批、脱敏这类层被跳过就等于放行或泄露。
 *
 * 服务（`ctx.provide` / `ctx.use`）：插件声明要用哪些服务（`inject`），缺了就等着，补上了再加载。每项服务只有一个
 * 生效的提供方：非内置的优先，同类里先加载的优先。生效的提供方变了（装上、停用、卸下），用它的插件停用后按新的重新加载，
 * 一直对到没有谁再变（`settle`）。内置插件随应用发，不能停用。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { activeLocale, text } from "./i18n.ts";
import { Workspace } from "./run-files.ts";
import type {
	CallContext,
	CommandContext,
	CommandEntry,
	CommandExpansion,
	CommandProvider,
	CommandResult,
	SlashCommand,
	HookLayer,
	HookName,
	Hooks,
	InstalledPlugin,
	Log,
	Logger,
	MediaAccess,
	ModelAccess,
	NoticeLevel,
	Plugin,
	PluginContext,
	PluginEntry,
	PluginSecrets,
	PluginStatus,
	SessionAccess,
	SessionEndReason,
	SessionObservation,
	RegisteredToolInfo,
	ToolDefinition,
	ToolKind,
	ToolSpec,
	WebPageEvent,
	WebPages,
} from "@plume/contract";

/** 没有媒体目录时的 `ctx.media`：什么都读不到、存不进。 */
const NO_MEDIA: MediaAccess = {
	save: async () => {
		throw new Error(text("media.unavailable"));
	},
	read: async () => null,
	nameOf: () => null,
};

/** 没有 vault 时的 `ctx.secrets`：加不了密、也解不了，认得出密文的样子。 */
const NO_SECRETS: PluginSecrets = {
	seal: async () => {
		throw new Error(text("secrets.unavailable"));
	},
	unseal: async () => {
		throw new Error(text("secrets.unavailable"));
	},
	isSealed: (value) => typeof value === "string" && value.startsWith("plume-sealed:"),
};

/**
 * 插件的 `ctx.sessions`：会话在 agent 那边，宿主只转交。动子会话的几样多给一个 `owner`（调它的插件），agent 据此只让插件动自己建的。
 */
export interface HostSessions extends Pick<
	SessionAccess,
	"list" | "get" | "messages" | "compact" | "setTitle" | "setArchived" | "models" | "jobs" | "stopJob" | "jobOutput" | "wakeups" | "cancelWakeup"
> {
	create(owner: string, options: Parameters<SessionAccess["create"]>[0]): ReturnType<SessionAccess["create"]>;
	/** `owner` 只用来记日志：开出来的会话不记在插件名下。 */
	launch(owner: string, options: Parameters<SessionAccess["launch"]>[0]): ReturnType<SessionAccess["launch"]>;
	/** 以下三样的 `owner` 是调它的插件：agent 只让它动自己代管的会话（`SessionSummary.steward`）。 */
	post(owner: string, sessionId: string, message: string): ReturnType<SessionAccess["post"]>;
	respond(owner: string, sessionId: string, toolCallId: string, decision: Parameters<SessionAccess["respond"]>[2]): ReturnType<SessionAccess["respond"]>;
	answer(owner: string, sessionId: string, toolCallId: string, value: unknown): ReturnType<SessionAccess["answer"]>;
	send(
		owner: string,
		sessionId: string,
		message: Parameters<SessionAccess["send"]>[1],
		options?: Parameters<SessionAccess["send"]>[2],
	): ReturnType<SessionAccess["send"]>;
	start(owner: string, sessionId: string, message: Parameters<SessionAccess["start"]>[1]): ReturnType<SessionAccess["start"]>;
	wait(owner: string, runId: string): ReturnType<SessionAccess["wait"]>;
	report(owner: string, runId: string, text: string, options?: Parameters<SessionAccess["report"]>[2]): ReturnType<SessionAccess["report"]>;
	steer(owner: string, sessionId: string, message: Parameters<SessionAccess["steer"]>[1]): ReturnType<SessionAccess["steer"]>;
	disposeOwner(owner: string): Promise<void>;
	stop(owner: string, sessionId: string): void;
	delete(owner: string, sessionId: string): Promise<void>;
}

/** 插件的 `ctx.pages`：页面在主进程，宿主按插件名转交。不给（测试、没有窗口的环境）时每个调用都报错。 */
export interface HostPages {
	call(plugin: string, id: string, method: string, args: unknown[]): Promise<unknown>;
}

/** `ctx.pages` 上转给主进程的方法，`onEvent` 之外的全部。 */
const PAGE_METHODS = [
	"inspect",
	"attach",
	"state",
	"load",
	"go",
	"evaluate",
	"input",
	"insertText",
	"focus",
	"capture",
	"setZoom",
	"emulate",
	"devtools",
	"answerDialogs",
	"chromeLogins",
] as const satisfies readonly Exclude<keyof WebPages, "onEvent">[];

export interface RegisteredTool {
	definition: ToolDefinition;
	/** 注册它的插件。 */
	plugin: string;
	/** 注册它的插件是内置的：工具表里排在前面，见 `compareTools`。 */
	builtin: boolean;
}

/** 第一组里按做的是哪种活排：先读、列、找、搜，再写、改，最后跑命令和管后台。 */
const KIND_RANK = { view: 0, list: 1, find: 2, search: 3, create: 4, modify: 5, command: 6, watch: 7, job: 8 } satisfies Record<ToolKind, number>;

/**
 * 工具表的排法（发给模型的、`ctx.tools.list()`、界面的都是这一份）。只看工具自己的声明和注册它的插件的名字、是不是内置，
 * 和依赖声明（`inject`）、安装和加载的先后、MCP 服务连上的先后都无关：调一次依赖、重装一个插件，表的顺序不变，
 * 服务商的提示词缓存就不会因为工具挪了位置而作废。分四组，组内按名字（逐个码位比，不随系统语言变）：
 * 1. 内置插件里声明了 `kind` 的（读写文件、跑命令这些最常用的）：按 `KIND_RANK`，同种按工具名；
 * 2. 内置插件的其余工具：按插件名，再按工具名，一个插件的工具挨在一起；
 * 3. 非内置插件的工具：同上。装上一个插件，它的工具作为一整块插进这一组，前两组不动；
 * 4. MCP 的工具（`category: "mcp"`，不论哪个插件注册的）：按工具名，名字带着服务名，同一台服务的挨在一起。连上、断开最频繁，放在最后。
 * 同一会话中途变了工具表时怎么接，归发请求的那一层（内置插件 plume.prompt 冻结着会话的那份，新的接在后面）。
 */
function compareTools(a: RegisteredTool, b: RegisteredTool): number {
	const key = ({ definition, plugin, builtin }: RegisteredTool): [number, number, string] => {
		if (definition.category === "mcp") return [3, 0, ""];
		if (builtin && definition.kind) return [0, KIND_RANK[definition.kind] ?? 0, ""];
		return [builtin ? 1 : 2, 0, plugin];
	};
	const [groupA, rankA, pluginA] = key(a);
	const [groupB, rankB, pluginB] = key(b);
	return groupA - groupB || rankA - rankB || compareText(pluginA, pluginB) || compareText(a.definition.name, b.definition.name);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** 钩子某一层出错。message 里带上插件名，交给模型和界面都能看出是谁。 */
export class HookError extends Error {
	constructor(
		readonly plugin: string,
		readonly hook: HookName,
		cause: unknown,
	) {
		super(text("plugin.hookFailed", { plugin, hook, error: errorText(cause) }), { cause });
		this.name = "HookError";
	}
}

interface Layer {
	plugin: string;
	order: number;
	seq: number;
	run: (input: unknown, next: (input: unknown) => Promise<unknown>) => Promise<unknown>;
}

interface PluginRecord {
	status: PluginStatus;
	disposers: Array<() => void | Promise<void>>;
	/** 从哪导入。停用着的插件不导入（顶层代码也不跑），启用时才经它导入。 */
	entry: PluginEntry;
	/** 导入成功后的模块：停用了再启用时不用重新导入。 */
	plugin?: Plugin;
	builtin: boolean;
	/** 插件目录，`ctx.plugins.list()` 给出它。 */
	dir?: string;
	/** 这次加载时拿到的服务：提供方换了就要重新加载。 */
	bound: Map<string, Offer>;
	closing?: boolean;
	generation?: object;
}

/** 一个插件提供的一项服务。 */
interface Offer {
	record: PluginRecord;
	/** 交给用它的插件的那一份：只有方法，冻住了。 */
	facade: object;
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/i;
/** 服务名：小写字母开头，可以用点分段（`fs`、`git.status`）。 */
const SERVICE_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const missing = async (sessionId: unknown): Promise<never> => {
	throw new Error(text("session.notFound", { id: String(sessionId) }));
};
const NO_SESSIONS: HostSessions = {
	list: async () => [],
	get: async () => undefined,
	messages: missing,
	compact: missing,
	setTitle: missing,
	setArchived: missing,
	create: async (_owner, options) => missing(options?.parentId),
	launch: async (_owner, options) => missing(options?.spawnedFrom?.sessionId),
	post: async (_owner, sessionId) => missing(sessionId),
	respond: async (_owner, sessionId) => missing(sessionId),
	answer: async (_owner, sessionId) => missing(sessionId),
	models: async () => [],
	jobs: () => [],
	stopJob: () => false,
	jobOutput: async (sessionId) => missing(sessionId),
	wakeups: () => [],
	cancelWakeup: () => false,
	start: async (_owner, sessionId) => missing(sessionId),
	wait: async (_owner, runId) => missing(runId),
	report: async (_owner, runId) => missing(runId),
	steer: async (_owner, sessionId) => missing(sessionId),
	disposeOwner: async () => undefined,
	send: async (_owner, sessionId) => missing(sessionId),
	stop: () => undefined,
	delete: async (_owner, sessionId) => missing(sessionId),
};
const HOOKS: ReadonlySet<string> = new Set<HookName>(["tool.execute", "model.context", "step.end", "prompt.submit", "context.compact", "tool.approve"]);
/** 市场插件的 `apply` 最多等多久，见 `PluginHost.limited`。 */
const APPLY_TIMEOUT_MS = 15_000;
/** 命令名：`/` 后面能敲的字，`:` 分段。 */
const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$/;

interface ProvidedCommands {
	record: PluginRecord;
	provider: CommandProvider;
}

export class PluginHost {
	/** `all`：插件声明了要看全部会话（`Plugin.observe`），不然只收和它有关的会话的，见 `observe`。 */
	private readonly observers = new Set<{ plugin: string; all: boolean; listener: (observation: SessionObservation) => void }>();
	private readonly records: PluginRecord[] = [];
	/** 工具名 → 登记过的同名工具，后登记的在最后、生效；它撤下后前一个恢复。 */
	private readonly tools = new Map<string, RegisteredTool[]>();
	private readonly deletedListeners = new Set<{ plugin: string; listener: (sessionId: string) => void }>();
	/** 登记了 `ctx.plugins.onChange` 的插件。 */
	private readonly pluginListeners = new Set<{ plugin: string; listener: () => void }>();
	private readonly contextResetListeners = new Set<{ plugin: string; listener: (sessionId: string) => void }>();
	private readonly stoppedListeners = new Set<{ plugin: string; listener: (sessionId: string) => void }>();
	private readonly archivedListeners = new Set<{ plugin: string; listener: (sessionId: string, archived: boolean) => void }>();
	private readonly endedListeners = new Set<{ plugin: string; listener: (sessionId: string, reason: SessionEndReason) => void | Promise<void> }>();
	private readonly pageListeners = new Set<{ plugin: string; listener: (event: WebPageEvent) => void }>();
	private readonly layers = new Map<HookName, Layer[]>();
	/** 插件名 → 它经 ctx.serve 开给界面入口的对象。 */
	private readonly served = new Map<string, object>();
	/** 插件经 ctx.commands 供的命令。 */
	private providers: ProvidedCommands[] = [];
	/** 服务名 → 提供了它的插件，按提供的先后。哪个生效见 `current`。 */
	private readonly offers = new Map<string, Offer[]>();
	private seq = 0;
	/** 关掉的插件名：启动时来自配置，之后随 setEnabled 变化。 */
	private readonly disabled: Set<string>;
	/**
	 * `add`、`remove`、`setEnabled` 排成一队：市场的装卸在主进程排了队，界面的启停直达这里，不在那条队里，两边交错的话
	 * 一个的 `settle` 会撞上另一个装到一半的插件。`load`、`dispose` 不排（启动、退出时没有并发），内部的私有方法也不排，否则互相等死。
	 */
	private queue: Promise<unknown> = Promise.resolve();
	/** 插件的 `ctx.resources`、`ctx.workspace` 和工具调用的 `ToolRun.files` 背后的那一份，见 `run-files.ts`。 */
	readonly workspace: Workspace;

	constructor(
		private readonly options: {
			/** 插件数据目录的上一级，每个插件一个子目录。 */
			dataDir: string;
			/** Plume 自己的数据目录，插件的 `ctx.appDataDir`。 */
			appDataDir: string;
			/** 配置里关掉的插件，按 `PluginEntry.key`（目录名）记：导入前就要知道它停用着，插件名得导入以后才有。 */
			disabled?: ReadonlySet<string>;
			log: Log;
			/** 插件的 `ctx.model`：模型设置在 agent 那边，宿主只转交。 */
			model: ModelAccess;
			/** 插件的 `ctx.notice`：事件由 agent 发给界面。 */
			notice(sessionId: string, text: string, level: NoticeLevel): void;
			/** 插件的 `ctx.media`：媒体目录在 agent 那边。只测宿主本身时不给，插件读不到图、也存不进去。 */
			media?: MediaAccess;
			/** 插件的 `ctx.secrets`，按插件名给（见 `vault.ts` 的 `pluginSecrets`）。只测宿主本身时不给，插件加解密都抛错。 */
			secrets?: (plugin: string) => PluginSecrets;
			/** 插件的 `ctx.sessions`，见 `HostSessions`。只测宿主本身时不给，插件读到的是一个会话也没有。 */
			sessions?: HostSessions;
			/** 插件的 `ctx.pages`，见 `HostPages`。 */
			pages?: HostPages;
			/** 装配方提供系统网络栈；纯 Node 宿主使用标准 fetch。 */
			fetch?: PluginContext["fetch"];
			/** 插件的 `ctx.trash`：移到系统废纸篓，桌面应用经主进程做。不给时插件调它就抛错。 */
			trash?: (path: string) => Promise<void>;
			/** 非内置插件的 `apply` 最多等多久，缺省 15 秒。只为测试能传短的。 */
			applyTimeoutMs?: number;
			/** 工具表变了（登记、撤下了一件工具）：agent 据此告诉界面，见 `AgentService.listTools`。 */
			toolsChanged?(): void;
		},
	) {
		this.disabled = new Set(options.disabled);
		this.workspace = new Workspace(options.appDataDir, options.sessions ?? NO_SESSIONS, () => this.installed());
	}

	/**
	 * 每个观察者各拿副本，失败只记日志，不能改变执行或别的观察者看到的数据。`concerned` 是和这个会话有关的插件（建它的、代管它或它父会话的、
	 * 开出它还在等它闲下来的，由 agent 按会话算好）：没声明 `observe: "all"` 的插件只收这些会话的。
	 */
	observe(observation: SessionObservation, concerned: ReadonlySet<string>): void {
		for (const { plugin, all, listener } of this.observers) {
			if (!all && !concerned.has(plugin)) continue;
			try {
				void Promise.resolve(listener(structuredClone(observation))).catch((error: unknown) => {
					this.options.log(plugin, "error", `运行观察失败：${errorText(error)}`);
				});
			} catch (error) {
				this.options.log(plugin, "error", `运行观察失败：${errorText(error)}`);
			}
		}
	}

	/** 会话删掉了：告诉登记过 `ctx.sessions.onDeleted` 的插件。某个插件出错只记日志，不拦着别的。 */
	sessionDeleted(sessionId: string): void {
		void this.workspace
			.forget(sessionId)
			.catch((error: unknown) => this.options.log("agent", "error", `删掉会话 ${sessionId} 的改动快照失败：${errorText(error)}`));
		for (const { plugin, listener } of [...this.deletedListeners]) {
			try {
				listener(sessionId);
			} catch (error) {
				this.options.log(plugin, "error", `处理会话删除出错：${errorText(error)}`);
			}
		}
	}

	/** 有插件装上、卸下、启停了：告诉登记过 `ctx.plugins.onChange` 的插件。某个插件出错只记日志，不拦着别的。 */
	private pluginsChanged(): void {
		for (const { plugin, listener } of [...this.pluginListeners]) {
			try {
				listener();
			} catch (error) {
				this.options.log(plugin, "error", `处理插件变化出错：${errorText(error)}`);
			}
		}
	}

	/** 历史被替换或裁剪后，插件按会话冻结的上下文要重读；失败只记日志，不拦其他插件。 */
	sessionContextReset(sessionId: string): void {
		for (const { plugin, listener } of [...this.contextResetListeners]) {
			try {
				void Promise.resolve(listener(sessionId)).catch((error: unknown) => {
					this.options.log(plugin, "error", `刷新会话上下文失败：${errorText(error)}`);
				});
			} catch (error) {
				this.options.log(plugin, "error", `刷新会话上下文失败：${errorText(error)}`);
			}
		}
	}

	/** 会话归档、取消归档了：告诉登记过 `ctx.sessions.onArchived` 的插件。某个插件出错只记日志，不拦着别的。 */
	sessionArchived(sessionId: string, archived: boolean): void {
		for (const { plugin, listener } of [...this.archivedListeners]) {
			try {
				listener(sessionId, archived);
			} catch (error) {
				this.options.log(plugin, "error", `处理会话归档出错：${errorText(error)}`);
			}
		}
	}

	/** 会话不再活着了：告诉登记过 `ctx.sessions.onEnded` 的插件，等它们都收完尾。某个插件出错只记日志，不拦着别的。 */
	async sessionEnded(sessionId: string, reason: SessionEndReason): Promise<void> {
		await Promise.all(
			[...this.endedListeners].map(async ({ plugin, listener }) => {
				try {
					await listener(sessionId, reason);
				} catch (error) {
					this.options.log(plugin, "error", `处理会话结束出错：${errorText(error)}`);
				}
			}),
		);
	}

	/** 插件的网页上发生了一件事（主进程报来的）：交给这个插件经 `ctx.pages.onEvent` 订阅的监听。出错只记日志。 */
	pageEvent(plugin: string, event: WebPageEvent): void {
		for (const entry of [...this.pageListeners]) {
			if (entry.plugin !== plugin) continue;
			try {
				entry.listener(event);
			} catch (error) {
				this.options.log(plugin, "error", `处理网页事件出错：${errorText(error)}`);
			}
		}
	}

	/** 主动停止和自然结束分开：即使空闲时按停止，也要撤掉插件排着的工作。 */
	sessionStopped(sessionId: string): void {
		for (const { plugin, listener } of [...this.stoppedListeners]) {
			try {
				listener(sessionId);
			} catch (error) {
				this.options.log(plugin, "error", `处理会话停止出错：${errorText(error)}`);
			}
		}
	}

	/**
	 * 依次加载。名字要先导入模块才知道，所以关掉的插件也会被导入（顶层代码会执行），只是不调 apply。
	 */
	async load(entries: PluginEntry[]): Promise<void> {
		for (const entry of entries) await this.loadOne(entry);
		await this.settle();
		this.pluginsChanged();
	}

	status(): PluginStatus[] {
		return this.records.map((record) => ({ ...record.status, ...(record.status.waitingFor ? { waitingFor: [...record.status.waitingFor] } : {}) }));
	}

	/** 运行中装上一个插件（插件市场安装、更新后），排在已加载的插件后面。key 已经在用时报错。 */
	add(entry: PluginEntry): Promise<void> {
		return this.serial(async () => {
			if (this.records.some((record) => record.status.key === entry.key)) throw new Error(text("plugin.keyTaken", { key: entry.key }));
			await this.loadOne(entry);
			await this.settle();
			this.pluginsChanged();
		});
	}

	/** 运行中卸下一个插件：撤销它的全部注册，从列表里拿掉。没有这个 key 时什么都不做。 */
	remove(key: string): Promise<void> {
		return this.serial(async () => {
			const record = this.records.find((candidate) => candidate.status.key === key);
			if (!record) return;
			if (record.status.state === "active") await this.unwind(record);
			this.records.splice(this.records.indexOf(record), 1);
			await this.settle();
			this.pluginsChanged();
		});
	}

	/**
	 * 启用或停用一个插件（按 `PluginStatus.key`），立即生效。返回停用名单（key），由调用方存进配置。内置插件不能停用。
	 * 加载失败（`failed`）的启用就是再试一次（导入失败的连导入一起重来），停用就记成停用。
	 */
	setEnabled(key: string, enabled: boolean): Promise<string[]> {
		return this.serial(async () => {
			const record = this.records.find((candidate) => candidate.status.key === key);
			if (!record) throw new Error(text("plugin.notFound", { name: key }));
			if (record.builtin) throw new Error(text("plugin.builtinLocked", { name: record.status.name }));
			if (enabled) {
				this.disabled.delete(key);
				if (record.status.state === "disabled" || record.status.state === "failed") {
					const plugin = record.plugin ?? (await this.importOne(record));
					if (plugin) await this.activate(record, plugin);
				}
			} else {
				this.disabled.add(key);
				if (record.status.state === "active" || record.status.state === "waiting") {
					await this.unwind(record);
					record.status.state = "disabled";
					delete record.status.waitingFor;
				} else if (record.status.state === "failed") {
					record.status.state = "disabled";
				}
			}
			await this.settle();
			this.pluginsChanged();
			return [...this.disabled];
		});
	}

	private serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.queue.then(work, work);
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** 现在启用着、已经加载好的插件（`ctx.plugins.list()`，`plugin://` 也读它）。 */
	private installed(): InstalledPlugin[] {
		return this.records.flatMap((other) =>
			other.status.state === "active" && other.dir ? [{ name: other.status.name, dir: other.dir, builtin: other.builtin }] : [],
		);
	}

	tool(name: string): RegisteredTool | undefined {
		return this.tools.get(name)?.at(-1);
	}

	/** 工具表里生效的工具（同名的取最后登记的），按 `compareTools` 排好。 */
	private effectiveTools(): RegisteredTool[] {
		return [...this.tools.values()].flatMap((list) => list.slice(-1)).sort(compareTools);
	}

	/** 工具表里生效的工具、注册它们的插件和它们声明的种类、类别。 */
	toolOwners(): RegisteredToolInfo[] {
		return this.effectiveTools().map(({ definition, plugin }) => ({
			name: definition.name,
			plugin,
			...(definition.kind ? { kind: definition.kind } : {}),
			...(definition.category ? { category: definition.category } : {}),
		}));
	}

	/**
	 * 各插件供的命令，按插件加载的先后排；同名的只留先出现的那条。某一份列不出来只记日志、跳过它，
	 * 不让一个插件的错把整张菜单弄没；名字不合规矩的条目同样跳过。
	 */
	async commands(context: CommandContext): Promise<CommandEntry[]> {
		const providers = [...this.providers].sort((a, b) => this.records.indexOf(a.record) - this.records.indexOf(b.record));
		const lists = await Promise.all(providers.map((entry) => this.listOf(entry, context)));
		const seen = new Set<string>();
		const entries: CommandEntry[] = [];
		providers.forEach(({ record }, index) => {
			for (const command of lists[index] ?? []) {
				if (seen.has(command.name)) continue;
				seen.add(command.name);
				entries.push({ ...command, plugin: record.status.name });
			}
		});
		return entries;
	}

	/** 让插件展开它的一条命令：找到列出这个名字的那一份，交给它。 */
	async expandCommand(plugin: string, name: string, rest: string, context: CommandContext): Promise<CommandResult> {
		for (const entry of this.providers.filter((candidate) => candidate.record.status.name === plugin)) {
			if (!(await this.listOf(entry, context)).some((command) => command.name === name)) continue;
			const result = await entry.provider.expand(name, rest, context);
			if (result && "handled" in result && result.handled === true) {
				return {
					handled: true,
					...(typeof result.openPanel === "string" && result.openPanel ? { openPanel: result.openPanel } : {}),
					...(typeof result.openSettings === "string" && result.openSettings ? { openSettings: result.openSettings } : {}),
				};
			}
			const expansion = result as CommandExpansion | undefined;
			if (typeof expansion?.text !== "string") throw new Error(text("plugin.badExpansion", { plugin, name }));
			return {
				text: expansion.text,
				...(typeof expansion.displayText === "string" ? { displayText: expansion.displayText } : {}),
				...(expansion.deliver === "steer" ? { deliver: "steer" as const } : {}),
			};
		}
		throw new Error(text("plugin.noCommand", { plugin, name }));
	}

	private async listOf({ record, provider }: ProvidedCommands, context: CommandContext): Promise<SlashCommand[]> {
		const plugin = record.status.name;
		try {
			const list = await provider.list(context);
			if (!Array.isArray(list)) {
				this.options.log(plugin, "error", "列命令出错：list 没有返回数组");
				return [];
			}
			return list.flatMap((command): SlashCommand[] => {
				if (typeof command?.name !== "string" || !COMMAND_NAME.test(command.name) || typeof command.description !== "string") {
					this.options.log(plugin, "warn", `跳过不合规矩的命令：${JSON.stringify(command?.name)}`);
					return [];
				}
				return [
					{
						name: command.name,
						description: command.description,
						...(typeof command.argumentHint === "string" ? { argumentHint: command.argumentHint } : {}),
						...(typeof command.source === "string" ? { source: command.source } : {}),
					},
				];
			});
		} catch (error) {
			this.options.log(plugin, "error", `列命令出错：${errorText(error)}`);
			return [];
		}
	}

	toolSpecs(): ToolSpec[] {
		return this.effectiveTools().map(({ definition: { name, description, parameters } }) => ({ name, description, parameters }));
	}

	/**
	 * 按洋葱顺序调用钩子，inner 是最里层。
	 * `settle` 在每一层交接时调：这一层交给里层的、里层交回来又被这一层改过的，都先经它整理（见 `prompt/sections.ts`）。
	 * `stop` 在交给每一层（含最里层）之前调：它给出结果时不再往里交，交过来的那一层拿到的就是它（见 `tool-run.ts` 的只读）。
	 */
	run<N extends HookName>(
		name: N,
		input: Hooks[N][0],
		inner: (input: Hooks[N][0]) => Promise<Hooks[N][1]>,
		settle?: (value: never) => unknown,
		stop?: (input: Hooks[N][0]) => Hooks[N][1] | undefined,
	): Promise<Hooks[N][1]> {
		// 取快照：调用过程中有插件停用或新注册，不影响这一次。
		const layers = [...(this.layers.get(name) ?? [])];
		const align = (value: unknown) => (settle ? settle(value as never) : value);
		const dispatch = async (index: number, value: unknown): Promise<unknown> => {
			const stopped = stop?.(value as Hooks[N][0]);
			if (stopped !== undefined) return stopped;
			const layer = layers[index];
			if (!layer) return inner(value as Hooks[N][0]);
			try {
				let returned: unknown;
				const output = await layer.run(value, async (next) => (returned = await dispatch(index + 1, align(next))));
				return returned === undefined ? output : align(output);
			} catch (error) {
				// 里层的错误原样往外传，只在最先出错的那一层归因。
				throw error instanceof HookError ? error : new HookError(layer.plugin, name, error);
			}
		};
		return dispatch(0, input) as Promise<Hooks[N][1]>;
	}

	/**
	 * 调插件开给界面入口的方法，CallContext 追加在最后。只认对象自己和它的类上的方法，Object.prototype 上的不算。
	 * 返回什么就交回什么：异步迭代器由 RPC 逐个推给界面。
	 */
	call(plugin: string, method: string, args: unknown[], context: CallContext): unknown {
		const api = this.served.get(plugin);
		if (!api) throw new Error(text("plugin.notServing", { plugin }));
		if (!Array.isArray(args)) throw new Error(text("plugin.argsNotArray"));
		const fn = methodOf(api, method);
		if (!fn) throw new Error(text("plugin.noMethod", { plugin, method }));
		return fn.apply(api, [...args, context]);
	}

	/** 按加载的相反顺序停用所有插件。 */
	async dispose(): Promise<void> {
		for (const record of [...this.records].reverse()) {
			if (record.status.state !== "active") continue;
			await this.unwind(record);
			record.status.state = "disposed";
		}
	}

	private async loadOne(entry: PluginEntry): Promise<void> {
		const builtin = entry.builtin === true;
		const status: PluginStatus = { name: entry.key, key: entry.key, state: "loading", ...(entry.ui ? { ui: entry.ui } : {}), ...(builtin ? { builtin } : {}) };
		const record: PluginRecord = { status, disposers: [], builtin, entry, bound: new Map(), ...(entry.dir ? { dir: entry.dir } : {}) };
		this.records.push(record);
		// 停用着的不导入：导入就会跑它的顶层代码。名字先用 key 顶着，启用时导入了再换成插件名。
		if (this.disabled.has(entry.key) && !builtin) {
			status.state = "disabled";
			return;
		}
		const plugin = await this.importOne(record);
		if (plugin) await this.activate(record, plugin);
	}

	/** 导入、校验插件模块，记下插件名；失败时状态记为 failed、交回 undefined。 */
	private async importOne(record: PluginRecord): Promise<Plugin | undefined> {
		const status = record.status;
		const fail = (error: unknown) => {
			status.state = "failed";
			status.error = errorText(error);
			this.options.log(status.name, "error", `加载失败：${status.error}`);
			return undefined;
		};
		let plugin: Plugin;
		try {
			plugin = validPlugin(await record.entry.load());
		} catch (error) {
			return fail(error);
		}
		status.name = plugin.name;
		if (plugin.observe === "all") status.observe = "all";
		if (this.records.some((other) => other !== record && other.status.name === plugin.name)) {
			return fail(new Error(text("plugin.nameTaken", { name: plugin.name, key: record.entry.key })));
		}
		record.plugin = plugin;
		return plugin;
	}

	/** 调 apply；要用的服务还缺就记为等待，出错时撤销已经注册的部分，状态记为 failed。 */
	private async activate(record: PluginRecord, plugin: Plugin): Promise<void> {
		const status = record.status;
		delete status.error;
		const missing = (plugin.inject ?? []).filter((service) => !this.current(service));
		if (missing.length > 0) {
			status.state = "waiting";
			status.waitingFor = missing;
			return;
		}
		delete status.waitingFor;
		status.state = "loading";
		for (const service of plugin.inject ?? []) record.bound.set(service, this.current(service) as Offer);
		const dataDir = join(this.options.dataDir, plugin.name);
		try {
			await mkdir(dataDir, { recursive: true });
			const applied = Promise.resolve(plugin.apply(this.context(record, dataDir)));
			await (record.builtin ? applied : this.limited(applied, plugin.name));
			status.state = "active";
		} catch (error) {
			await this.unwind(record);
			status.state = "failed";
			status.error = errorText(error);
			this.options.log(status.name, "error", `加载失败：${status.error}`);
		}
	}

	/**
	 * 市场插件的 `apply` 和定时器赛跑：一个不返回的 `apply` 会让 `load` 一直等，agent 服务起不来，界面上也没法停用它。
	 * 超时按 `apply` 抛错处理（撤销、记 `failed`）；它之后再调 `ctx` 上的注册会被 `live()` 拦下。内置插件不限时：
	 * 它们是主路径，宁可等也不能缺。
	 */
	private async limited(applied: Promise<void>, name: string): Promise<void> {
		const ms = this.options.applyTimeoutMs ?? APPLY_TIMEOUT_MS;
		// 超时以后它再失败也没人等了，不让它变成未处理的拒绝。
		applied.catch(() => undefined);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(text("plugin.applyTimeout", { name, seconds: String(ms / 1000) }))), ms);
			timer.unref?.();
		});
		try {
			await Promise.race([applied, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	private context(record: PluginRecord, dataDir: string): PluginContext {
		const name = record.status.name;
		const log: Logger = {
			info: (message) => this.options.log(name, "info", message),
			warn: (message) => this.options.log(name, "warn", message),
			error: (message) => this.options.log(name, "error", message),
		};
		const sessions = this.options.sessions ?? NO_SESSIONS;
		const generation = (record.generation = {});
		record.closing = false;
		const live = () => {
			if (record.closing || record.generation !== generation || (record.status.state !== "loading" && record.status.state !== "active"))
				throw new Error(text("plugin.disposed", { name }));
		};
		const own = (dispose: () => void | Promise<void>) => {
			live();
			record.disposers.push(dispose);
		};
		const network = new AbortController();
		own(() => network.abort());
		return {
			name,
			dataDir,
			fetch: async (input, init) => {
				live();
				const url = new URL(input);
				if (!/^https?:$/.test(url.protocol) || /^https?:\/\/[^/]*@/i.test(url.href)) throw new TypeError("Only HTTP(S) URLs without credentials are allowed.");
				return (this.options.fetch ?? globalThis.fetch)(url.href, {
					...init,
					credentials: "omit",
					redirect: "error",
					signal: AbortSignal.any([network.signal, ...(init?.signal ? [init.signal] : [])]),
				});
			},
			trash: async (path) => {
				live();
				if (!this.options.trash) throw new Error(text("files.trashUnavailable"));
				await this.options.trash(String(path));
			},
			log,
			model: this.options.model,
			media: this.options.media ?? NO_MEDIA,
			secrets: this.options.secrets?.(name) ?? NO_SECRETS,
			resources: {
				// 停用时撤下：重新加载的插件要能再登记同一个 scheme。插件自己撤下时也从清理表里拿掉，理由同 `tools.register`。
				register: (handler) => {
					live();
					const remove = this.workspace.resources.register(handler);
					const unregister = () => {
						const at = record.disposers.indexOf(unregister);
						if (at >= 0) record.disposers.splice(at, 1);
						remove();
					};
					own(unregister);
					return unregister;
				},
				list: () => this.workspace.resources.list(),
				keepArtifact: (sessionId, tool, content) => this.workspace.resources.keepArtifact(sessionId, tool, content),
			},
			workspace: this.workspace.workspace,
			changes: this.workspace.changes,
			appDataDir: this.options.appDataDir,
			sessions: {
				list: () => sessions.list(),
				get: (sessionId) => sessions.get(sessionId),
				messages: (sessionId) => sessions.messages(sessionId),
				compact: async (sessionId, options) => {
					live();
					return sessions.compact(sessionId, options);
				},
				setTitle: (sessionId, title, options) => sessions.setTitle(sessionId, title, options),
				setArchived: (sessionId, archived) => sessions.setArchived(sessionId, archived),
				create: async (options) => {
					live();
					return sessions.create(name, options);
				},
				launch: async (options) => {
					live();
					const launched = await sessions.launch(name, options);
					return {
						...launched,
						// 停用、重载以后不再替它交回：交回会给来处开一轮，那是一个已经不在的插件的意思。
						reportBack: (words, delivery) => {
							live();
							return launched.reportBack(words, delivery);
						},
					};
				},
				// 停用、重载以后不再替它转话、答卡：那是一个已经不在的插件的意思。
				post: async (sessionId, message) => {
					live();
					return sessions.post(name, sessionId, message);
				},
				respond: async (sessionId, toolCallId, decision) => {
					live();
					return sessions.respond(name, sessionId, toolCallId, decision);
				},
				answer: async (sessionId, toolCallId, value) => {
					live();
					return sessions.answer(name, sessionId, toolCallId, value);
				},
				models: () => sessions.models(),
				jobs: (sessionId) => sessions.jobs(sessionId),
				stopJob: (sessionId, jobId, force) => sessions.stopJob(sessionId, jobId, force),
				jobOutput: (sessionId, jobId) => sessions.jobOutput(sessionId, jobId),
				wakeups: (sessionId) => sessions.wakeups(sessionId),
				cancelWakeup: (sessionId, id) => sessions.cancelWakeup(sessionId, id),
				send: async (sessionId, message, options) => {
					live();
					return sessions.send(name, sessionId, message, options);
				},
				start: async (sessionId, message) => {
					live();
					return sessions.start(name, sessionId, message);
				},
				wait: (runId) => sessions.wait(name, runId),
				report: (runId, words, options) => sessions.report(name, runId, words, options),
				steer: async (sessionId, message) => {
					live();
					return sessions.steer(name, sessionId, message);
				},
				stop: (sessionId) => {
					live();
					sessions.stop(name, sessionId);
				},
				delete: async (sessionId) => {
					live();
					return sessions.delete(name, sessionId);
				},
				onStopped: (listener) => {
					if (typeof listener !== "function") throw new Error(text("session.badStoppedListener"));
					const entry = { plugin: name, listener };
					own(() => void this.stoppedListeners.delete(entry));
					this.stoppedListeners.add(entry);
				},
				observe: (listener) => {
					live();
					if (typeof listener !== "function") throw new Error(text("plugin.badListener"));
					const entry = { plugin: name, all: record.plugin?.observe === "all", listener };
					own(() => void this.observers.delete(entry));
					this.observers.add(entry);
				},
				onDeleted: (listener) => {
					if (typeof listener !== "function") throw new Error(text("plugin.badListener"));
					const entry = { plugin: name, listener };
					own(() => void this.deletedListeners.delete(entry));
					this.deletedListeners.add(entry);
				},
				onContextReset: (listener) => {
					if (typeof listener !== "function") throw new Error(text("plugin.badListener"));
					const entry = { plugin: name, listener };
					const off = () => {
						this.contextResetListeners.delete(entry);
						const at = record.disposers.indexOf(off);
						if (at >= 0) record.disposers.splice(at, 1);
					};
					own(off);
					this.contextResetListeners.add(entry);
					return off;
				},
				onArchived: (listener) => {
					if (typeof listener !== "function") throw new Error(text("session.badArchivedListener"));
					const entry = { plugin: name, listener };
					own(() => void this.archivedListeners.delete(entry));
					this.archivedListeners.add(entry);
				},
				onEnded: (listener) => {
					if (typeof listener !== "function") throw new Error(text("plugin.badListener"));
					const entry = { plugin: name, listener };
					own(() => void this.endedListeners.delete(entry));
					this.endedListeners.add(entry);
				},
			},
			pages: {
				...(Object.fromEntries(
					PAGE_METHODS.map((method) => [
						method,
						async (id: unknown, ...args: unknown[]) => {
							live();
							if (!this.options.pages) throw new Error(text("pages.unavailable"));
							return await this.options.pages.call(name, String(id), method, args);
						},
					]),
				) as Omit<WebPages, "onEvent">),
				onEvent: (listener) => {
					if (typeof listener !== "function") throw new Error(text("pages.badListener"));
					const entry = { plugin: name, listener };
					const off = () => {
						this.pageListeners.delete(entry);
						const at = record.disposers.indexOf(off);
						if (at >= 0) record.disposers.splice(at, 1);
					};
					own(off);
					this.pageListeners.add(entry);
					return off;
				},
			},
			locale: activeLocale,
			notice: (sessionId, message, level = "info") => {
				if (typeof sessionId !== "string" || typeof message !== "string") throw new Error(text("plugin.badNotice"));
				this.options.notice(sessionId, message, level === "warn" || level === "error" ? level : "info");
			},
			tools: {
				register: (tool) => {
					checkTool(tool);
					const list = this.tools.get(tool.name) ?? [];
					const taken = list.at(-1);
					if (taken) log.info(`工具 ${tool.name} 覆盖了插件 ${taken.plugin} 的同名工具`);
					const registered: RegisteredTool = { definition: tool, plugin: name, builtin: record.builtin };
					// 插件自己撤下（MCP 服务断开、改了配置）时也从清理表里拿掉：反复连断不该让清理表一直长。
					const unregister = () => {
						const at = record.disposers.indexOf(unregister);
						if (at >= 0) record.disposers.splice(at, 1);
						const rest = (this.tools.get(tool.name) ?? []).filter((entry) => entry !== registered);
						if (rest.length > 0) this.tools.set(tool.name, rest);
						else this.tools.delete(tool.name);
						this.options.toolsChanged?.();
					};
					own(unregister);
					this.tools.set(tool.name, [...list, registered]);
					this.options.toolsChanged?.();
					return unregister;
				},
				names: () => this.effectiveTools().map((entry) => entry.definition.name),
				list: () => this.toolOwners(),
			},
			plugins: {
				list: () => this.installed(),
				onChange: (listener) => {
					if (typeof listener !== "function") throw new Error(text("plugin.badListener"));
					const entry = { plugin: name, listener };
					own(() => void this.pluginListeners.delete(entry));
					this.pluginListeners.add(entry);
				},
			},
			hook: <N extends HookName>(hook: N, run: HookLayer<N>, options: { order?: number } = {}) => {
				if (!HOOKS.has(hook)) throw new Error(text("plugin.noHook", { hook: String(hook) }));
				if (typeof run !== "function") throw new Error(text("plugin.layerNotFunction"));
				const order = options.order ?? 0;
				if (!Number.isFinite(order)) throw new Error(text("plugin.orderNotNumber"));
				const layer: Layer = { plugin: name, order, seq: this.seq++, run: run as Layer["run"] };
				own(() => {
					const list = this.layers.get(hook);
					if (list)
						this.layers.set(
							hook,
							list.filter((item) => item !== layer),
						);
				});
				const list = [...(this.layers.get(hook) ?? []), layer].sort((a, b) => a.order - b.order || a.seq - b.seq);
				this.layers.set(hook, list);
			},
			effect: (dispose) => {
				if (typeof dispose !== "function") throw new Error(text("plugin.effectNotFunction"));
				own(dispose);
			},
			serve: (api) => {
				if (typeof api !== "object" || api === null) throw new Error(text("plugin.serveNotObject"));
				if (this.served.has(name)) throw new Error(text("plugin.servedTwice", { name }));
				own(() => {
					if (this.served.get(name) === api) this.served.delete(name);
				});
				this.served.set(name, api);
			},
			commands: {
				provide: (provider) => {
					if (typeof provider?.list !== "function" || typeof provider.expand !== "function") throw new Error(text("plugin.providerNotObject"));
					const entry: ProvidedCommands = { record, provider };
					own(() => {
						this.providers = this.providers.filter((item) => item !== entry);
					});
					this.providers = [...this.providers, entry];
				},
			},
			provide: (service, implementation) => {
				if (typeof service !== "string" || !SERVICE_NAME.test(service)) throw new Error(text("plugin.badService", { service: String(service) }));
				if (typeof implementation !== "object" || implementation === null) throw new Error(text("plugin.serviceNotObject", { service }));
				const list = this.offers.get(service) ?? [];
				if (list.some((offer) => offer.record === record)) throw new Error(text("plugin.providedTwice", { name, service }));
				const offer: Offer = { record, facade: facadeOf(implementation) };
				own(() => {
					const rest = (this.offers.get(service) ?? []).filter((item) => item !== offer);
					if (rest.length > 0) this.offers.set(service, rest);
					else this.offers.delete(service);
				});
				this.offers.set(service, [...list, offer]);
				const winner = this.current(service);
				if (winner !== offer && winner) log.warn(`服务 ${service} 由插件 ${winner.record.status.name} 提供，这一份不生效`);
			},
			use: (service) => {
				const offer = record.bound.get(service);
				if (!offer) throw new Error(text("plugin.notInjected", { name, service: String(service) }));
				return offer.facade as never;
			},
		};
	}

	/**
	 * 一项服务现在由谁提供：正在加载或已加载的提供方里，非内置的优先，同类里按插件加载的先后。
	 * 内置的是缺省实现，装上同名服务的插件就是要替换它。
	 */
	private current(service: string): Offer | undefined {
		const live = (this.offers.get(service) ?? []).filter((offer) => offer.record.status.state === "active" || offer.record.status.state === "loading");
		const ordered = live.sort((a, b) => this.records.indexOf(a.record) - this.records.indexOf(b.record));
		return ordered.find((offer) => !offer.record.builtin) ?? ordered[0];
	}

	/**
	 * 服务的提供方变了以后对一遍账：用的服务换了提供方的停用，再按现在的重新加载；等待中的插件缺的补上了就加载。
	 * 加载一个插件可能又带来新的提供方，所以一直对到没有变化。轮数有上限，防止两个插件互相把对方换下来。
	 */
	private async settle(): Promise<void> {
		for (let round = 0; round <= this.records.length; round++) {
			let changed = false;
			for (const record of this.records) {
				if (record.status.state !== "active" || [...record.bound].every(([service, offer]) => this.current(service) === offer)) continue;
				await this.unwind(record);
				record.status.state = "waiting";
				changed = true;
			}
			for (const record of this.records) {
				if (record.status.state !== "waiting" || !record.plugin) continue;
				await this.activate(record, record.plugin);
				if (record.status.state !== "waiting") changed = true;
			}
			if (!changed) return;
		}
		this.options.log("agent", "warn", "插件的服务一直在换提供方，停下不再对账");
	}

	/** 撤销插件的全部注册，后登记的先撤。某一项出错只记日志，其余照常撤销。 */
	private async unwind(record: PluginRecord): Promise<void> {
		record.closing = true;
		// 子会话先收尾，工具权限过滤层还在；撤层后再等会留下无保护的执行窗口。
		await this.options.sessions?.disposeOwner(record.status.name);
		record.bound.clear();
		const disposers = record.disposers.splice(0).reverse();
		for (const dispose of disposers) {
			try {
				await dispose();
			} catch (error) {
				this.options.log(record.status.name, "error", `清理出错：${errorText(error)}`);
			}
		}
	}
}

function validPlugin(module: unknown): Plugin {
	const plugin = module as Partial<Plugin> | undefined;
	if (typeof plugin !== "object" || plugin === null) throw new Error(text("plugin.badExport"));
	if (typeof plugin.name !== "string" || !NAME.test(plugin.name)) throw new Error(text("plugin.badName", { name: String(plugin.name) }));
	if (typeof plugin.apply !== "function") throw new Error(text("plugin.noApply", { name: plugin.name }));
	const inject: unknown = plugin.inject;
	if (inject !== undefined && (!Array.isArray(inject) || !inject.every((service) => typeof service === "string" && SERVICE_NAME.test(service)))) {
		throw new Error(text("plugin.badInject", { name: plugin.name }));
	}
	if (plugin.observe !== undefined && plugin.observe !== "all") throw new Error(text("plugin.badObserve", { name: plugin.name }));
	return plugin as Plugin;
}

/**
 * 交给用服务的插件的那一份：只有方法，绑在原对象上，冻住。用的插件改不了提供方的对象，
 * 也不会因为某个插件往上面挂了东西，别的插件拿到的服务跟着变。
 */
function facadeOf(service: object): object {
	const facade: Record<string, unknown> = {};
	for (let owner: object | null = service; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
		for (const key of Object.getOwnPropertyNames(owner)) {
			if (key === "constructor" || key in facade) continue;
			const fn = methodOf(service, key);
			if (fn) facade[key] = (...args: unknown[]) => fn.apply(service, args);
		}
	}
	return Object.freeze(facade);
}

function methodOf(api: object, method: string): ((...args: unknown[]) => unknown) | undefined {
	if (method === "constructor") return undefined;
	for (let owner: object | null = api; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
		if (!Object.hasOwn(owner, method)) continue;
		const value = (owner as Record<string, unknown>)[method];
		return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : undefined;
	}
	return undefined;
}

function checkTool(tool: ToolDefinition): void {
	if (typeof tool?.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error(text("tool.badName", { name: String(tool?.name) }));
	if (typeof tool.description !== "string") throw new Error(text("tool.noDescription", { name: tool.name }));
	if (typeof tool.parameters !== "object" || tool.parameters === null) throw new Error(text("tool.noParameters", { name: tool.name }));
	if (typeof tool.execute !== "function") throw new Error(text("tool.noExecute", { name: tool.name }));
	if (tool.aliases !== undefined && !validAliases(tool.aliases, tool.parameters)) throw new Error(text("tool.badAliases", { name: tool.name }));
}

/** 别名是参数里没有的名字，各只出现一次：不然换的时候会把一个真参数当别名删掉，或者一个别名不知道该换成哪个。 */
function validAliases(aliases: unknown, parameters: Record<string, unknown>): boolean {
	if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases)) return false;
	const properties = (parameters.properties ?? {}) as Record<string, unknown>;
	const seen = new Set<string>();
	for (const names of Object.values(aliases)) {
		if (!Array.isArray(names)) return false;
		for (const alias of names) {
			if (typeof alias !== "string" || !alias || Object.hasOwn(properties, alias) || seen.has(alias)) return false;
			seen.add(alias);
		}
	}
	return true;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
