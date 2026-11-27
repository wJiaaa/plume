# 接口参考

<!-- 由 `node scripts/check-plugins.mjs --fix` 从 packages/contract/src 生成，不要手改。摘哪些类型在 scripts/plugin-api-doc.mjs。 -->

插件拿到的 `ctx`、`run`、钩子的输入输出、`ui` 的全部成员，签名和注释摘自类型声明，以这里为准。很长，不整份读：搜成员名（`launch(`、`toolCard(`）跳到那一行。
怎么用、什么时候用哪个、有哪些坑在 [logic.md](logic.md)、[ui.md](ui.md) 按主题讲；签名里用到、这里没列的类型在 SDK 的类型声明里。

## 逻辑入口（`@plume/contract`）

默认导出 `Plugin`，`apply` 收到 `PluginContext`；工具定义成 `ToolDefinition`，执行时收到 `ToolRun`；钩子的每一层收到 `Hooks` 里那个钩子的输入、交回它的输出。

### `Plugin`

```ts
/** 逻辑入口 `dist/index.mjs` 的默认导出。 */
export interface Plugin {
	name: string;
	/**
	 * 要用的服务。都有插件提供了才调 apply，缺的时候插件处于「等待」状态，补上了自动加载；
	 * 提供方换了或停了，插件先停用，再按现在的提供方重新加载（缺了就回到等待）。
	 */
	inject?: readonly (keyof Services)[];
	/**
	 * `"all"`：`ctx.sessions.observe` 收全部会话的观察（每个会话的模型请求和回复、弹着的卡、运行状态），不只和本插件有关的那些
	 * （见 `SessionAccess.observe`）。诊断轨迹、一轮收场后跑用户的钩子、给每个会话写摘要这类插件要它；插件市场的详情页对装着的插件标出这一条。
	 * 不写就是只看和自己有关的会话。内置插件也一样要写。
	 */
	observe?: "all";
	/**
	 * `"sessions"`：插件要当会话的管理者（个人助理替人照看全部对话）。只是声明，不带权限：插件市场的详情页对装着的插件画一个开关，
	 * 人打开（先确认）后它才拿到授权（`SettingsView.sessionManager`），之后没有别的插件代管的顶层会话都按本插件代管算：
	 * `ctx.sessions` 的 `post`、`respond`、`answer`、`stop` 对它们可用，`observe` 收得到它们的观察。授权记在本机设置里，
	 * 同一时间只给一个插件；人关掉开关、插件停用或卸下时失效。「以后不再问」、删会话仍然只有人能做。
	 */
	manage?: "sessions";
	apply(ctx: PluginContext): void | Promise<void>;
}
```

### `PluginContext`

```ts
export interface PluginContext {
	readonly name: string;
	/** 插件私有的数据目录，加载前已创建。 */
	readonly dataDir: string;
	/** Plume 自己的数据目录（设置、会话、插件都在这里）。给模型用的工具不该写这里：写得到设置，就改得了自己的权限。 */
	readonly appDataDir: string;
	/** 只接受 HTTP(S) URL。响应兼容标准 fetch；取消信号和停用都会中止请求，超时和响应上限由插件决定。凭据只留在逻辑入口。 */
	readonly fetch: PluginFetch;
	/**
	 * 把一个文件或目录移到系统的废纸篓（Windows 上是回收站），人删错了还能从那里拿回来。宿主没有这个能力时抛错
	 * （比如 agent 不在桌面应用里跑）。
	 */
	trash(path: string): Promise<void>;
	readonly tools: {
		/** 停用时自动注销；返回的函数提前撤下这一个（工具来自会断开的外部服务时用），撤下后同名的前一个恢复。 */
		register(tool: ToolDefinition): () => void;
		/** 现在登记着的全部工具名（各插件的，同名只算一个），按登记先后。给要让人挑工具的插件用。 */
		names(): string[];
		/** 同 `ToolRun.tools()`：生效的工具、注册它的插件、它声明的类别。在钩子里按类别找工具（「记清单的那个叫什么」）时用。 */
		list(): RegisteredToolInfo[];
	};
	/** order 小的在外层，默认 0；相同时按注册先后。 */
	hook<N extends HookName>(name: N, layer: HookLayer<N>, options?: { order?: number }): void;
	/** 登记清理，插件停用时执行，后登记的先执行。 */
	effect(dispose: () => void | Promise<void>): void;
	/**
	 * 把一个对象开给自己的界面入口，界面入口用 `ui.remote()` 调它的方法；一个插件只能开一个，停用时收回。
	 * 方法的最后一个参数是 CallContext（运行时追加；需要响应取消的方法把参数个数写死）；返回异步迭代器的，
	 * 每个值推给界面，界面取消时 signal 中止。参数和返回值要能结构化克隆。
	 */
	serve(api: object): void;
	/**
	 * 插件自己的设置：一份对象，存在 `dataDir` 的 `settings.json`，界面入口经 `ui.useSettings()` 读、改，两边改了都通知两边。
	 * 读的时候和 `defaults` 浅合并，再交给 `normalize`（给了的话）校验、补齐；界面改的、逻辑入口改的都先合并进当前值、再过 `normalize`，
	 * 它抛错就不改、`set` 失败。没给 `normalize` 时只收 `defaults` 里有的键。写入排队、整份替换，连着改两项不会互相盖掉。
	 * 一个插件只能调一次，停用时收回。界面看得到全部内容：密钥不放这里（经 `ctx.secrets` 封好放进自己的文件）。
	 */
	settings<T extends object>(defaults: T, normalize?: (saved: Record<string, unknown>) => T): Promise<PluginSettings<T>>;
	/**
	 * 插件的一份运行状态，界面入口经 `ui.useStore(key)` 订阅，`set` 了界面跟着重画。只在内存里，停用或重启就回到 `initial`。
	 * 值要能结构化克隆，不宜太大（每次改都整份发给界面）；一连串事件、要中途取消的长调用仍走 `serve`。同一个 `key` 只能登记一次。
	 */
	store<T>(key: string, initial: T): PluginStore<T>;
	/**
	 * 同 `store`，但每个会话一份（`ui.useSessionStore(key, sessionId)`）：会话删掉时那一份跟着丢掉。没设过的会话读到 `initial`。
	 */
	sessionStore<T>(key: string, initial: T): PluginSessionStore<T>;
	readonly log: Logger;
	/** 插件自己调一次模型、画图、读花销，见 `ModelAccess`。 */
	readonly model: ModelAccess;
	/** 读写会话的媒体目录，见 `MediaAccess`。 */
	readonly media: MediaAccess;
	/** 把插件要存的密钥加密成一段文本、再解回来，见 `PluginSecrets`。本体提供，别的插件换不掉。 */
	readonly secrets: PluginSecrets;
	/** 资源地址（`scheme://路径`）：登记自己的 scheme、存大块原文换地址，见 `PluginResources`。本体提供，别的插件换不掉。 */
	readonly resources: PluginResources;
	/** 在宿主上读工作区仓库，不执行仓库能控制的程序，见 `PluginWorkspace`。本体提供，别的插件换不掉。 */
	readonly workspace: PluginWorkspace;
	/** 本体记下的改动快照汇总和撤销，见 `PluginChanges`。本体提供，别的插件换不掉。 */
	readonly changes: PluginChanges;
	/** 读会话，见 `SessionAccess`。 */
	readonly sessions: SessionAccess;
	/** 驱动界面入口画的网页（`<webview>`），见 `WebPages`。 */
	readonly pages: WebPages;
	/** 现在的界面语言。插件给人看的文字（审批理由之类）按它选；发给模型的不用。 */
	locale(): Locale;
	/** 在界面上弹一条提示（提示条），不管那个会话是不是正开着。level 默认 info。 */
	notice(sessionId: string, text: string, level?: NoticeLevel): void;
	/** 给输入框的 `/` 菜单供命令，见 `CommandProvider`。一个插件可以供几份，停用时一起撤下。 */
	readonly commands: { provide(provider: CommandProvider): void };
	/** 给模型设置添上插件自己保存的供应商，读、设默认模型，见 `PluginProviders`。 */
	readonly providers: PluginProviders;
	/** 装着的插件，见 `InstalledPlugin`。 */
	readonly plugins: {
		/**
		 * 现在启用着、已经加载好的插件，按加载先后（自己在 apply 里调时还不在其中）。给要读别的插件随包文件的插件用：技能插件读各插件的 `skills/`。
		 * 每次调用都是当时的样子：插件装上、卸下、停用以后再调就变了。
		 */
		list(): InstalledPlugin[];
		/**
		 * 插件装上、卸下、启用、停用以后叫一次，这时 `list()` 已经是新的样子；停用时撤下。给按别的插件随包文件配东西、
		 * 又不能等到下一轮才发现的插件用：MCP 插件读各插件的 `.mcp.json`，装上就连。
		 */
		onChange(listener: () => void): void;
	};
	/**
	 * 提供一项服务（见 `Services`），停用时撤下。同一项服务有几个插件提供时，非内置的优先于内置的，同是非内置的
	 * 先加载的那个生效；生效的那个换了，用它的插件都重新加载一遍。
	 */
	provide<K extends keyof Services>(name: K, service: Services[K]): void;
	/**
	 * 用一项服务。只能用 `Plugin.inject` 里写了的。拿到的是宿主包过的一份：只有方法，改不动它。
	 * 在这次加载里一直有效：提供方换了，插件会先停用再重新加载，到时重新拿。
	 */
	use<K extends keyof Services>(name: K): Services[K];
}
```

### `PluginSettings`

```ts
/** `ctx.settings` 的结果。 */
export interface PluginSettings<T extends object> {
	/** 当前的设置。 */
	get(): T;
	/** 合并进当前值、过 `normalize`、写盘、通知界面和 `onChange`，交回改好的值。 */
	set(patch: Partial<T>): Promise<T>;
	/** 设置变了（这边改的、界面改的）时调，返回取消订阅的函数；停用时自动撤下。 */
	onChange(listener: (value: T) => void): () => void;
}
```

### `PluginStore`

```ts
/** `ctx.store` 的结果。 */
export interface PluginStore<T> {
	get(): T;
	/** 换成新值并推给界面。 */
	set(value: T): void;
	update(change: (value: T) => T): void;
}
```

### `PluginSessionStore`

```ts
/** `ctx.sessionStore` 的结果。 */
export interface PluginSessionStore<T> {
	get(sessionId: string): T;
	set(sessionId: string, value: T): void;
	update(sessionId: string, change: (value: T) => T): void;
	/** 回到 `initial`，不再占内存。会话删掉时本体自己做。 */
	delete(sessionId: string): void;
}
```

### `SessionAccess`

```ts
/**
 * 子会话复用产品的循环、审批、存储和事件，插件只能运行自己拥有的会话。
 * 不开放任意向用户会话发送消息的能力：插件够得着的会话都从宿主给的句柄来，目标不由插件随手填。
 * - 新开的会话：`launch` 开一个新的顶层会话、发出第一句话，之后它就是人的会话，插件不能再往里发；
 * - 代管的会话：`launch({ steward: true })` 开出来的那些，人没停止代管时，开它的插件能经 `post` 往里转话、经 `respond`、`answer`
 *   替人答它和挂在它下面的子会话弹的卡、经 `stop` 停下它正在跑的那一轮；别的会话（人已有的、别的插件代管的）不行，插件自己也不能事后认领；
 * - 管理的会话：声明了 `Plugin.manage` 的插件，人在插件详情里把会话交给它管理（`AgentService.setSessionManager`）以后，
 *   没有别的插件代管的顶层会话它都能像代管一样转话、答卡、停下，人收回授权就不行了。同一时间只有一个插件拿着这份授权；
 * - 开出它的那个会话：开的时候要了 `reportBack` 的，开出来的会话每一轮的结果由宿主交回去（见 `SessionLaunch.spawnedFrom`），插件不经手；
 * - 调用所在的会话：`ToolRun.background` 送后台结果、`ToolRun.archiveAfterTurn` 收尾后归档；
 * - 子会话的父会话：插件自己建的子会话里，它注册的工具的那次调用拿得到 `ToolRun.parent`（排活、停下、接着做），
 *   人在子会话的卡片上点的 `ToolCardProps.handToParent` 同样只到父会话；
 * - 别的顶层会话：只经那次调用的 `ToolRun.letter` 寄信，发件方由本体照实填；
 * - 自己的子会话：`report` 把后台运行的结果交给它的父会话。
 * 写进去的话都标着运行时来处，不当成人的授权；`ToolRun` 上的句柄调用答完就失效。
 * 身份和工具限制由插件经 model.context、tool.execute 管理。
 */
export interface SessionAccess {
	/**
	 * 只读观察请求、工具开始、审批、重试和运行状态；副本不含配置密钥，停用时自动撤下。
	 * 只收到和本插件有关的会话的：本插件建的（`owner` 是它的子会话、独立会话），本插件代管或管理（`Plugin.manage`）的会话和挂在它下面的子会话，
	 * 本插件经 `launch` 开出、还没兑现 `idle` 的会话。要看全部会话的（诊断轨迹、按每个会话的运行状态做事）在 `Plugin.observe` 声明 `"all"`。
	 * 正在写的回复（`draft`，几十毫秒一份整条快照）只推给给了 `{ drafts: true }` 的这一个监听器，范围同上；要边写边转出去的（转到 IM）才订。
	 */
	observe(listener: (observation: SessionObservation) => void, options?: { drafts?: boolean }): void;
	/** 全部会话的摘要（含归档的、子会话），最近活动的在前。只为找一个会话时用 `get`。 */
	list(): Promise<SessionSummary[]>;
	/** 一个会话的摘要；没有这个会话（删掉了、id 不对）时是 undefined。给钩子之外拿不到 `SessionScope` 的地方（`serve` 的方法、事件回调）用。 */
	get(sessionId: string): Promise<SessionSummary | undefined>;
	/** 一个会话存下的全部消息，是会话里的原文，不受压缩影响。没有这个会话时抛错。 */
	messages(sessionId: string): Promise<Message[]>;
	/**
	 * 这个会话此刻弹着的那张卡（审批或等人给数据，同 `SessionView.approval`）；没有卡、没有这个会话时是 undefined。
	 * `observe` 只推变化，插件晚到（刚拿到管理授权、刚重新加载）时用它补上已经弹着的那张。只读：要答经 `respond`、`answer`。
	 */
	approval(sessionId: string): PendingRequest | undefined;
	/** 会话里登记过的后台任务（`ToolRun.track`），结束了的也在，按登记的先后；没有这个会话、没登记过时是空数组。 */
	jobs(sessionId: string): BackgroundJobInfo[];
	/** 叫一项后台任务停下（`force` 是强杀）；没有这一项、已经结束时返回 false，停不掉时抛错。 */
	stopJob(sessionId: string, jobId: string, force: boolean): boolean;
	/** 一项后台任务的尾部输出，见 `BackgroundJobOutput`；没有这一项时抛错。 */
	jobOutput(sessionId: string, jobId: string): Promise<BackgroundJobOutput>;
	/**
	 * 这个会话的临时目录（同 `ToolRun.scratchDir`）：工具截掉的全文、命令的完整输出都在里面，结果的 `details` 里记着路径。
	 * 要按路径读回这些文件的（诊断面板「查看完整输出」）用它确认路径在不在里面，不自己拼。目录可能还没建；没有这个会话时抛错。
	 */
	scratchDir(sessionId: string): Promise<string>;
	/** 会话里还没触发的唤醒（`ToolRun.schedule`），按下一次触发的先后；没有时是空数组。 */
	wakeups(sessionId: string): SessionWakeup[];
	/** 取消一个还没触发的唤醒；已经触发了、不存在时返回 false。 */
	cancelWakeup(sessionId: string, id: string): boolean;
	/**
	 * 现在就压缩这个会话（人敲了 `/compact`）：照常经钩子 context.compact（带 `force` 和 `manual`），转录里画一行
	 * `/compact` 和它的进度、结果。任何会话都行（压缩不替人说话，只改模型看到的历史）。会话正在跑、正在压、没有可用的模型、
	 * 没有这个会话时抛错，message 是给人看的话（按界面语言）。开始了就返回；`done` 在压完时给出结果，停止按钮能停下它。
	 */
	compact(sessionId: string, options?: { instructions?: string }): Promise<{ done: Promise<CompactionOutcome> }>;
	/**
	 * 改会话的标题（侧栏和标题栏上的那行字）。给起标题的插件用：宿主默认取第一条消息的开头。
	 * 空白压成一个空格、去掉首尾空白，最长 80 个字；改成空串不起作用。没有这个会话时抛错。
	 * 自动总结传 `automatic: true`：用户手动命名过就不覆盖；不传仍是显式设置标题。
	 */
	setTitle(sessionId: string, title: string, options?: { automatic?: boolean }): Promise<void>;
	/** 会话被删掉时调（插件按会话记的东西该清了，按会话起的进程该停了）。停用时自动撤下。 */
	onDeleted(listener: (sessionId: string) => void): void;
	/** 成功压缩、撤回或重建历史后刷新该会话的上下文快照；停用时自动撤下。 */
	onContextReset(listener: (sessionId: string) => void): () => void;
	/**
	 * 归档、取消归档一个会话，和侧栏上的归档按钮一样（`onArchived` 照常通知各插件）。只在人点了插件界面上的按钮时调
	 * （工作树合回去之后的「归档这个对话」），不拿来替人收拾侧栏；模型照人的要求归档它所在的会话走 `ToolRun.archiveAfterTurn`。子会话跟着父会话，不单独归档：传子会话、没有这个会话时抛错。
	 */
	setArchived(sessionId: string, archived: boolean): Promise<void>;
	/** 会话归档（`archived` 为真）、取消归档时调：按会话占着的东西该收起、该放回了（工作树插件收回目录、检出回来）。停用时自动撤下。 */
	onArchived(listener: (sessionId: string, archived: boolean) => void): void;
	/**
	 * 会话在这次运行里不再活着时调，带上原因（见 `SessionEndReason`），子会话跟着父会话各调一次。删除、归档、换项目时不等监听；
	 * 退出应用时等这一轮停稳后再调，最多等 2 秒就接着退出。监听抛错只记日志。停用时自动撤下。
	 */
	onEnded(listener: (sessionId: string, reason: SessionEndReason) => void | Promise<void>): void;
	/**
	 * 建一个记在这个插件名下（`owner`）的会话，只有这个插件能在里面发起一轮。
	 *
	 * - 给 `parentId`：子会话。工作目录、项目随父会话（`project`、`cwd` 不能再给）；没另选模型时跟着父会话的模型和思考档位；
	 *   父会话删掉时一起删。父会话不在、本身是子会话或插件的独立会话时抛错。
	 * - 不给 `parentId`：插件的独立会话，给插件自己的页面当一直在的助手用（经 `ui.Conversation` 画）。不挂在任何会话下，
	 *   在 `project` 或 `cwd`（已有目录的绝对路径）里跑，都不给就和不属于项目的聊天一样放在聊天目录里；没另选模型时用默认模型。
	 *   它不进侧栏、搜索、托盘、`@` 引用和已归档列表，不能归档，不收后台结果、不收发会话间的信，`prompt.submit` 给的 `cwd` 不换它的目录；
	 *   由插件经 `delete` 删掉（插件停用、卸载都不删，记录留着，下次启用时经 `list()` 按 `owner` 找回自己的；人在设置 › 数据里
	 *   按时间清理记录时和别的会话一起清掉）。
	 *
	 * 两种都不进侧栏。`title` 不给就取第一条消息的开头。模型、思考档位、项目、目录不对时抛错。
	 */
	create(options: {
		parentId?: string;
		title?: string;
		model?: string;
		thinking?: ThinkingLevel;
		/** 独立会话所在的项目（项目 id）；和 `cwd` 二选一，不能和 `parentId` 一起给。 */
		project?: string;
		/** 独立会话的工作目录（已有目录的绝对路径）；和 `project` 二选一，不能和 `parentId` 一起给。 */
		cwd?: string;
	}): Promise<SessionSummary>;
	/**
	 * 改本插件建的会话（子会话、独立会话）怎么跑，给了哪项改哪项、没给的不动，返回改完的摘要。和人在输入框里换模型、在侧栏换项目是同一件事：
	 *
	 * - `model`、`thinking`：取值同 `create`，`null` 清掉会话自己选的（子会话回到跟着父会话，独立会话回到默认）。下一轮生效；
	 *   这一轮正在等模型时换成新模型重发。
	 * - `project`、`cwd`：只有独立会话能换（子会话随父会话），取值同 `create`，给了 `project` 就不看 `cwd`；`cwd: null` 回到聊天目录。
	 *   换了目录，这段对话在旧目录里就算结束（`onEnded` 报 `moved`），下一轮在新目录里接着聊，记录不丢。正在跑时抛错。
	 *
	 * 会话不是本插件建的，模型、思考档位、项目、目录不对时抛错，什么都不改；message 是给人看的话（按界面语言）。
	 */
	configure(
		sessionId: string,
		change: {
			model?: string | null;
			thinking?: ThinkingLevel | null;
			project?: string;
			cwd?: string | null;
		},
	): Promise<SessionSummary>;
	/**
	 * 开一个新会话并发出第一句话（定时任务到点了、人在插件界面上点了「在新会话里执行」）。新会话和人在侧栏新建的一样：
	 * 进侧栏、不记在插件名下（没有 `owner`），人能接着聊，插件之后不能再往里发、也停不了删不了它（`steward` 开出来的除外：
	 * 本插件能往里转话、替人答卡，见 `SessionLaunch.steward`）。第一句话照常经
	 * `prompt.submit`，可能被拦下（这一轮按完成收场）。只能开新的，对已有会话说不上话；给了 `spawnedFrom.reportBack` 的，宿主每轮替它交回来处。
	 * 建好就返回：`session` 是新会话的摘要，`done` 在这第一轮结束时给出它为什么结束（之后人接着聊的几轮不算）。
	 * `idle` 在它第一次真闲下来时兑现：第一轮结束，它派出去的后台运行都回来了、送回的结果唤起的几轮也做完了，登记着的一次性后台任务
	 * 都结束了（被人停掉、撤回而作废的不算在等；挂着的监视、开发服务器、约好的唤醒和 cron 不等，见 `ParentStatus`）。
	 * 项目、目录、模型、思考档位、`spawnedFrom` 不对时抛错，message 是给人看的话（按界面语言）。
	 */
	launch(options: SessionLaunch): Promise<LaunchedSession>;
	/**
	 * 往本插件代管的会话里转一句话（外面的人经插件发来的消息；拿着管理授权的插件对没有别的插件代管的顶层会话也能转，见 `Plugin.manage`）：排进这个会话的队（和人在输入框里排的同一条，落盘），
	 * 会话闲着就当场开一轮，正在跑就排着，不插进这一轮。气泡标着来自本插件（`UserMessage.origin` 是 `plugin`，`fromPlugin` 是本插件），
	 * 模型读到的前面多一句本体写的来处说明：这是代管插件转来的，不是人在 Plume 的输入框里打的。权限、审批照这个会话的设置，不因来处而变。
	 * `started` 是排上那一刻它就开始了。会话不在、不是本插件代管或管理的（没代管过、人停止了代管或收回了管理授权）、是子会话（子会话里的一轮归建它的插件发起）、
	 * 已归档、话为空时抛错。
	 * 回复和收场经 `observe`（`response`、`turnEnd`）和 `messages` 读；哪些转出去由插件自己定。
	 */
	post(sessionId: string, message: string): Promise<{ started: boolean }>;
	/**
	 * 替人答本插件代管（或管理，见 `post`）的会话里弹着的那张审批卡（`approval` 事件、`SessionView.approval` 里第一张，按 `toolCallId` 认）：`once` 放行这一次，
	 * `reject` 拒绝；对等人给数据的卡（`HumanRequest`）`reject` 是不答。和人在桌面上点卡同一条路，提权也算：人和插件谁先答算谁的，
	 * 另一边的卡随之收起。「以后不再问」改的是人的设置，插件答不了。卡上的东西怎么转给外面的人、答的人是不是该答的人，由插件负责确认。
	 * 挂在代管会话下面的子会话（模型派的子智能体、人开的侧边聊天，不管是哪个插件建的）弹的卡也能这样答，`sessionId` 传子会话的 id
	 * （`approval` 事件带的那个）；看的是父会话此刻是不是本插件代管着。
	 * 答上了返回 true；那张卡已经不在（答过了、过期了、这一轮停了）、不是这一张时返回 false。会话不是本插件代管或管理的（子会话：父会话不是）时抛错，
	 * 人停止代管、收回管理授权以后也抛错：那时还弹着的卡只能人答。
	 * 这次调用的结果里记着是哪个插件代答的（`ToolResultMessage.answeredBy`），模型读到的结果后面也写明这一点。
	 */
	respond(sessionId: string, toolCallId: string, decision: "once" | "reject"): Promise<boolean>;
	/**
	 * 替人交回本插件代管的会话（或它下面的子会话）里弹着的那张等人给数据的卡（`ToolRun.request`：提问、表单、计划）要的数据，同 `AgentService.answer`。
	 * `value` 由工具自己核。能答哪些会话、返回值、抛错和记下代答者同 `respond`。
	 */
	answer(sessionId: string, toolCallId: string, value: unknown): Promise<boolean>;
	/** 可用模型目录，只含名称、窗口和思考档位。 */
	models(): Promise<SessionModel[]>;
	/** 登记过的项目，按侧栏的顺序：`launch`、`create`、`configure` 的 `project` 填这里的 `id`。界面入口里用 `ui.useProjects()`。 */
	projects(): Promise<ProjectInfo[]>;
	/**
	 * 开始自己的子会话的一轮，立即交回句柄；首次运行固定实际模型与思考档位，续跑沿用。父轮正常结束不取消，明确停止父会话则取消。
	 * 这一次运行结束时，本体停掉这个子会话还在跑的后台任务（`ToolRun.track`）：子会话收不到后台送达，留下来就没人管了。
	 */
	start(sessionId: string, message: string | SessionMessage): Promise<SessionRun>;
	/** 等待自己的后台运行结束，失败和停止也正常交回原因。 */
	wait(runId: string): Promise<TurnStop>;
	/** 把已结束运行的结果交给其父会话。忙时在安全步骤边界送入，闲时唤起；已停止、重复或所属会话被删除则返回 false。 */
	report(runId: string, text: string, options?: ReportOptions): Promise<boolean>;
	/** 给自己正在运行的子会话插话，不打断当前工具；空闲时拒绝，需显式 send/start 开新轮。 */
	steer(sessionId: string, message: string | SessionMessage): Promise<void>;
	/** 人明确停止会话时通知，包括父会话；供插件撤销尚未开始的排队工作，停用时撤下。 */
	onStopped(listener: (sessionId: string) => void): void;
	/**
	 * 在自己建的子会话里发一句话、跑一轮，等这一轮结束，返回它为什么结束；回复在 `messages` 里。
	 * 这句话照常经 `prompt.submit`，界面画成人的气泡。正在跑、不是自己建的会话时抛错。`signal` 中止时这一轮停下。
	 */
	send(sessionId: string, text: string | SessionMessage, options?: { signal?: AbortSignal }): Promise<TurnStop>;
	/**
	 * 停下正在跑的那一轮，和人按停止同一条路；没在跑什么都不做。能停的：自己建的会话（子会话、独立会话），
	 * 本插件代管或管理的顶层会话（见 `post`）。别的会话抛错。
	 */
	stop(sessionId: string): void;
	/** 删掉自己建的子会话（和它下面的子会话）；正在跑的先停下。 */
	delete(sessionId: string): Promise<void>;
}
```

### `ModelAccess`

```ts
/** 插件调模型、读模型调用的花销。 */
export interface ModelAccess {
	/**
	 * 调一次模型做一件小事（写一句提交说明、起个标题、写压缩摘要）：不带工具、不思考（`fork` 的除外，见那里）、不写进任何会话，也不经 `model.context`。
	 * 没配默认模型、没有 key、服务商报错时抛错，message 是给人看的话（按界面语言）。
	 */
	complete(request: ModelCompletion): Promise<string>;
	/**
	 * 找生图模型（启用的供应商下、模型设置里标成生图模型的）。不给 `name` 是设置里选的默认生图模型，没选或已不可用时是第一个；
	 * 给了按人的说法认：本地 id、模型 id、显示名，再是唯一的部分匹配。对不上、对上几个都不悄悄换成默认的。每次调用按当时的设置。
	 * 给了 `sessionId` 时默认生图模型按那个会话所在项目的配置（`.plume/config.json` 的 `imageModel`）取；会话不存在时抛错。
	 */
	findImageModel(name?: string, sessionId?: string): Promise<ImageModelMatch>;
	/**
	 * 用生图模型画图、改图：用模型所在供应商的地址和 key（key 不出宿主），先试这个端点更可能有的那条路（Images API 或 chat），
	 * 端点说没有就换另一条，记住走通的。网络抖动重试两次；额度用完、key 不让用、内容被拒这类不会变的直接交回失败。
	 * 模型不是生图模型、不在了、供应商讲 Anthropic 协议（画不了）时抛错。
	 */
	image(request: ModelImageRequest): Promise<ModelImageResult>;
	/**
	 * 每一次计费的模型调用（回复、压缩摘要、插件的 `complete`），按小时、供应商、模型合好，最早的在前；删会话不影响这些数。
	 * 只读，给画使用统计的插件用。读会话库失败时抛错。
	 */
	usage(): Promise<UsageScan>;
}
```

### `MediaAccess`

```ts
/**
 * 会话的媒体目录：会话里的图片挪出消息后按内容（sha1）存在这里，消息里只留名字（`ImageContent.media`）。
 * 存进去的名字和会话存图时起的一样，同一张图不会存两份。图跟着用它的会话走：最后一个用它的会话删掉时文件一起删。
 */
export interface MediaAccess {
	/**
	 * 存一张图，交回名字和磁盘上的绝对路径。只认 PNG、JPEG、WebP、GIF、BMP，别的抛错。
	 * `sessionId` 是这张图属于哪个会话（工具里存的就是 `run.sessionId`）：那个会话删掉、也没有别的会话用着时图一起删。
	 * 不给的算插件自己的，一直留着；会话已经不在时这张图不算它的。
	 */
	save(image: { data: string; mimeType: string; sessionId?: string }): Promise<{ name: string; path: string }>;
	/** 按名字读回一张图；名字不是这个目录的、文件不在时是 null。 */
	read(name: string): Promise<{ data: string; mimeType: string } | null>;
	/** 一个绝对路径是不是这个目录里的图：是的话交回名字，不是是 null。 */
	nameOf(path: string): string | null;
}
```

### `PluginSecrets`

```ts
/**
 * 插件的 `ctx.secrets`：把要存的密钥（令牌、密码、请求头里的凭据）加密成一段文本，插件把它写回自己的配置文件。
 * AES-256-GCM，钥匙由本体从它给供应商 key 用的那把（`vault.key`）按插件名派生：各插件的密文互相解不开。
 *
 * 只管加解密，不替插件存：密文跟着它所属的那条配置走，删掉配置就是删掉密钥，不用另外清。
 * 挡的是配置文件被同步、拷走、贴进问题报告时带出明文，以及一个插件的密文被抄进另一个插件的配置后被它解开；
 * 挡不住同一台机器上同一个用户的程序——钥匙就在数据目录里，插件也都跑在同一个进程里。
 */
export interface PluginSecrets {
	/** 加密一个值，返回带固定前缀的文本（`isSealed` 认得出），能放进 JSON 之类的任何文本里。 */
	seal(value: string): Promise<string>;
	/**
	 * 解回来。不是 `seal` 出来的、不是这个插件封的、或者这把钥匙打不开（钥匙丢了换了新的、密文来自别的机器）时是 null，当成「要重新填」。
	 * 钥匙文件在却读不出来时抛错：这时不能当成「没了」，否则调用方把空值写回去，等钥匙又读得出来时已经没东西可解了。
	 */
	unseal(sealed: string): Promise<string | null>;
	/** 这段文本是不是 `seal` 出来的样子：手写进配置的明文和密文分得开。 */
	isSealed(value: string): boolean;
}
```

### `PluginProviders`

```ts
export interface PluginProviders {
	/** 登记一个供应商来源，见 `ProviderSource`。 */
	provide(source: ProviderSource): void;
	/**
	 * 自己的供应商变了（外部应用改了网关、模型列表）：调一下，界面跟着重新取模型设置。本体不会自己去问 `list()`，不调的话设置页、
	 * 模型菜单要等人下次在界面上改了什么才看到。登记、撤下来源和 `setDefaultModel` 不用调，本体自己会通知。
	 */
	changed(): void;
	/** 人设的默认模型（`供应商 id/模型 id`），可能已经失效；没设过是 undefined。 */
	defaultModel(): Promise<ModelRef | undefined>;
	/** 设默认模型，和设置页设的一样：要是启用着的供应商下的对话模型，否则抛错。 */
	setDefaultModel(model: ModelRef): Promise<void>;
}
```

### `PluginWorkspace`

```ts
/**
 * `ctx.workspace`：在宿主进程里读工作区仓库。工作区是沙箱可写的，仓库的配置（`.git/config`、`.gitattributes`）也是：直接跑 git 会替沙箱里的命令
 * 执行它写进去的程序（`core.fsmonitor`、过滤器、钩子），所以本体在一个读不到仓库配置的隔离视图里问 git。插件要列项目文件就用它，不自己跑 `git ls-files`。
 */
export interface PluginWorkspace {
	/**
	 * `root` 之下 git 认为该看的文件（已跟踪且还在磁盘上的，加上未跟踪且没被忽略的；隐藏的也算），绝对路径，以 `root` 开头。
	 * 不在 git 仓库里、或 git 答不上来时是 null，由调用方自己走目录。不问人：要不要读 `root` 由调用方先经 `ToolRun.files.read` 判。
	 */
	files(root: string): Promise<string[] | null>;
	/**
	 * 在同一个隔离视图里跑一组 git 命令，结束即删：HEAD、引用、分支的上游和远端地址都照着真实仓库抄好，分支、ahead / behind、
	 * 日志上的装饰和在真实仓库里跑一样，读不到仓库自己的配置（`core.fsmonitor`、过滤器、`diff.external`、钩子）、也不会连网。
	 * 一组读共用一个视图：搭一个要先跑几条命令，每条命令各搭一个就是每次刷新几十个进程。
	 *
	 * `root` 不在检出里时 `work` 不跑，交回 null。只读：暂存、提交、推送、切分支这些人点了才做的事仍由插件自己在真实仓库上跑，
	 * 那样钩子、凭据助手正是人要的。除了要写 stdin 的那一个（`gitWithInput`，`cat-file --batch`），
	 * 要按二进制读的用 `gitBuffer`：`git show HEAD:logo.png` 回的不是文字。
	 */
	git<T>(root: string, work: (view: PluginGitView) => Promise<T>): Promise<T | null>;
}
```

### `PluginResources`

```ts
/** `ctx.resources`：资源地址，见本文件开头。 */
export interface PluginResources {
	/**
	 * 加一个 scheme，返回撤下它的函数；插件停用时本体替它撤下。登记的只留读的几样（`ResourceHandler` 上的方法），塞了 `write` 也写不进去。
	 * scheme 已被占用、写法不对时抛错。
	 */
	register(handler: ResourceHandler): () => void;
	/** 现在登记着的全部 scheme，按名字排：要在提示词里告诉模型有哪些地址、要认出一个参数是不是地址时用。 */
	list(): ResourceScheme[];
	/**
	 * 把一大块原文（被剪掉的工具结果）存起来，换回 `artifact://<id>` 地址，模型要时按窗口取回。
	 * 地址按 `tool` 和内容算：同一段原文每次换回同一个地址，从历史重建出的占位标记逐字不变。
	 * 按会话存在内存里，每个会话最多留 30 份、超了丢最旧的；重开应用、会话删掉后就没有了。
	 */
	keepArtifact(sessionId: string, tool: string, content: string): string;
}
```

### `PluginChanges`

```ts
/**
 * `ctx.changes`：本体记下的改动快照汇总和撤销（交付卡、侧边聊天告诉主会话它改过哪些文件）。快照标识来自工具结果的
 * `ToolResultMessage.changes.ids`，不接受界面传来的文件原文；工作目录用会话自己的。本体提供，别的插件换不掉。
 */
export interface PluginChanges {
	/** 这组快照的净变化：同一文件只算首次写之前到末次写之后，改回原样的不列；快照读不出来时 `warnings` 不为空。没有这个会话时抛错。 */
	collect(sessionId: string, ids: readonly string[]): Promise<FileChangesSummary>;
	/** 撤销这组快照改过的文件，`path` 不给时全部；写入前重新校验快照、当前内容和项目边界，有一个不对就都不写，抛错的 message 给人看。 */
	undo(sessionId: string, ids: readonly string[], path?: string): Promise<void>;
}
```

### `WebPages`

```ts
/**
 * 网页：插件界面入口自己画的 `<webview>`，各自一个进程，逻辑入口经这里驱动它。页面只有主进程碰得到，所以加载、执行脚本、
 * 原生输入、截图、缩放和视口、开发者工具、对话框由宿主做；标签、地址栏、给模型的工具都是插件自己的。
 *
 * 界面入口在 `<webview>` 的 `did-attach` 事件里取 `getWebContentsId()`，经自己的 `remote()` 交给逻辑入口，逻辑入口
 * 用 `attach` 把它认作自己起的页面 id（只在本插件内有效）。不管标签上写了什么，宿主都把页面放进沙箱、拿掉 Node 和预加载脚本，
 * 分区固定是持久化的 `persist:plume-web`（登录状态跨重启保留，各插件共用）；只开 http、https 和 about:blank，摄像头、定位这类权限一律不给。
 * 主窗口和弹出去的面板窗口里的 `<webview>` 都能挂上；标签弹出去、接回来时 `<webview>` 换了一个，页面按记着的地址重新加载、重新 `attach`。
 * 页面没挂着时调用报错。
 */
export interface WebPages {
	/**
	 * 在独立、无持久数据的沙箱里加载 http(s) 页面，返回首屏异常、控制台错误和内容高度，可截取从 from 开始的最多 2160px。
	 * 不挂界面、不共享浏览器登录、不允许导航、弹窗、下载或设备权限，最长 12 秒后销毁。width 默认 720，范围 320–1600。
	 * measure 是插件提供的测高表达式（返回有限正数）；省略时使用文档滚动高度。不按用户手势执行。
	 */
	inspect(url: string, options?: { width?: number; from?: number; screenshot?: boolean; measure?: string }): Promise<WebInspection>;
	/**
	 * 把界面入口的一个 `<webview>`（`getWebContentsId()` 拿到的 id）认作页面 `id`，随即报 `attached`。同一个 `<webview>` 再认一次
	 * 什么都不做；这个 id 正连着另一个还活着的 `<webview>` 时换成这一个（旧的不再算，卸掉时不报 `detached`）。
	 * 这个 `<webview>` 已被别的插件或别的 id 认走、或不是 Plume 窗口里的 `<webview>` 时报错。
	 */
	attach(id: string, contentsId: number): Promise<void>;
	/** 这一页的现状；没挂着时是 null。 */
	state(id: string): Promise<WebPageState | null>;
	/** 加载这个地址，不等它加载完（看事件）。只认 http、https 和 about:blank。 */
	load(id: string, url: string): Promise<void>;
	/** 后退、前进、刷新；没有上一页、下一页时什么都不做。页面进程没了时 `reload` 重新起一个。 */
	go(id: string, step: "back" | "forward" | "reload"): Promise<void>;
	/**
	 * 在页面里求一个表达式的值（可以是 Promise，等它有结果），结果要能结构化克隆。按用户手势执行（能开全屏、播放声音）。
	 * `isolated` 在只属于这个插件的隔离 world 里跑：和页面共享 DOM，但看不到页面的全局变量，页面也看不到它的。
	 * 页面卡住时这次调用一直不回来，要限时就自己 race。
	 */
	evaluate(id: string, code: string, options?: { isolated?: boolean }): Promise<unknown>;
	/** 一次原生输入（指针、按键），和人在页面上操作一样触发页面的事件。 */
	input(id: string, event: WebInputEvent): Promise<void>;
	/** 在焦点处插入一段字，和输入法上屏一样。 */
	insertText(id: string, text: string): Promise<void>;
	/** 把键盘焦点给这一页。 */
	focus(id: string): Promise<void>;
	/**
	 * 截下这一页此刻画着的样子（或 `rect` 那一块，视口坐标乘缩放），垫上白底（页面没设背景的地方本来是透明的），PNG 的 data URL。
	 * 默认是物理像素；`points` 按屏幕的缩放比缩回点（高分屏上宽高减半），给模型看的图用它，不白占上下文。
	 */
	capture(id: string, options?: { rect?: { x: number; y: number; width: number; height: number }; points?: boolean }): Promise<string>;
	/** 缩放倍数，0.25–3。Chromium 按源共享缩放，换页后要再设一次。 */
	setZoom(id: string, factor: number): Promise<void>;
	/**
	 * 把视口仿真成这个尺寸（CSS 像素），再按 `scale` 缩小放进挂着它的地方；null 恢复成挂着它的地方那么大。
	 * 页面进程没了时不起作用，重新加载后要再设一次。
	 */
	emulate(id: string, viewport: { width: number; height: number; scale: number } | null): Promise<void>;
	/** 在独立窗口里开这一页的开发者工具。 */
	devtools(id: string): Promise<void>;
	/**
	 * 之后这一页弹的 alert、confirm、离开页面提示由宿主直接答，不弹给人：alert 确定，其余按 `accept`；传 null 恢复成弹给人。
	 * 设上时，已经弹着、等人点的那一个也当场按它答掉。每答一个报一条 `dialog` 事件。`prompt` 不在其中：页面调用时直接拿到 null。
	 */
	answerDialogs(id: string, accept: boolean | null): Promise<void>;
	/**
	 * 从本机 Chrome 同步登录状态（全部 cookie，单向：同一条以 Chrome 为准，Chrome 里没了这边也删）进网页的分区，各插件共用。
	 * `status` 看现状；`on` 先由宿主弹系统对话框请人确认，人不同意就照旧关着；`off` 关掉并删掉同步进来的 cookie。
	 * cookie 的值只在主进程里，不交给插件。
	 */
	chromeLogins(command: "status" | "on" | "off"): Promise<ChromeLoginSync>;
	/** 订阅本插件全部网页的事件，返回取消订阅的函数；停用时自动撤下。 */
	onEvent(listener: (event: WebPageEvent) => void): () => void;
}
```

### `Services`

```ts
/**
 * 服务名 → 服务的接口。服务是一个插件开给别的插件用的一组方法：提供的插件经 `ctx.provide` 给出实现，用的插件把
 * 服务名写进 `Plugin.inject`、经 `ctx.use` 拿到。依赖的是名字，不是某个插件，所以谁提供都行，能整个换掉。
 * 仓库外的插件给自己的服务用声明合并加一项：`declare module "@plume/contract" { interface Services { … } }`。
 */
export interface Services {
	"session.worktree": SessionWorktreeService;
	"session.plan": SessionPlanService;
	"mcp.servers": McpServersService;
	"terminal.exec": TerminalExecService;
}
```

### `ToolDefinition`

```ts
export interface ToolDefinition {
	name: string;
	description: string;
	/** JSON Schema。 */
	parameters: Record<string, unknown>;
	/**
	 * 模型常把参数名写错时，宽容地认哪些：规范名（`parameters` 里的）→ 模型会写成的别名（`{ path: ["file", "filePath"] }`）。
	 * 宿主在这一步的回复写进会话之前就换好：规范名没给（或是 null）时取第一个给了的别名，别名一律从参数里删掉；
	 * tool.execute 的层改写参数往里交时又写成别名的，交给里层之前再换一次。于是 tool.execute、tool.approve 的各层、审批卡、转录、导出、压缩和工具自己看到、存下的都是规范名：按参数拦调用的守卫
	 * 不会因为模型换了个写法就读不到，工具和别处也不用各抄一份别名表。别名不能是 `parameters.properties` 里的名字。
	 */
	aliases?: Record<string, readonly string[]>;
	/** 会改动工作区（写文件、执行命令）：不和相邻的调用同时跑；没写 `asks` 的，宿主在执行前按参数问用户。 */
	mutating?: boolean;
	/** `mutating` 的工具里，这一次调用能证明什么都不改（只读的命令）：可以和相邻的只读调用同时跑。 */
	readsOnly?(args: Record<string, unknown>): boolean;
	/** 工具自己在 execute 里经 `run.ask` 问（能给出 diff、命令原文），宿主不在执行前替它问。 */
	asks?: boolean;
	/**
	 * 导出会话成 Markdown 时这一次调用写成的一行（英文，「Generate image a red fox」）。不给、返回空或抛错时写工具名。
	 * 导出在 agent 进程，够不着界面入口的 `ui.toolLine`，所以说法跟着工具定义走。
	 */
	describe?(args: Record<string, unknown>): string | undefined;
	/**
	 * 导出会话成 Markdown 时，这次调用的结果里要引出来的那段（子智能体交回的结论）：写在调用列表后面，引成一段。
	 * 不给、返回空或抛错时不引，结果照旧不导出。
	 */
	exportResult?(result: ToolResultMessage): string | undefined;
	/**
	 * 这一次调用是替另一个工具调的（工具多了按需加载时，模型经一个总入口按名字调它们）：返回被调的那个工具和交给它的参数。
	 * 导出会话成 Markdown 时这一行按被调的那个写（它的名字、它的 `describe`）。不是转调的调用返回 undefined。
	 */
	forwards?(args: Record<string, unknown>): { name: string; args: Record<string, unknown> } | undefined;
	/**
	 * 做的是哪种活（见 `ToolKind`）。一个工具做什么只在这里声明一次，宿主、界面和别的插件都从这里认，不认工具名
	 * （`run.tools()`、`ctx.tools.list()`、`AgentService.listTools()` 带着它）：
	 * - 转录按它给默认的说法、图标、运行行和归类，回复里的文件签按 `view`、`create`、`modify` 的调用认读写过的文件（从参数里取什么见 `ui.toolLine`）。
	 * - `create`、`modify` 成功一次就是工作区有了实打实的进展：重复检测从头数，同样的调用之前反复得到同样的结果不再算原地打转。
	 * - 给模型一套收窄的工具表的插件按它留下工具（侧边聊天留读、搜、改、跑命令的，只读的子智能体留读和搜的），提示词要点名
	 *   「读文件的那个」「跑命令的那个」时按它在工具表里找它叫什么。
	 *
	 * 不给的不算这几种活：转录照没登记说法的工具说，自成一类。
	 */
	kind?: ToolKind;
	/**
	 * 这是哪一类能力，宿主和别的插件按它认，不认工具名（`run.tools()`、`ctx.tools.list()` 带着它）：
	 * - `mcp`：MCP 服务的工具（连同按需搜索、调用它们的总入口）。上下文用量里单独算「MCP 工具」一段。
	 * - `checklist`：记进度清单的工具，结果的 `details` 带 `ChecklistDetails`。转录把它的调用当成一段活的记账：跟旁边那段活接成一段、
	 *   不自己占一行，一段里有别的活时总的那句不数它，回答之后被替人追问、只更新了清单的那一步不画，运行行说在排步骤。
	 *   别的插件要对模型说「用它记下步骤」时，按这一类在工具表里找它叫什么，找不到就不说。
	 * - `question`：停下来问人一个问题、等人回答的工具（经 `run.request`）。别的插件要对模型说「拿不准就问人」时同样按这一类找。
	 * - `web`：只读地查网页的工具（搜索网页、把网址读成文字），不碰工作区。给模型一套收窄的工具表的插件按这一类留下它们。
	 * - `delegate`：把一件活派给子智能体、等它交回结论的工具。别的插件要对模型说「派子智能体去做」时按这一类找它叫什么，
	 *   找不到就换成不派、自己做的说法；怎么填它的参数归它自己的说明。
	 *
	 * 不给的算普通工具。做的是哪种活（读、改文件、跑命令）用 `kind`，不在这里。
	 */
	category?: "mcp" | "checklist" | "question" | "web" | "delegate";
	execute(args: Record<string, unknown>, run: ToolRun): Promise<ToolOutput>;
}
```

### `ToolOutput`

```ts
export interface ToolOutput {
	/** 交给模型的结果。 */
	output: string;
	/**
	 * 跟在 `output` 后面一起交给模型的图（base64，不带 `data:` 前缀）。大图由本体存进会话的媒体目录，不撑大会话文件。
	 * 模型只收 PNG、JPEG、WebP、GIF：BMP 照样存下、画给人看，发给模型时换成一句 `[unsupported image: image/bmp]`。
	 */
	images?: { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/bmp" }[];
	isError?: boolean;
	/**
	 * 只给人看、不交给模型的图，形状同 `images`：太大、不值得每轮重发给模型的图放这里，模型在 `output` 里拿到一句说明和存放的路径。
	 * 本体照 `images` 把大图挪进媒体目录，通用卡片把它画在 `images` 后面。
	 */
	shownImages?: ToolOutput["images"];
	/**
	 * 给工具卡片和插件自己用的结构化数据，存进会话，不发给模型。形状由插件定，本体不看里面，只认这几个通用声明：
	 * 带 `checklist`（`ChecklistDetails`）是一份进度清单，带 `job`（`BackgroundJobDetails`）是在后台起了一个任务，
	 * 带 `path`、`added`、`removed`、`hunks`（`FileDiffDetails`）是改了一个文件、通用卡片画出 diff，
	 * 出错的结果带 `cancelled: true`（`CancelledDetails`）是人按了停、不是失败，带 `unanswered`（`UnansweredDetails`）是人没答、
	 * 也不是失败，带 `spill`（`SpillDetails`）是结果截过、全文在别处。
	 * 插件之间另认一个：让模型看了文件的哪一块（`FileViewDetails`）。改了哪些文件不在这里，见 `changes`。
	 */
	details?: unknown;
	/**
	 * 这次调用改了哪些文件（`FileChanges`），由本体填：经 `ToolRun.files.change` 写成的、经 `ToolRun.exec`（`recordChanges`）观测到的命令改的，
	 * 和 `ToolRun.files.includeChanges` 算进来的。工具自己填的不算，钩子 tool.execute 的外层读得到、改不了（本体最后照它记下的重填）。
	 * 记进会话里的结果（`ToolResultMessage.changes`），撤回连文件一起退、交付卡、压缩都按它认改过的文件。
	 */
	changes?: FileChanges;
	/**
	 * 这一步的结果都写进会话以后，这一轮就此结束，不再把结果交给模型：`done` 是完成，`stalled` 是卡住了。
	 * 一步里有几个结果都带了它时，有 `stalled` 就按 `stalled`。结果本身照常存，下一轮模型照样看得到。
	 */
	terminate?: "done" | "stalled";
	/**
	 * 这条结果之后不会再有人要读（没搜到、空目录）：记在会话里的结果上，压缩剪枝时它的正文换成一句「无结果」，
	 * 不占后面每一轮的上下文。给人看的卡片照旧是原文。
	 */
	uneventful?: boolean;
	/**
	 * 这条结果是要照着做的说明（载入的技能正文这类），不是一次观察：记在会话里的结果上，压缩时原样留着，
	 * 不按大小剪，也不当作被后来的结果顶替的旧观察清掉。剪了它就是在改规矩。
	 */
	instructions?: boolean;
}
```

### `ToolRun`

```ts
/** 工具执行时拿到的环境。 */
export interface ToolRun {
	sessionId: string;
	/** 调用所在的会话，见 `SessionScope`。 */
	session: SessionScope;
	/** 这次调用的 id（和 `calls` 里的、工具结果的 `toolCallId` 是同一个）：从这次调用开出去的会话记在 `SessionLaunch.spawnedFrom` 里。 */
	toolCallId: string;
	cwd: string;
	/** 当前项目的源文件夹；只授予读取，工作树隔离后为空。 */
	projectRoots?: readonly string[];
	/**
	 * 人在这个会话里（子会话连同它的上级会话）拖进来的文件的绝对路径，取自用户消息的附件：拖进来就是「看看这个」，
	 * 只授予读取这几个文件，不授予改动，也不扩大到所在目录。没有附件时不给。
	 */
	allowedPaths?: readonly string[];
	/** 这个会话的临时目录，见 `ModelContext.scratchDir`。 */
	scratchDir: string;
	/**
	 * 和这个会话同一脉的会话的临时目录，含 `scratchDir`：沿子会话（`SessionSummary.parentId`：子智能体、侧边聊天）、分叉
	 * （`forkedFrom`）、建议开出的新会话（`spawnedFrom`）的来处连在一起的那些，两头都算。它们互相交接草稿——子智能体把报告写进
	 * 父会话的临时目录，分叉接着改来源会话里的那份——往这些里写、删不用问人；别的会话的临时目录不在里面，那是别的对话的草稿。
	 * 只管写：读哪个会话的临时目录都不问。宿主每次调用时现算（子会话、分叉随时会多）；不给时只算 `scratchDir`。
	 */
	scratchDirs?: readonly string[];
	/** 用户停止这一轮时中止。 */
	signal: AbortSignal;
	/** 执行中的输出，推给界面。 */
	progress(chunk: string): void;
	/**
	 * 动手之前问一句（写了 `asks` 的工具用）。完全访问、外层放行的、答过「以后不再问」的由本体直接放行，提权总是问人；其余经钩子
	 * tool.approve，要不要真的弹给人由那里的层定（内置插件 plume.approval 按帮我批准的风险规则放行）。参数校验完、注定失败的已经报掉
	 * 之后再问：不先问人一个没法成立的问题。用户停止这一轮时得到 `"reject"`。
	 * `subject` 不用加插件名前缀：本体把这里答的「以后不再问」记在注册这件工具的插件名下，只放行这个插件的工具再问同一个 `subject`，
	 * 别的插件、本体自己的读边界（`read:<项目>`）都不认它（见 `ApprovalRequest.subject`）。
	 */
	ask(content: ApprovalContent): Promise<ApprovalDecision>;
	/**
	 * `ask` 得到 `"reject"` 以后交给模型的话：说这次调用被人拒了，叮嘱别原样重试、别换个工具或命令达到同样效果。原样作为错误结果交回，
	 * 工具不自己另写一份。本体自己拒绝时（替没写 `asks` 的工具在执行前问的、`escalate`、`files.read`）用的是同一句叮嘱，模型在哪看到都认得出。
	 */
	rejection: string;
	/**
	 * 停下来等人给一份数据：回答一个问题、批准一份计划、填一张表。卡片由界面入口按 `kind` 登记（`ui.requestCard`），
	 * 没登记时产品画一张只能「不答」的通用卡。和 `ask` 同排一队、同占输入框上方那一格，子会话问时卡片压在上级会话的输入框上方。
	 * 不是权限：不经钩子 tool.approve，完全访问、「以后不再问」都不替人答。等 30 分钟，到时得到 `expired`；这一轮停了得到
	 * `stopped`。`payload` 要能结构化克隆（它要跨进程送到界面）。
	 */
	request<T = unknown>(input: HumanRequestInput): Promise<HumanAnswer<T>>;
	/** 设置里现在的权限模式，用到才读：中途改了，下一个调用就照新的来。 */
	permissionMode(): Promise<PermissionMode>;
	/** 现在工具表里有哪些工具、各是哪个插件注册的、是哪一类（`ToolDefinition.category`；同名的只列生效的那个）。 */
	tools(): RegisteredToolInfo[];
	/** 这一步回复里的全部调用（含这一次），按回复里的顺序。工具要知道这一步是不是只做了它这一件事时看它（todo 清单收尾）。 */
	calls: readonly ToolCall[];
	/** 钩子 tool.execute 的外层要求这次调用不改动工作区（见 `ToolExecution.readOnly`）：`exec` 的命令只在只读沙箱里跑，`escalate` 一律不批。 */
	readOnly?: boolean;
	/**
	 * 这次调用的命令跑在哪个 shell、哪一档沙箱（见 `ShellInfo`），本体按权限模式和 `readOnly` 算好，和系统提示词里点名的是同一个。
	 * 提权不改它：提权的命令仍是照这个 shell 写的。用到才读设置，同 `permissionMode()`。
	 */
	shell(): Promise<ShellInfo>;
	/**
	 * 在这次调用的沙箱里用 `shell()` 的那个 shell 起一条命令，环境向登录 shell 要（从图标启动时也找得到用户装的工具）。
	 * 沙箱档由本体定，工具选不了：完全访问不设限，帮我批准只能写项目目录和临时目录，请求批准只读，`readOnly` 一律只读；
	 * 这次调用经 `escalate` 批过更宽的一档时跑在那一档。`cwd` 不给是这次调用的工作目录。机器上给不了这一档的沙箱时拒绝（Linux 没有后端），
	 * 不悄悄不加沙箱就跑。问不问人不归这里：要问的工具自己先经 `ask` 问。唯一的例外：完全访问下命令写明要改 Plume 自己的数据目录
	 * （重定向、`cp`、`sed -i`、`rm`……指到 `~/.plume`），本体在起它之前问人、只认人答，人不点头就不起、抛错（交给模型的话）。
	 * 只在这次调用里用：调用答完以后再调就抛错，已经起来的进程不受影响。
	 *
	 * `recordChanges`：这条命令可能改文件，本体在它起来之前、结束以后（连同它留下的进程）各看一次 git 工作区，改了的文件记进改动快照
	 * （来源是命令，不能自动撤销，撤回时说清），记进这次调用的结果（`ToolOutput.changes`）；这次调用答完时还在跑的，结果里记一句「结束后才记」，
	 * 之后读它输出的调用用 `files.includeChanges` 把记下的算进去。观测期间撤销等着它结束。能证明什么都不写的命令（只读的 `git log`）不用带：
	 * 前后各起几个 git、读一遍工作区里改动着的文件，不便宜；挂着不结束的命令（监视）不该带：撤销会一直等它。
	 */
	exec(command: string, options?: { cwd?: string; env?: Record<string, string>; recordChanges?: boolean }): Promise<RunProcess>;
	/**
	 * 申请这次调用的命令跑在比权限模式更宽的一档（提权）。本体弹提权卡（`ApprovalRequest.escalation`），只认人答，或代管（管理）这个会话的插件
	 * 经 `ctx.sessions.respond` 转达；完全访问、外层放行、钩子 tool.approve、「以后不再问」都不替人答。批了，这次调用之后的 `exec`
	 * 都跑在那一档，调用答完就作废，什么都不累积。`readOnly` 下、没给理由、要的不比当前宽、人拒绝时不批，`message` 是交给模型的说明。
	 * `title`、`detail` 是卡上的标题和正文（要跑的命令），`justification` 是模型给的理由，原样给人看。只在这次调用里用。
	 */
	escalate(request: {
		mode: "workspace-write" | "danger-full-access";
		justification: string;
		title: string;
		detail: string;
	}): Promise<{ granted: true } | { granted: false; message: string }>;
	/**
	 * 这次调用经本体读工作区：读边界和问人都在里面，见 `RunFiles`。读文件的工具、要读用户文件的插件工具都经它，
	 * 不自己判断哪里能读。只在这次调用里用：调用答完以后再调就抛错。
	 */
	files: RunFiles;
	/**
	 * 调用答完以后还在后台接着跑的事（后台命令、监视）把结果送回这个会话的渠道，见 `BackgroundChannel`。
	 * 只有顶层会话有：插件的子会话（侧边聊天、子 Agent）没人等它们的后台结果，拿不到就只能让模型自己去读。
	 */
	background?(): BackgroundChannel;
	/**
	 * 登记一项调用答完以后还在跑的后台任务（后台命令、监视），见 `BackgroundJobInput`。本体据此：算会话闲没闲——顶层会话里
	 * 登记着、没结束、这次调用的送达渠道（`background`）还没作废的任务，在它结束之前会话都不算闲（`LaunchedSession.idle`、
	 * `ParentStatus`、`SessionSummary.background`），挂着的除外（`wakes` 的监视、经 `TrackedJob.stand` 标成长跑服务的）；删会话、退出应用、登记它的插件停用时调 `stop(true)` 停掉；
	 * 子会话经 `ctx.sessions.start` 派出的那一次运行结束时停掉它还在跑的；经 `ctx.sessions.jobs` 列给界面（环境卡片、任务面板）。
	 * 人按停、撤回截掉这次调用时本体不停它（渠道作废，它不再算在等），停不停由工具定。只在这次调用里用：调用答完以后再调就抛错，
	 * 交回的 `TrackedJob` 不受影响。
	 */
	track(job: BackgroundJobInput): TrackedJob;
	/**
	 * 让这个会话以后再接着做：到点经这次调用的送达渠道送一条运行时送达进来（闲着开一轮，忙着在下一个步骤边界读到），那一行记在
	 * 注册这个工具的插件名下（`DeliveredReport.plugin`）。见 `WakeupInput`。没触发的唤醒不挡会话闲下来：它是挂着的，到点照样叫醒会话。
	 * 人按停止时全部取消（本体跟人说一声取消了几个），撤回、编辑重发截掉这次调用时取消它约的，删会话、退出应用、注册工具的插件停用时取消。
	 * 只有顶层会话有（同 `background`）。cron 表达式写错时抛错（message 说哪一段不对，给模型看）；在 `expiresAt` 之前一次也对不上时
	 * 不登记，返回 `undefined`。只在这次调用里用。
	 */
	schedule?(wake: WakeupInput): SessionWakeup | undefined;
	/**
	 * 给另一个顶层会话寄一封信（`to` 是它的 id），见 `LetterReceipt`。顶层会话和挂在顶层会话下的子会话都有，但只寄得到别的未归档顶层会话：
	 * 子会话和独立会话收不到信，独立会话也不能寄信。发件方的目录由本体照实填上；子会话寄出时，来源会话 id（`PeerLetter.sessionId`）记为其父会话 id，
	 * 且不能寄给自己的父会话（父会话走 `ToolRun.parent`），父会话归档后也不能再寄。信是单向的：没有请求和答复之分，对方要回话就再寄一封。
	 * 对方不在、已归档、不是顶层会话，或寄给所属顶层会话自身时抛错。只在这次调用里用：调用答完以后再调就抛错（回执的 `read` 不受影响）。
	 */
	letter?(to: string, letter: LetterInput): LetterReceipt;
	/**
	 * 等这一轮以完成（`done`）收场后，归档这次调用所在的会话，和人在侧栏上点归档一样（界面离开它，`onArchived`、`onEnded` 照常）。
	 * 不当场归档：这一轮还在等这次调用的结果，工具一般同时返回 `terminate: "done"`，让这一轮就停在这里。
	 * 这一轮被人停下、出错、卡住收场时不归档、请求作废：对话留在人看得见的地方；一次请求只管这一轮。
	 * 只有顶层会话有，也只够得着这次调用所在的会话：碰不到别的会话，子会话归档不了它的上级会话。
	 */
	archiveAfterTurn?(): void;
	/**
	 * 这次调用所在的会话是注册这个工具的插件建的子会话时才有：够得着它的父会话（侧边聊天把活交给主会话、让主会话停下）。
	 * 别的会话里的调用、别的插件的子会话里都没有。只在这次调用里用：调用答完以后再调它的方法就抛错。
	 */
	parent?: ParentSession;
}
```

### `RunFiles`

```ts
/**
 * `ToolRun.files`：读边界是本体的，一个路径能不能读、要不要问人，不管哪个工具来读都是同一个答案（两个答案就有一条绕过去的路：
 * 一个工具拒了的换个工具读得到，模型就学会去绕）。
 *
 * 不问的：工作区、项目的其他源码目录（`ToolRun.projectRoots`）、各会话的临时目录、系统临时目录、工具链要读的系统目录（`/usr`、`/etc`……）、
 * 人拖进来的文件（`ToolRun.allowedPaths`）。要问的：本机的密钥文件（Plume 的设置和凭据、ssh 私钥、云服务凭据、netrc、gh 的登录……，
 * 在工作区里也问，批准只管这一个文件）；别的地方（批准覆盖它所属的项目，往上走到仓库根，不到家目录）。问人经过闸（`kind` 是 `view`，
 * `subject` 由本体定、记在本体名下：哪个工具来读都认同一份，插件经 `run.ask` 给同样的字符串也不算），完全访问、「以后不再问」照常生效；
 * 人拒绝时 `message` 是交给模型的话。判定前追符号链接：工作区里一个指向外面的链接按它指向的地方判。
 */
export interface RunFiles {
	/**
	 * 要读的路径或资源地址。
	 * - 路径（相对 `cwd`、`~/`、Windows 上 shell 的几种写法）：按上面的边界判，过了交回 `path`，读就读它（判定用的绝对路径，
	 *   工作区自己在链接后面时写成工作区下的路径）。不存在的不问（密钥除外），照样交回，由工具自己报「找不到」。
	 * - 有人登记了 scheme 的资源地址（见 `PluginResources`）：不问人，落点已由 scheme 限在它自己的地方。交回读到的 `resource`
	 *   （带行范围的已经切好，`scheme://` 是列表）；没有这样东西、越界时 `ok: false`，`message` 是 scheme 的说明。
	 *   `scratch://<路径>`（不带行范围）是临时目录里的一个文件，交回它的 `path`，按文件读。
	 * - `directory: true`：要的是一个目录（列目录），总是交回 `path`。地址交回 scheme 给的磁盘位置（`ResourceHandler.locate`），给不出的照路径判。
	 * 没人登记的 `foo://` 照路径判。
	 */
	read(
		target: string,
		options?: { directory?: boolean },
	): Promise<{ ok: true; path: string; resource?: undefined } | { ok: true; resource: Resource; path?: undefined } | { ok: false; message: string }>;
	/**
	 * 一行命令写明要读的路径（照这次调用的 shell 的语法拆，只认字面写的：`$DIR/key`、通配符、替换不猜；重定向的目标、heredoc 的正文不算），
	 * 按同一个边界判。同一个批准范围只问一次。全部不用问或都批准了是 `ok: true`；问到第一个被拒的就停，`message` 是交给模型的话。
	 * 跑命令的工具在审批、起命令之前调它：命令改不改东西是另一回事，`cat ~/.ssh/id_ed25519` 什么都不改，却是在读密钥。
	 */
	readCommand(command: string): Promise<{ ok: true } | { ok: false; message: string }>;
	/**
	 * 模型写的路径（相对 `cwd`、`~/`、Windows 上 shell 的几种写法）指的是哪个绝对路径，和读、写边界判定用的是同一个解析。
	 * 不判能不能读写、不追符号链接、不认资源地址。给模型看路径、往结果里写 `FileViewDetails.path` 时用，不自己再解析一遍。
	 */
	resolve(path: string): string;
	/**
	 * 替模型改一个文本文件：写边界、按文件排队、拿当前内容、写、记改动快照、撤销门闩一次做完，写成的记进这次调用的结果（`ToolOutput.changes`）。
	 *
	 * 写边界：Plume 的数据目录和 `~/.plume`（工作区、同一脉的会话的临时目录在里面的除外）能写，但只认人亲自点头：`edit` 里经 `ask`
	 * 问的那一下同提权，权限模式（完全访问也一样）、「以后不再问」、帮我批准都不替人答，卡上没有「以后不再问」；工具没问、或者人没点头，
	 * 本体在写之前自己再问一次人，人不点头就不写、抛错。工作区里一个指向外面的链接不写（审批卡写的是字面路径，改的却是别处）；
	 * 工作区外不在这里拒，审批由工具问。附件（`allowedPaths`）不算能写。
	 * `edit` 拿到这个文件现在的样子（`path` 是真实路径，不存在时 `text`、`stamp` 是 null），在同一个队里决定写不写：要写就交回 `text`，
	 * 不写就不给；`value` 原样交回。审批由工具在 `edit` 里经 `ask` 问（diff 只有工具写得出来）。写之前本体再核对一遍：等审批时文件被改了、
	 * 换成了链接，不写并抛错。只认 UTF-8 文本，二进制、不是普通文件的抛错；撤销进行中抛错。抛的错都是交给模型的话。
	 * 交回的 `written` 是写完那一刻的修改时间和大小（没写时不给）。只在这次调用里用。
	 */
	change<T>(
		path: string,
		edit: (current: { path: string; text: string | null; stamp: FileStamp | null }) => Promise<{ text?: string; value: T }>,
	): Promise<{ value: T; path: string; written?: FileStamp }>;
	/**
	 * 写一个资源地址。能写的只有本体的 `scratch://`（会话的临时目录，落点不出目录、软链出不去），别的 scheme 都是只读的：能写
	 * `skill://<名字>` 的模型就能改掉它该遵守的说明。不问人、不记改动快照（临时目录是会话自己的草稿）。成了交回地址在磁盘上的位置；
	 * 只读、越界、不是登记着的地址时 `ok: false`，`message` 是交给模型的话。只在这次调用里用。
	 */
	write(address: string, content: string): Promise<{ ok: true; path?: string } | { ok: false; message: string }>;
	/**
	 * 结果截过以后，把没交给模型的那份原文存在会话的临时目录里，交回它的地址和位置（`SpillDetails` 的形状，直接放进
	 * `ToolOutput.details.spill`）。地址是 `artifact://<id>`，按 `tool` 和内容算：同一段原文每次换回同一个地址，后来重发的历史里
	 * 那句提示逐字不变。模型要读了经 `read` 按行、按窗口取回；会话删掉时一起清掉，重开应用以后还在。
	 *
	 * 每个会话最多留 30 份，超了丢最旧的。写不进去（磁盘满、会话没有临时目录）时抛错，由工具自己决定少说一句还是报错——
	 * 截断本身不该因此失败。不记改动快照、不问人：临时目录是会话自己的草稿。只在这次调用里用。
	 *
	 * 同步的：调用它的都在同步地生成一条结果（压缩剪一条结果、mcp 把服务器的回复换成交给模型的样子），内容已经在内存里，
	 * 写成异步只会把「这条结果长什么样」摊成两步，还得让这些路径都变成异步。写的是几百 KB 到磁盘。
	 */
	spill(tool: string, content: string): { address: string; path: string; characters: number };
	/**
	 * 这次调用的结果也算上一条命令改的文件：`process` 是经 `exec`（`recordChanges`）起的进程或它留下的进程，可以是之前的调用起的（后台命令）。
	 * 命令已经结束就算上它记下的，还在跑就记一句「结束后才记」。读后台命令输出的调用用。不是这个会话里经 `exec` 观测的进程时什么都不做。
	 */
	includeChanges(process: SandboxProcess): void;
}
```

## 钩子

`ctx.hook(name, layer, { order })` 的 `layer` 是 `HookLayer<name>`：收到输入和 `next`，交回输出。

### `Hooks`

```ts
/** 钩子名 → [输入, 输出]。 */
export interface Hooks {
	"tool.execute": [ToolExecution, ToolOutput];
	"model.context": [ModelContext, ModelContext];
	"step.end": [StepEnd, StepVerdict];
	"prompt.submit": [PromptSubmit, PromptVerdict];
	"context.compact": [ContextCompact, CompactSummary];
	"tool.approve": [ToolApproval, ApprovalDecision];
}
```

### `HookLayer`

```ts
/** 洋葱的一层：调 next 交给里一层，不调就是拦下。 */
export type HookLayer<N extends HookName> = (input: Hooks[N][0], next: (input: Hooks[N][0]) => Promise<Hooks[N][1]>) => Promise<Hooks[N][1]>;
```

### `ToolExecution`

```ts
/** 钩子 tool.execute 的输入。 */
export interface ToolExecution {
	sessionId: string;
	/** 调用所在的会话，见 `SessionScope`。 */
	session: SessionScope;
	cwd: string;
	call: ToolCall;
	/** `plugin` 是注册它的插件（read、write、edit、ls、glob、grep、bash 是内置插件 plume.tools 的）。 */
	tool: { name: string; mutating: boolean; plugin: string };
	/** 外层已经放行的理由。设了它，本体就不再问人（提权和层自己问的除外），也不经钩子 tool.approve。 */
	approved?: string;
	/**
	 * 外层要求这次调用不改动工作区（计划模式）。只能收紧：里层不该把它去掉。本体照它执行，从设上它的那一层往里：
	 * - 写、改文件的工具（`ToolDefinition.kind` 是 `create`、`modify`）不再往里交、不执行，这次调用的结果就是 `refusal`
	 *   （交给模型的话：为什么没跑、接下来怎么办）；
	 * - 别的工具照常往里交、执行，拿到 `ToolRun.readOnly`：`run.exec` 的命令不按权限模式选沙箱，一律在只读沙箱里跑（机器上给不了时不跑），
	 *   `run.escalate` 一律不批。
	 */
	readOnly?: { refusal: string };
	signal: AbortSignal;
	/**
	 * 问一次要不要放行，卡上是这次调用的参数和 `reason`。经钩子 tool.approve（标着 `byLayer`），由那里的层定要不要弹给人
	 * （完全访问下 plume.approval 直接放行）。返回是否放行，用户停止这一轮时得到 false。
	 */
	ask(reason: string): Promise<boolean>;
	progress(chunk: string): void;
}
```

### `ToolApproval`

```ts
/**
 * 钩子 tool.approve 的输入：一个工具调用要动手了，问要不要放行。工具自己经 `run.ask` 问的（带 diff、命令原文）、
 * 会改动工作区却没写 `asks` 的工具（执行前按参数问）、tool.execute 的层自己问的（`byLayer`）都可能到这里。
 * 最里层照着传进来的 `request` 把审批卡弹给人、等人答。
 *
 * 权限模式的含义在本体，到不了这里：完全访问、tool.execute 外层设了 `approved`、`subject` 答过「以后不再问」的，本体直接放行。
 * 提权（`request.escalation`）只能由人答：它在完全访问下也到这里，层答放行不算数、本体照样弹卡，层答拒绝照算；
 * 最里层照本体原本问的那一条弹卡（层交下去的 `request` 不算），层拿到人的回答后改成放行也不算。
 * 弹出来的卡可以由人点，也可以由代管（管理）这个会话的插件经 `ctx.sessions.respond` 转达，那条路不经这里。
 * 工具要人给答案（`ToolRun.request`）不是审批，不到这里。
 * 内置插件 plume.approval 在里层（order 1000）按帮我批准（`auto`）的风险规则放行，命中规则的把理由写进卡片再交给里层；
 * 要在它之前替人答、或整个换掉这套规则的层挂在外面（order 小于 1000）；只管真要弹给人的那些（它放行的到不了里面，到了的
 * 卡上带着它写的理由）的层挂在里面（order 大于 1000）。没有任何层时每一次都问人。
 */
export interface ToolApproval {
	sessionId: string;
	/** 调用所在的会话，见 `SessionScope`。 */
	session: SessionScope;
	cwd: string;
	/** 这个会话能当草稿区用的临时目录，同 `ToolRun.scratchDirs`；帮我批准把写进、删掉这些里面的东西算作正当干活。 */
	scratchDirs?: readonly string[];
	/** 模型发起的调用，`args` 是原始参数。 */
	call: ToolCall;
	tool: { name: string; mutating: boolean; plugin: string };
	/** 弹给人的话，审批卡上画的就是它。`escalation` 是申请更宽的沙箱。 */
	request: ApprovalContent;
	/** 是钩子 tool.execute 的某一层自己要问（`ToolExecution.ask`），不是工具问的：没有 `subject`，只能答这一次。 */
	byLayer?: boolean;
	/** 这次调用所在项目现在的权限模式。完全访问只有提权和改 Plume 数据目录的写入（`RunFiles.change`）会带到这里。 */
	permissionMode: PermissionMode;
	/** 用户停止这一轮时中止。 */
	signal: AbortSignal;
}
```

### `ModelContext`

```ts
/**
 * 钩子 model.context 的输入和输出。只作用于这一次请求，会话里存的不变。
 * 本体给的 `sections` 是空的；`messages` 是会话的历史（压缩过的是摘要加之后的原文），本体已经在里面接上了它自己的几条合成消息：
 * 日期（`<env>`）、之前几轮的增量（`UserMessage.promptUpdate`），人在一轮中途插的、打断这一轮的话前后也套上了说明。
 * 不是自己加的消息原样留着。系统提示词各段由内置插件 plume.prompt 在外层（order -1000）补上，所以其他层拿到的已经是完整的一份。
 *
 * 系统提示词和工具表由本体在整条钩子链外面按会话冻结，哪一层、`order` 写成多少都一样：会话第一次请求时定下钩子链交回的那份，
 * 之后发出去的仍是它；一轮开头钩子链交回的段和模型此刻以为的不一样时，改动作为一条增量消息接在历史末尾，工具表原有的保持顺序、
 * 新的接在后面。压缩、撤回到第一条时按那时交回的重新冻结。插件按段改、加、删就行，不用管缓存。
 */
export interface ModelContext {
	sessionId: string;
	/** 这次请求所在的会话，见 `SessionScope`。下面的 `parentId`、`owner` 和它里面的同名字段是同一件事。 */
	session: SessionScope;
	/**
	 * 这个会话挂在哪个会话下面，和 `SessionSummary.parentId` 同一件事：只有插件建的子会话（侧边聊天、子 Agent）有，
	 * 顶层会话不带这个键。按会话藏工具、改提示词时看它，不用为此去 `ctx.sessions.list()`。
	 */
	parentId?: string;
	/**
	 * 建这个会话的插件，和 `SessionSummary.owner` 同一件事：插件的子会话和独立会话（`SessionAccess.create` 不给 `parentId`）有，
	 * 侧栏里的会话不带这个键。有 `owner` 没有 `parentId` 的是插件的独立会话。
	 */
	owner?: string;
	cwd: string;
	/** 当前项目的源文件夹；只授予读取，工作树隔离后为空。 */
	projectRoots?: readonly string[];
	/**
	 * 这个会话的临时目录（`<appDataDir>/scratch/<sessionId>`，子会话各有各的）：只为得出这次答案而写的文件放这里——验证想法的脚本、
	 * 下载的样例、只看一次的完整输出（太大没交给模型的图、截断前的全文）。宿主不预先建它，谁先写谁建；会话删掉时宿主连目录一起删。
	 * 内置插件 plume.prompt 把它写进系统提示词，plume.tools 给它开了 `scratch://` 地址。
	 */
	scratchDir: string;
	/** 这一次请求用的模型。 */
	model: { id: string; name: string };
	/** 这个会话现在的权限模式（含项目覆盖）。 */
	permissionMode: PermissionMode;
	/**
	 * 外层要求这一轮的命令都在只读沙箱里跑（计划模式，和 `ToolExecution.readOnly` 同一件事）。宿主不给；要设就挂在
	 * 点名 shell 的那一层（plume.prompt，order -1000）外面：宿主据此重算 `shell`。
	 */
	readOnly?: boolean;
	/**
	 * 这一轮的命令跑在哪个 shell、哪一档沙箱（见 `ShellInfo`），和 `ToolRun.shell()` 是同一个，系统提示词按它点名 shell 和写法。
	 * 宿主按 `permissionMode` 和 `readOnly` 算，每层交接时重算：改它不作数，要收紧就设 `readOnly`。
	 */
	shell: ShellInfo;
	/** 设置 › 个性化：语气和全局指令。 */
	personalization: Personalization;
	/** 发出去的系统提示词，就是 `sections` 依次用空行连起来。只读：每层交接时宿主按 `sections` 重拼，改它不作数。 */
	systemPrompt: string;
	/** 系统提示词按段拆开。加、换、删都改这里，交给下一层时宿主把 `systemPrompt` 重新拼。 */
	sections: PromptSection[];
	messages: Message[];
	tools: ToolSpec[];
}
```

### `StepEnd`

```ts
/** 钩子 step.end 的输入：一步刚收尾，回复和它要的工具的结果都已写进会话。给的是副本，改了不影响会话。 */
export interface StepEnd {
	/** 清单插件提供的汇报判定与提醒；未提供时由本体按正文判断。 */
	progress?: { reported: boolean; reminder: string };
	/**
	 * 派出去还没回来、结论要等它的后台工作（子智能体之类），由外层插件经 `next({ ...input, awaiting })` 给出。
	 * 有它时里层不逼模型交结论：清单插件收尾不追问清单，本体的空回复催促换成 `nudge` 这句（催它说一句在等谁）。
	 */
	awaiting?: { nudge: string };
	sessionId: string;
	/** 这一步所在的会话，见 `SessionScope`。 */
	session: SessionScope;
	cwd: string;
	/** 这一轮的第几步，从 1 数。 */
	step: number;
	/** 后面还能跑几步；是 0 时要接着做，这一轮也会以「用满步数」结束。 */
	stepsLeft: number;
	reply: AssistantMessage;
	/** 这一步工具的结果；回复没调工具时是空的。 */
	toolResults: ToolResultMessage[];
	signal: AbortSignal;
}
```

### `StepVerdict`

```ts
/**
 * 钩子 step.end 的结论。最里层是自然结论：有工具结果就 `{ continue: true }`，否则 `{ continue: false }`（完成）。
 * 插件只能让循环多做、给结束换个原因：有工具结果时 `continue: false` 不起作用；本来要结束时要接着做，必须给 `say`。
 * 回复出错、用户停止的那一步不调这个钩子；钩子抛错时按自然结论走。
 */
export type StepVerdict =
	| {
			continue: true;
			/** 以用户的身份对模型说这句话再接着做。会话里标成 synthetic，界面不画成人的消息，也不当会话标题。 */
			say?: string;
	  }
	| {
			continue: false;
			/** 不给是完成。 */
			reason?: "error" | "stalled";
			/** reason 是 error 时给人看的原因。 */
			error?: string;
	  };
```

### `PromptSubmit`

```ts
/** 钩子 prompt.submit 的输入：一轮开始时，人发来的这条消息还没写进会话。给的是副本，改了不影响会话。 */
export interface PromptSubmit {
	sessionId: string;
	/** 这条消息要进的会话，见 `SessionScope`。 */
	session: SessionScope;
	cwd: string;
	/** 这条消息的文字（命令发出去的是展开后的那段）。 */
	text: string;
	/** 附件的名字，按顺序。 */
	attachments: string[];
	/** 界面替人说的话（「继续」按钮发的那句）。 */
	synthetic: boolean;
	/** 会话里在它之前一条消息都还没有：这是会话的第一轮。 */
	fresh: boolean;
	/**
	 * 这句话是插件发的，不是人在输入框里发的：经 `ctx.sessions.launch` 开出来的会话的第一句，或代管插件经 `ctx.sessions.post`
	 * 转进来的话。人为自己正在写的那条消息选的东西（输入框上的开关）不算到它头上。
	 */
	launched: boolean;
	signal: AbortSignal;
}
```

### `PromptVerdict`

```ts
/**
 * 钩子 prompt.submit 的结论。最里层是 `{ block: false }`。
 * 拦下时这条消息不写进会话、这一轮不跑，`reason` 弹成提示条（给人看的话，按界面语言写）。
 * 放行时可以带 `context`：跟在这条消息后面以用户身份写进会话（标成 synthetic，界面不画成人的消息），模型看得到。
 * 放行时还可以带 `cwd`：这个会话从这一轮起改在这个目录里跑，它的子会话跟着（工作树插件给对话开了自己的检出）。
 * 只对一轮开头那条消息生效，插话、后台回报和子会话的不算；不是已有目录的绝对路径时不换，记日志。
 */
export type PromptVerdict = { block: true; reason: string } | { block: false; context?: string; cwd?: string };
```

### `ContextCompact`

```ts
/**
 * 钩子 context.compact 的输入：组好一次请求、发出去之前，问要不要把较早的历史换成一份摘要。
 * 内置插件 plume.compaction 在里层（order 1000）按有多满决定压不压、从哪切、写摘要；换一种压法就在外层不调 `next`。
 * 服务商说超长时 `force` 为真，这时压不了，这一轮以出错结束。人敲了 `/compact` 时 `force` 也为真，另有 `manual`；
 * 一轮干净收尾、缓存还热时宿主也问一次（`idle`）。
 */
export interface ContextCompact {
	sessionId: string;
	/** 要压的会话，见 `SessionScope`。 */
	session: SessionScope;
	cwd: string;
	/**
	 * 这个会话现在用的模型。`tierLines` 是它的价格分档线（一次请求的输入越过这么多 token，整次按高一档计），从低到高；
	 * 没有分档时不给。
	 */
	model: { id: string; name: string; contextWindow: number; maxOutputTokens: number; tierLines?: number[] };
	/**
	 * 现在发给模型的历史（插件改之前的那份），副本：压缩过的，前面是上一次压缩换上的那几条（摘要和一句确认，或按条丢弃时的
	 * 一条说明），之后是边界以后的原文；剪过的工具结果（压缩时剪的、服务商拒收时剪成一行的）这里也是剪过的那份。
	 */
	history: Message[];
	/**
	 * 上一次压缩换上的那几条占了 `history` 开头几条（新的 `keep` 要大于它）。没压缩过不给。上一份摘要在 `history` 里。
	 */
	previous?: { head: number };
	/**
	 * 历史上一次被改写（压缩）的时刻：在这之前落定的回复，用量量的是改写前的那份，不能拿来判断现在有多满。
	 * 没改写过不给。
	 */
	rewrittenAt?: number;
	/** 这一次真正要发出去的请求（经过 model.context），量有多满用它。就是要发的那一份，只读，别改。 */
	request: { systemPrompt: string; messages: Message[]; tools: ToolSpec[] };
	/**
	 * `request` 有多满，本体按和上下文用量圆环同一套算法算好：最近一条落定回复服务商量的数（整份请求，含系统提示词和工具表）加上它之后
	 * 的消息的估算；`rewrittenAt` 之前（含）落定的回复不算。没有可用的时 `measured` 为假，`tokens` 是整份请求（系统提示词、工具表、
	 * 消息）的估算。
	 */
	usage: { tokens: number; measured: boolean };
	/** 本体估 token 的那一份算法，量一截历史、一段文字有多大（决定从哪切、摘要请求放不放得下）时用，不要自己再写一份。 */
	estimate: TokenEstimate;
	/** 服务商说超长了，或人敲了 `/compact`：不管量出来多满都该压。 */
	force: boolean;
	/** 人敲的 `/compact`：`instructions` 是命令后面的话（希望摘要保留的内容，可以是空串）。 */
	manual?: { instructions: string };
	/**
	 * 一轮干净收尾以后、人还没开口时问的：只在能从主请求分叉（`lineage`）时值得压，否则留给下一轮开头。`request` 是宿主为它
	 * 再经一遍 model.context 组出来的下一轮开头那份请求，所以 model.context 的层在一轮里可能多走一次。
	 */
	idle?: boolean;
	/**
	 * 这个会话上一次发出去的主请求：用的哪个模型（`SessionModel.id`）、什么时候开始发的、这家服务商的缓存大概能留多久
	 * （毫秒，不知道时不给）。有它，摘要可以经 `ModelCompletion.fork` 从那次请求分叉、吃到它的缓存。没发过、超长恢复时不给。
	 */
	lineage?: { model: string; at: number; cacheHotMs?: number };
	signal: AbortSignal;
	/** 压缩走到哪一步了，界面上那一行跟着变：写摘要、等重试、摘要没拿到正在本地整理。 */
	progress(event: CompactionProgress): void;
}
```

### `CompactSummary`

```ts
/**
 * 钩子 context.compact 的结论：不给是不压。最里层不压。
 * 给了 `keep`，`history` 里从 `keep` 起原样留着，之前的（含上一次压缩换上的那几条）换成 `head`。
 * `keep` 要落在上一次换上的那几条之后、最后一条之前，而且不能是工具结果（会和它回答的调用拆开）；`summary`
 * 只在按条丢弃（`via: "dropped"`）时可以是空串；不合规矩的宿主当作压缩失败。
 * `views` 是留下的那截里剪过的工具结果：前缀只在压缩这一次重写，要剪的随边界一起交回。
 */
export type CompactSummary =
	| {
			keep: number;
			summary: string;
			/** 代替边界之前那段的消息（以用户消息开头），宿主原样存下、以后每次照发。 */
			head: Message[];
			via?: CompactionVia;
			views?: ToolResultView[];
	  }
	| undefined;
```

## 界面入口（`@plume/contract/ui`）

默认导出 `UiPlugin`，`apply` 收到 `UiContext`；工具卡片、等人卡收到的 props 在后面。组件见 [components.md](components.md)。

### `UiPlugin`

```ts
/** 界面入口的默认导出，name 必须和逻辑入口相同。 */
export interface UiPlugin {
	name: string;
	apply(ui: UiContext): void;
}
```

### `UiContext`

```ts
export interface UiContext {
	/** 插件名，和逻辑入口的一样。 */
	readonly name: string;
	/** 会话标题栏的局部控件；只在有会话时显示，组件不能接管标题或布局。 */
	sessionToolbar(id: string, component: ComponentType<{ session: SessionView }>): void;
	/** 会话菜单中的操作，点击后调用；没有会话时不显示。 */
	sessionMenuItem(
		id: string,
		item: { label: LocalizedText; icon?: ComponentType<{ size?: number }>; run(session: SessionSummary): void | Promise<void> },
	): void;
	/**
	 * 提供一项界面侧的服务（见 `UiServices`）给别的插件的界面入口用，停用时撤下。同一项服务有几个插件提供时后提供的生效，
	 * 它撤下后前一个恢复；同一插件再提供同名的换掉自己前一个。
	 */
	provide<K extends keyof UiServices>(name: K, service: UiServices[K]): void;
	/**
	 * React hook：一项界面侧服务现在生效的实现，没人提供时是 `undefined`（用的一方据此不给那个入口）；提供方换了、撤了跟着重画。
	 * 拿到的就是提供方给的那一份，不用声明依赖。只在组件里调，规则同 React 的 hook。
	 */
	useService<K extends keyof UiServices>(name: K): UiServices[K] | undefined;
	/**
	 * 本插件交回的结果（`ctx.sessions.report`、`BackgroundChannel.report` 带了 `delivery` 的，和本插件开出来的会话由宿主每轮交回来处的）在对话里
	 * 画成哪一行：一次送达里本插件交的几份一起交给它。只画自己交的那几份，别的插件交的由它们自己登记的组件画；同一插件再登记换掉前一个，
	 * 停用时撤下。没登记（或停用了）时宿主按 `DeliveredReport` 的通用字段画默认的一行。
	 */
	agentDelivery(component: ComponentType<AgentDeliveryProps>): void;
	/**
	 * 用系统里的应用打开 `path`（目录或文件）；复用文件预览的默认目标和菜单。缺省是一整行「在 某应用 中打开」；`compact` 只写应用名，
	 * 放在一行的右端（环境卡片的页头）；`compact: "icon"` 只剩应用图标和一枚箭头，一颗带框的分体按钮，放在面板顶栏这种一排图标按钮里。
	 */
	readonly ProjectOpener: ComponentType<{ path: string; compact?: boolean | "icon" }>;
	/**
	 * 人明确选择入口时在主窗口打开一个会话，和点侧栏里那一行一样；不会自动发送，不替人换屏（只在人点了插件界面上的按钮时调，
	 * 如「打开上次会话」打开插件经 `ctx.sessions.launch` 开出来的会话）。没有的会话抛错。
	 */
	openSession(sessionId: string): Promise<void>;
	/** 按围栏语言（忽略大小写）接管回复正文代码块；order 和撤销规则同 toolCard，解析失败返回 fallback。 */
	codeBlock(
		language: string,
		component: ComponentType<CodeBlockProps>,
		options?: {
			order?: number;
			/** 复制成功完成的助手回复时现取可读文字；undefined 或抛错保留源码。不改变显示或存储。 */
			copyText?: (block: Pick<CodeBlockProps, "code" | "sessionId">) => string | undefined;
		},
	): void;
	/**
	 * order 小的生效，默认 0；同一 order 后注册的生效。精确工具名优先于 match: "prefix" 的前缀匹配，撤下后恢复前一个。
	 * 登记了卡片的调用在转录里单独一行；`inline: true` 的卡片只在通用卡片上补东西（多半直接返回 `fallback`），调用照常按归类
	 * 并进一段活，它那一行（单独一次时、展开一段活后）由这张卡画。
	 *
	 * 卡片只对一部分调用画大东西、其余调用只画 `fallback` 时，`inline` 传函数逐次判断：返回 true 的那次并进一段活。
	 * 参数还在写时 `args` 是空对象，只有 `argumentsText` 在长；只看这一次调用自己的参数，参数写完后答案不能再变——一次调用从头到尾是转录里的同一行。
	 */
	toolCard(
		tool: string,
		component: ComponentType<ToolCardProps>,
		options?: { order?: number; match?: "tool" | "prefix"; inline?: boolean | ((args: Record<string, unknown>, argumentsText: string | undefined) => boolean) },
	): void;
	/**
	 * 转录里怎么说自己的工具：通用卡片那一行、合成一段活的那一行、运行行，见 `ToolLine`。只改说法和归类，画法照通用卡片；
	 * 同时登记了 `toolCard` 的，卡片单独一行（`inline` 的照常并进一段活），`fallback` 用这里的说法。同一工具后登记的生效，它撤下后前一个恢复；插件登记的
	 * 优先于产品给内置工具的说法。工具名不固定（MCP 的 `mcp__服务__工具`）时用 `match: "prefix"` 按前缀登记，精确工具名的优先于前缀的。
	 */
	toolLine(tool: string, line: ToolLine, options?: { match?: "tool" | "prefix" }): void;
	/**
	 * 给 `run.request` 画卡，见 `RequestCardProps`。`kind` 是 `HumanRequest.kind`；order 和让位规则同 `toolCard`：渲染出错时让给下一个，
	 * 都不行用产品的通用卡。
	 * `place` 定卡摆在哪（见 `RequestCardPlace`，默认 `composer`），按这个 kind 排在最前的那一个注册者的为准（它渲染出错、让给下一个时卡不挪地方）。
	 */
	requestCard(kind: string, component: ComponentType<RequestCardProps>, options?: { order?: number; place?: RequestCardPlace }): void;
	/**
	 * 往工作区加一个面板，标签按会话保留，宽度和收起偏好在窗口内共享。
	 * 全屏按会话保存，盖满工作区；窄窗口也盖满工作区，正文和面板放不下横排时上下排列。
	 * 面板区顶上一排标签，每个开着的面板一个；点「+」开一个开始页标签，上面每个面板一张卡片，按 order 从小到大排（默认 0，相同时按注册先后），点卡片这个标签就变成那个面板。
	 * id 在插件内唯一。标题、说明给函数的，产品每次按当前界面语言调用它；只给一个字符串就哪种语言都显示它。
	 */
	panel(id: string, component: ComponentType<PanelProps>, options: PanelOptions): void;
	/**
	 * 往窗口最左边的活动栏里加一个页面：活动栏一格图标，点了整个界面换成这个页面。页面没有侧栏，活动栏右边整块都给它；
	 * 宿主在正文卡片上面画标题栏（写页面名、拖窗口；Windows、Linux 放在顶上那条带子里），页面从卡片的顶边开始，自己不用留拖窗口的地方。
	 * 要列表的页面在自己里面画（左边列表、右边详情，每栏顶上一行 `PageTopRow` 当栏头，列表的宽度用 `ResizeHandle` 让人拖）。按 order 从小到大排（默认 0，相同时按注册先后），
	 * 排在产品自己的「对话」后面。id 在插件内唯一；标题给函数的，产品每次按当前界面语言调用它。
	 */
	page(id: string, component: ComponentType<PageProps>, options: PageOptions): void;
	/**
	 * 在页面组件里调用的 hook：往窗口左上角那一排（后退、前进后面）放这一页的图标按钮，比如开合页面里的列表；对话里那颗侧栏开关就在这个位置。
	 * 只在本插件 `page` 注册的组件（及其子组件）里调用，别处调用抛错；页面卸下时按钮跟着撤掉。每次渲染传当前的按钮，
	 * `id`、`label`、`icon` 变了宿主才重画那一排，`onClick` 总是调最近一次渲染给的。传空数组不放按钮。
	 */
	usePageToolbar(items: readonly PageToolbarItem[]): void;
	/** 换皮肤：可重复调用更新，null 撤下自己的皮肤；最后注册的生效，撤下后前一个恢复。 */
	skin(skin: Skin | null): void;
	/** 应用的主题偏好，就是设置 › 外观那三张主题卡片（跟随系统、浅色、深色）；在组件里用，偏好变了跟着重画。 */
	useTheme(): "system" | "light" | "dark";
	/**
	 * 改主题偏好，等同人在外观页点那张卡片：存盘、各窗口同步。有皮肤接管深浅模式时外观页的主题只读，这里同样不改；
	 * 要改先 `skin(null)` 撤下自己的皮肤。只在人点了插件界面上的按钮时调。
	 */
	setTheme(theme: "system" | "light" | "dark"): void;
	/** 登记界面入口的订阅清理；停用、重载或加载失败时执行，旧入口不能再注册皮肤。 */
	effect(dispose: () => void): void;
	/**
	 * 输入框底下那排控件加一格：`start` 在左边，排在产品自己的「添加附件」和权限后面；`end` 在右边，排在产品自己的上下文用量和模型选择前面
	 * （跟下一轮的模型有关的读数）。各自按 order 从小到大（默认 0，相同时按注册先后）。
	 * 组件自己画按钮（`@plume/ui` 的 `IconButton`，`size="composer"`），这一格不该显示时返回 null。id 在插件内唯一。
	 */
	composerItem(id: string, component: ComponentType<ComposerItemProps>, options?: ComposerItemOptions): void;
	/**
	 * 输入框上方、项目签那一行加一格：`start` 跟在项目签后面，`end` 靠右，各自按 order 从小到大（默认 0，相同时按注册先后）。
	 * 组件自己画，高度用 `plume-composer-control`；这一格不该显示时返回 null。id 在插件内唯一。
	 */
	composerChip(id: string, component: ComponentType<ComposerChipProps>, options?: ComposerChipOptions): void;
	/** 主输入框上方独占一行；返回 null 不占位，按 order 排列，组件自己管理展开和退场。 */
	composerAbove(id: string, component: ComponentType<ComposerAboveProps>, options?: { order?: number }): void;
	/**
	 * 跟着会话的一张卡片：一直在变的一件事（todo 清单做到哪了），不是转录里的又一条记录，所以不随消息滚走。
	 * 对话那一列放得下它（320px 的卡片之外还剩 420px 正文）时浮在转录右上角，放不下时在输入框正上方，经 `placement` 告诉组件。
	 * 按 order 从小到大（默认 0，相同时按注册先后）；没什么可说时返回 null，不占地方。只画开着的会话，新对话不画。id 在插件内唯一。
	 *
	 * `lane: true` 的卡片（环境卡片）占右边 280px 宽的一列，总是浮在转录右上角、压在正文上面，不让转录和输入框让位，
	 * 也从不放到输入框上方。这一列从顶到转录底，卡片太长要自己滚（`max-height: 100%`、`min-height: 0`，正文 `overflow-y: auto`）。
	 * 这一列有卡片时，别的卡片浮得下就排到它下面，浮不下照旧在输入框上方。
	 */
	conversationCard(id: string, component: ComponentType<ConversationCardProps>, options?: { order?: number; lane?: boolean }): void;
	/**
	 * 往会话的环境卡片里加一节（卡片由随应用提供的会话环境插件画，它经 `useEnvironmentSections` 拿到各节、不认是谁登记的）：和这个会话相关的一件周边的事，比如当前分支的拉取请求，每一行都只是入口，
	 * 点了去插件自己的页面或面板。没什么可说时返回 null，卡片不留空位。`label` 是卡片右键「显示哪些内容」菜单里的名字。
	 * `place` 定它排在卡片的哪一块（见 `EnvironmentPlace`，默认 `output`）；`count` 控制组标题后是否显示条数（默认 `true`，设为 `false` 时不显示）；`background`、`output`、`foot` 里的每一行用 `@plume/ui` 的
	 * `EnvironmentRow` 画，一张卡片里的行才长得一样。同一块里按 order 从小到大排（默认 0）。id 在插件内唯一，停用时撤下。
	 *
	 * `attention` 是一个 React hook：这一节此刻有没有要提醒人的事，有就返回一句给人看的话（按界面语言，「1 个监视在跑，2 个检查待触发」），
	 * 没有返回 undefined。卡片收着、这一节没被藏起来时，标题栏上开关卡片的那颗挂一个圆点，这句话按节的 order 接在它的说明后面；
	 * 只在这时调，所以它要读的数据可以只在被调时拉。要提醒的是会自己叫醒这个会话的（监视、待触发的检查和定时任务：人不回来，
	 * 会话也会自己开一轮），和卡片里列着、等人回来决定的。普通的「有东西在跑」不算（开着一个开发服务器是常态），算进去圆点就一直亮着。
	 * 规则同 React 的 hook。
	 */
	environmentSection(
		id: string,
		component: ComponentType<EnvironmentSectionProps>,
		options: { label: LocalizedText; place?: EnvironmentPlace; order?: number; count?: boolean; attention?: (session: SessionView) => string | undefined },
	): void;
	/** React hook：各插件登记的环境卡片分区，按 order 排好，给画环境卡片的插件用；增减跟着变。只在组件里调。 */
	useEnvironmentSections(): readonly EnvironmentSectionEntry[];
	/**
	 * 输入框 `@` 菜单里加几项，见 `ComposerMention`：每次打开菜单时按输入框的目录和会话问一次，可以是 Promise；
	 * 菜单、分组、token 的样子由宿主画。一个插件一份，再登记换掉上一份，停用时撤下。
	 */
	mentions(provider: (context: { cwd?: string; sessionId?: string }) => ComposerMention[] | Promise<ComposerMention[]>): void;
	/**
	 * 输入框空着时的灰字建议（下一步想说什么），按 Tab 整段填进去，人看过再自己发。宿主画输入框时按注册先后问，
	 * 取第一个给出字的；只问开着的会话，新对话不问。返回空串或 undefined 表示这次没有建议。
	 * 只在渲染时同步调，别在里面做耗时的事。一个插件只能有一个，再注册换掉上一个。
	 */
	composerHint(hint: (session: SessionView) => string | undefined): void;
	/**
	 * 换掉欢迎页问候下面的那一行（默认是「要在某个项目里开发什么？」）：宿主每次画欢迎页时按界面语言问一次，等答复时那一行先空着，
	 * 回来了再淡入。只问最后注册的那一个；返回 undefined、空串或抛错时显示默认的那一句。一个插件只能有一个，再注册换掉上一个。
	 */
	welcomeLine(line: (locale: Locale) => WelcomeLine | undefined | PromiseLike<WelcomeLine | undefined>): void;
	/**
	 * 画回复的正文、复制回复之前，把字过一遍：插件让模型在回复里顺带写的标记（下一步建议的 `:followup[…]`）从这里拿掉。
	 * 只改显示和复制，会话里存的、下一轮发给模型的都不变。正在生成的回复也会过，写了一半的标记也该拿掉。
	 * 按注册先后串起来调；抛错的那一个跳过。一个插件只能有一个，再注册换掉上一个。
	 */
	replyText(transform: (text: string) => string): void;
	/**
	 * 在窗口顶上弹一条提示，过一会儿自己消失，悬停时不走。说的是刚才那一下的结果（操作失败、导出好了），
	 * 不是一直存在的状态；同样的话连着说几次合成一条。
	 */
	notify(message: string, level?: NotifyLevel): void;
	/**
	 * 打开自己注册的面板 `id`，和按它的快捷键一样：开着就切过去，没开就新开一个标签，面板区收着就展开（只展开开着的那个会话的）。
	 * 能开好几个的面板给了 `tab`：开的是 id 为它的那个标签，没有就用这个 id 新开一个（id 要全局唯一，用 `crypto.randomUUID()`）。
	 * `background`：只加标签、不切过去、不展开面板区（网页自己开的新窗口）。
	 */
	openPanel(id: string, sessionId?: string, options?: { tab?: string; background?: boolean }): void;
	/** 关闭自己在该会话打开的面板，仍经过该面板的 onClose；给了 `tab` 只关那一个标签。 */
	closePanel(id: string, sessionId?: string, tab?: string): void;
	/**
	 * 把一段引用（`QuoteAction.run` 拿到的）放进自己面板 `panelId` 里 `ui.Conversation` 的输入框：会话 `sessionId` 眼前开着的正是这个面板时
	 * 追加到它，不然新开一个标签放进去。草稿原样留着，不发送。面板没登记时抛错。输入框的草稿和引用归宿主，所以由宿主放。
	 */
	quoteInPanel(panelId: string, sessionId: string, quote: DraftQuote): void;
	/**
	 * 在指定会话的文件面板只读打开已有文件，本机哪里的都行（见 `AgentService.readFile`）；会话媒体目录里的图（`ctx.media.save` 交回的 `path`）也行。
	 */
	openFile(path: string, sessionId: string): Promise<void>;
	/**
	 * 纯文字里印出来的一条路径（终端输出、日志）在这个会话里指的那个文件，返回绝对路径。绝对路径看它在不在；相对路径先按会话工作目录、
	 * 项目源文件夹拼，不在就按结尾找，只认唯一的一个。不存在、不止一个、是文件夹都是 null；答出来的 `openFile` 打得开。
	 */
	findFile(path: string, sessionId: string): Promise<string | null>;
	/**
	 * 一次拖放带着的本机绝对路径：访达里拖来的文件、文件面板里拖的行。不带路径的拖动是 null。
	 * 在 drop 处理函数里同步调，它返回后就读不到了；dragover 时浏览器不给读内容，带路径也只答空数组。
	 */
	droppedPaths(transfer: DataTransfer): string[] | null;
	/** 产品的文件右键菜单；root 用于复制相对路径，hook 只在组件里调用。 */
	useFileMenu(root: string): FileMenu;
	/** 产品的语法高亮 diff；插件不需要另带一套代码渲染器。 */
	readonly FileDiff: ComponentType<FileDiffProps>;
	/** 产品的文件预览（代码高亮、图片、文档），内容由插件经自己的 remote 读来，见 `FilePreviewProps`。 */
	readonly FilePreview: ComponentType<FilePreviewProps>;
	/** 按扩展名注册只读预览；同扩展名后注册的生效，撤下后恢复前一个。 */
	documentViewer(extensions: readonly string[], component: ComponentType<DocumentPreviewProps>): void;
	/** 复用已注册的文档预览；无匹配或渲染失败时显示 fallback。 */
	readonly DocumentPreview: ComponentType<DocumentPreviewProps>;
	/** 最新一轮结束后跟着回复的卡片。每个组件有独立错误边界，返回 null 不占位。 */
	turnFooter(id: string, component: ComponentType<TurnFooterProps>, options?: { order?: number }): void;
	/**
	 * 回复底下那一排操作里加一个按钮，见 `ReplyActionProps`。排在复制和分叉之间，几个插件按 `order`；组件返回 null 不占位，
	 * 每个有独立错误边界。这一排悬停才显出来、行高 24，按钮不要高过它（`IconButton` 默认尺寸），点开的东西用 `Popover`。
	 */
	replyAction(id: string, component: ComponentType<ReplyActionProps>, options?: { order?: number }): void;
	/**
	 * 侧栏会话行首的记号，见 `SessionMarkProps`。几个插件都注册时按注册先后套起来，先注册的在外层。一个插件只能有一个，再注册换掉上一个。
	 */
	sessionMark(component: ComponentType<SessionMarkProps>): void;
	/**
	 * 删除确认框里补一句话：删掉这个会话会连带什么、会留下什么（工作树：没提交的文件留在哪、没合并的分支留着）。
	 * 确认框打开前问各插件，最多等 600ms，没答上来、返回空、抛错的不写；按注册先后接在产品那句后面。`locale` 是当前界面语言，按它选自己的文案。
	 * 一个插件只能有一个，再注册换掉上一个。
	 */
	deleteNote(note: (sessionId: string, locale: Locale) => string | undefined | Promise<string | undefined>): void;
	/**
	 * 回复里的网址、文件签多一种打开方式，见 `LinkOpener`。几个插件都注册时按注册先后排，点网址时第一个 `takesClicks` 的接手。
	 * 一个插件只能有一个，再注册换掉上一个。
	 */
	linkOpener(opener: LinkOpener): void;
	/**
	 * 本体文件树等处「在终端中打开」由谁接：人点了以后调 `open(directory, sessionId)`，`directory` 是要进去的目录（绝对路径），
	 * `sessionId` 是入口所在的会话。入口是本体的，终端是插件的，所以按种类登记成接手者。每个插件一个、再登记换掉上一个，
	 * 几个插件都登记时最后登记的接，它停用后还给前一个；没人登记时本体提示终端插件没有加载，`open` 抛错时把错误弹成提示条。
	 */
	terminalOpener(open: (directory: string, sessionId: string) => void | Promise<void>): void;
	/**
	 * 回复里 shell 代码块的「在终端运行」：人点击后调用 `run(command, sessionId)`，`command` 已去掉提示符（`$ `、`> `）和注释行，
	 * 要原样执行；`sessionId` 是代码块所在的会话。登记、让位和没有处理器时的提示同 `terminalOpener`。
	 */
	terminalRunner(run: (command: string, sessionId: string) => void | Promise<void>): void;
	/**
	 * 主输入框排队条上，每条排着的消息「更多」菜单里多一项，见 `QueueAction`；排在产品自己的「编辑」后面，几个插件按注册先后。
	 * 没有插件登记时排队条直接放「编辑」按钮，不出菜单。一个插件只能有一个，再注册换掉上一个。
	 */
	queueAction(action: QueueAction): void;
	/** 转录划词后引用菜单里多一项，见 `QuoteAction`。一个插件只能有一个，再注册换掉上一个，停用时撤下。 */
	quoteAction(action: QuoteAction): void;
	/** 用户点击时打开目标项目／目录的空白对话，已有草稿原样保留并追加 text；仍由人按发送。 */
	openConversationDraft(options: ConversationDraft): Promise<void>;
	/**
	 * 往输入框里放字：把字接在草稿后面（原来有字时空一行；`replace` 时换掉整段草稿）、`images` 作为附件挂上、标记落在最后，
	 * 光标移进去，人看过再自己发。给了 `sessionId` 先打开这个会话、放进它的输入框，打不开（删掉了）时抛错；
	 * 不给就放进眼前的输入框（当前对话，或还没发消息的新对话），不换会话。面板窗口里调用交给主窗口，只能交给面板来源的会话
	 * （不给 `sessionId` 也是它），给别的会话抛错。
	 * `send` 是人点了按钮、按了回车要直接发出去：只在人真的刚点过（浏览器的用户激活还在）且输入框原本是空的时发，
	 * 人写了一半的话不跟着发，照草稿留着等人自己发；没人点时只放进草稿。新对话就此开出会话。
	 */
	draftInSession(sessionId: string | undefined, draft: SessionDraft): Promise<void>;
	/**
	 * 打开这个会话，转录滚到这次工具调用的卡片（放在中间），卡片外层闪一下（带上 `data-plume-flash`，插件的样式按它画，
	 * 动画结束或两秒多以后撤掉）。会话还没读完时等它读完；打不开时抛错。
	 */
	revealToolCall(sessionId: string, toolCallId: string): Promise<void>;
	/**
	 * 会话媒体目录里的一张图（`ImageContent.media`、`ctx.media.save` 交回的名字）的地址，给 `<img src>` 用。名字不对时是空串。
	 * 给了 `thumb` 时是长边缩到这么多像素的缩略图（宿主算一次、存在盘上；原图不比它大时就是原图），格子、列表里用它，看图、另存用原图。
	 */
	mediaUrl(name: string, thumb?: number): string;
	/**
	 * 用产品的看图器看几张图：从 `from` 那个元素的位置飞出来、关上时飞回去；`edit` 时打开就进入标注。
	 * 标注完按「完成」，带标注的副本交给那张图的 `onAttach`（`data:` URL），没给 `onAttach` 的复制到剪贴板。
	 */
	openImage(images: ViewerImage[], index: number, options?: { from?: HTMLElement | null; edit?: boolean }): void;
	/** 弹保存对话框把一张图存到磁盘，和看图器的「另存为」一样；`src` 是 `data:` 或 `mediaUrl` 的地址。人取消了不算失败。 */
	saveImage(src: string): Promise<void>;
	/** 把一张图放进剪贴板（转成 PNG），和看图器的「复制」一样；剪贴板不接时退回存文件。`src` 同 `saveImage`。 */
	copyImage(src: string): Promise<void>;
	/** 截取本插件界面所在窗口的可见矩形（CSS 像素），临时隐藏浮动导航/通知/提示，返回 PNG data URL；不能读取其他窗口。 */
	captureWindow(rect: { x: number; y: number; width: number; height: number }): Promise<string>;
	/** 打开本插件注册的、单独占导航一行（`page: "nav"`）的设置分区，不接受其他插件或产品设置的地址。 */
	openSettings(id: string): void;
	/** 打开本插件注册的页面，和点活动栏里那一格一样；不接受别的插件的页面。只在人点了按钮时调（输入框上方提示条的「查看」）。 */
	openPage(id: string): void;
	/**
	 * 活动栏里本插件那一页的那一格右上角挂一个数（有东西在等人看：没人看见的失败）。`null` 或 0 拿掉；人正在那一页上时不画。
	 * `label` 说这个数是什么意思，给读屏和悬停提示。`attention` 为 true 时也列进通知菜单。只能挂本插件注册的页面；插件停用时一起拿掉。
	 */
	pageBadge(id: string, badge: { count: number; label: LocalizedText; attention?: boolean } | null): void;
	/** 用户点击时在系统浏览器打开 HTTP(S) 链接，不允许凭据或其他协议。 */
	openExternal(url: string): Promise<void>;
	/**
	 * 用户点击时把本机的一个文件或文件夹交给系统：文件用默认程序打开，文件夹在文件管理器里打开。直接打开会运行它的
	 * （程序、脚本、应用）和网络共享上的，改成在所在文件夹里指出来并提示一句。打不开（不存在、没有程序认它）时抛错，话是给人看的。
	 */
	openPath(path: string): Promise<void>;
	/**
	 * 用户点击时在系统的文件管理器里打开 `path` 的上级目录，并把它选中（「在访达中显示」）。和 `openPath` 的区别：
	 * `openPath` 打开文件夹是进到它里面、打开文件是交给默认程序；这里不打开它本身，文件、文件夹都只是在上级目录里指出来，
	 * 所以也不会运行它。不存在时抛错，话是给人看的。
	 */
	revealPath(path: string): Promise<void>;
	/**
	 * 用户点击时弹出系统的选文件夹对话框（能当场新建文件夹），交回选中的那个的绝对路径，取消是 null。
	 * `title` 是对话框的标题（macOS 上不显示）。和侧栏新建项目时选文件夹是同一个对话框。
	 */
	pickFolder(title?: string): Promise<string | null>;
	/**
	 * 像人点了回复里的网址那样打开 HTTP(S) 链接：有插件接手点击（`LinkOpener.takesClicks`，比如内置浏览器）时开在它那里，否则系统浏览器。
	 * `sessionId` 是链接所在的会话；规则同 `openExternal`，只在用户点击时调。
	 */
	openLink(url: string, sessionId: string | undefined): Promise<void>;
	/** 加一节设置，默认画进本插件的详情，`options.page` 改放到设置导航或产品的某一页；同一处按 order 从小到大。id 在插件内唯一。 */
	settingsSection(id: string, component: ComponentType<ExtensionsSectionProps>, options: SettingsSectionOptions): void;
	/** 截屏用的宿主能力，见 `ScreenCapture`。 */
	readonly screen: ScreenCapture;
	/** 截屏浮层里画的组件。同一时间只有一个，后注册的生效，它撤下后前一个恢复。 */
	screenOverlay(component: ComponentType<ScreenOverlayProps>): void;
	/** 钉在桌面上的那个小窗口里画的组件。同一时间只有一个，后注册的生效，它撤下后前一个恢复。 */
	pinnedShot(component: ComponentType<PinnedShotProps>): void;
	/**
	 * React hook：一个会话的视图，随它的事件更新（消息、草稿、进度、审批）；还没读到、会话不在了是 undefined。
	 * 子 Agent 的卡片拿它画子会话的进度。只在组件里调，规则同 React 的 hook。
	 */
	useSession(sessionId: string | undefined): SessionView | undefined;
	/**
	 * React hook：侧栏行首给这个会话的记号，见 `SessionActivity`；人打开那个会话后，`done`、`failed` 就清掉（看过了），没有记号是 undefined。
	 * 只在内存里，重开应用后都算看过。只在组件里调，规则同 React 的 hook。
	 */
	useSessionActivity(sessionId: string): SessionActivity | undefined;
	/**
	 * 订阅所有会话（包括没打开的）落盘的变化，见 `SessionChange`：只说哪个会话、哪一类变了，给跨会话的页面（画廊）知道该重读了；
	 * 流式生成中的增量不发。返回取消订阅的函数，组件的 effect 收尾时调；插件停用时也撤下。会话事件只到渲染进程的宿主，所以由宿主转。
	 */
	onSessionsChanged(listener: (event: SessionChange) => void): () => void;
	/**
	 * 输入框 `/` 菜单此刻有的命令，同名去重后的样子：产品自己的（`/clear`，没有 `plugin`）在前，再是各插件经 `ctx.commands`
	 * 供的。`cwd` 是按哪个目录列（项目里的命令文件、技能跟着变）。只读，展开、发送仍走输入框。每次调用现问，要看时再调。
	 */
	listCommands(context?: { cwd?: string }): Promise<ListedCommand[]>;
	/** 产品的对话视图，见 `ConversationProps`。 */
	readonly Conversation: ComponentType<ConversationProps>;
	/** 产品的会话背景设置：选图、拖入图片、预览、铺放、效果、浓淡、显示位置，以及窗口外圈和对话区的磨砂质感（不看皮肤、不要图）；外观页不再有这一节，背景只经它设置。 */
	readonly ChatBackgroundSettings: ComponentType<{ title?: string }>;
	/** 产品的正文渲染器，插件的任务和回报卡不另带一套 Markdown。 */
	readonly Markdown: ComponentType<MarkdownProps>;
	/** 产品的模型下拉，见 `ModelSelectProps`。 */
	readonly ModelSelect: ComponentType<ModelSelectProps>;
	/** 输入框里的模型和思考档位那两枚，见 `ModelControlsProps`。 */
	readonly ModelControls: ComponentType<ModelControlsProps>;
	/**
	 * 主输入框的发送键，见 `ComposerSendProps`：发送和停止是同一枚，一轮开始、结束时在原地换。给插件自己画的输入框（画廊的改图条）用。
	 * 跑着时按下停下 `sessionId` 这一轮，和主输入框的停止键一样：只有人按了这枚按钮才停，所以停止由按钮自己做，不开给插件直接调。
	 */
	readonly ComposerSend: ComponentType<ComposerSendProps>;
	/** React hook：「跟随」会落到的模型和默认思考档位，见 `ModelDefaults`；设置改了跟着变。只在组件里调。 */
	useModelDefaults(): ModelDefaults;
	/** React hook：登记过的项目，按侧栏的顺序；增删改跟着变。只在组件里调。 */
	useProjects(): readonly ProjectInfo[];
	/**
	 * React hook：返回一个按插件名（`SessionSummary.owner`、`UserMessage.fromPlugin` 里的那种）查显示名的函数，和侧栏会话卡片、
	 * 「来自<插件名>」用的是同一份；插件停用、卸载了或还没读到时查不到（undefined），自己退回一个通用的词，别把插件名露给人。
	 * 装、停用插件时跟着变。只在组件里调。
	 */
	usePluginDisplayName(): (plugin: string) => string | undefined;
	/**
	 * 自己逻辑入口经 `ctx.serve` 开出来的对象。apply 时拿到，存起来给组件用；逻辑入口没开或停用了，调用以错误结束。
	 * T 写逻辑入口那边的接口，末尾的 CallContext 参数这边不传。
	 */
	remote<T extends object>(): Remote<T>;
	/**
	 * 自己逻辑入口 `ctx.settings` 的设置和改它的函数（React hook）：两边谁改了都跟着重画。第一次拿到之前（逻辑入口还没登记、
	 * 停用着）是 undefined。改的函数交回逻辑入口 `normalize` 过的值，校验不过时以错误结束（话是逻辑入口抛的）。T 写逻辑入口那边的类型。
	 */
	useSettings<T extends object>(): [T | undefined, (patch: Partial<T>) => Promise<T>];
	/** 自己逻辑入口 `ctx.store(key, …)` 的当前值（React hook），`set` 了跟着重画；第一次拿到之前是 undefined。 */
	useStore<T>(key: string): T | undefined;
	/** 自己逻辑入口 `ctx.sessionStore(key, …)` 在 `sessionId` 这个会话里的值（React hook），同 `useStore`。 */
	useSessionStore<T>(key: string, sessionId: string): T | undefined;
}
```

### `ToolCardProps`

```ts
export interface ToolCardProps {
	/** 这次调用所在的会话：子会话（子 Agent、侧边聊天）里的调用是那个子会话自己的 id。 */
	sessionId: string;
	call: ToolCall;
	/** 参数尚在生成时的原始 JSON；只供安全的静态草稿展示。 */
	argumentsText?: string;
	streaming?: boolean;
	/** 发送到卡片所属会话。只在真实点击/提交，或聚焦的卡片 iframe 发来的用户操作消息中同步调用；只读视图没有此入口。displayText 可提供气泡中显示的简短说明，text 仍是完整模型输入。 */
	send?: (text: string, event: import("react").SyntheticEvent | MessageEvent, displayText?: string) => Promise<void>;
	/**
	 * 卡片画在插件的子会话（侧边聊天）里时才有：把一件事排进它父会话的队列，标着来自哪个插件，和
	 * `ToolRun.parent.enqueue` 同一条路。只在人点了卡片上写明要交出去什么的按钮时调（「交给主会话」），不拿来替人做决定。
	 */
	handToParent?(instruction: string): Promise<void>;
	status: "approval" | "running" | "done" | "failed";
	/** 执行中的输出。 */
	progress?: string;
	/** 执行完才有。 */
	result?: ToolOutput;
	/** 通用卡片。认不出 details 时直接返回它。 */
	fallback: ReactNode;
}
```

### `RequestCardProps`

```ts
/**
 * 插件给 `run.request` 画的卡（`ui.requestCard`）：问题、计划、表单。摆在哪、排队、过期、停下这一轮时撤卡归产品，
 * 组件画整张卡（外框用 `@plume/ui` 的 `ApprovalFrame`），人答了调 `answer`，不答调 `decline`。
 * 审批（放不放行）的卡只有产品的那一张，插件换不掉。
 */
export interface RequestCardProps {
	request: HumanRequest;
	/** 在问的会话；子会话（侧边聊天、子 Agent）问时是子会话的 id。 */
	sessionId: string;
	/** 问的是子会话时它的标题，卡上要写明是谁在请求。 */
	from?: string;
	/** 排在这张后面还在等的张数，卡上写 +N（`ApprovalFrame` 替你写）。到期时刻在 `request.expiresAt`。 */
	queued: number;
	/** 交回人给的数据，工具从 `run.request` 拿到 `{ answered: true, value }`。没送到时抛错，卡片自己把错误摆出来、让人再答。 */
	answer(value: unknown): Promise<void>;
	/** 人不答，工具拿到 `{ answered: false, reason: "declined" }`。 */
	decline(): Promise<void>;
	/** 设置里现在的权限模式。 */
	permission: PermissionMode;
	/**
	 * 把权限模式从请求批准切到帮我批准，给「接受并开启自动模式」这样的按钮：先调它，再 `answer`。
	 * 只在人点了卡上的按钮时调；不在请求批准档时什么都不改（不会把完全访问降下来）。
	 */
	allowAuto(): Promise<void>;
	/** 窄窗口：面板区一次只摆一格，打开面板会盖住这张卡，要读的东西画在卡里。 */
	compact: boolean;
	/** 产品的通用卡（标题和一个「不答」）。认不出 `payload` 时直接返回它。 */
	fallback: ReactNode;
}
```
