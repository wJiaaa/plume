/**
 * AgentService：agent 进程给界面的服务，以及它推送的事件和返回的视图。界面经 `@plume/rpc` 调用。
 */

import type { ModelCatalogDocument } from "@plume/llm/model-catalog-format";
import type { RetryPolicy } from "@plume/llm/retry-policy";
import type { ApiFormat, AssistantMessage, Message, MessageAttachment, ModelPricing, ThinkingLevel, ThinkingOption, UserContent } from "@plume/llm/types";
import type { CallContext } from "@plume/rpc";
import type { RevertPlan } from "./changes.ts";
import type { CommandContext, CommandResult, Locale, SlashCommand } from "./plugin.ts";
import type { ClearRange, ClearResult, StorageUse, UsageRequestBucket } from "./usage.ts";

/**
 * 模型设置：若干供应商，每个供应商下若干模型，一个全局默认模型；会话可以另选一个。
 * 一个模型用「供应商 id/模型 id」指代（ModelRef）。模型 id 本身可以带斜杠（如 anthropic/claude-opus-5-5），
 * 供应商 id 不带，所以按第一个斜杠拆。
 */
export type ModelRef = string;

export interface ModelEntry {
	/** 发给供应商的模型 id，同一个供应商下唯一。 */
	modelId: string;
	/** 界面上显示的名字。 */
	name: string;
	contextWindow: number;
	maxOutputTokens: number;
	supportsThinking: boolean;
	supportsImages: boolean;
	supportsTools: boolean;
	/** 每百万 token 的美元价格；不填就不算费用。 */
	pricing?: ModelPricing;
	/** 可选的思考档位；不填用默认几档。 */
	thinkingOptions?: ThinkingOption[];
	/** 生图模型：用来画图和改图，不出现在对话模型列表里，也不当默认模型。不填按模型 id 判断（`gpt-image-1`、`…-image` 这类）。 */
	imageOutput?: boolean;
}

export interface ProviderSettings {
	/** 只含小写字母、数字和连字符；新建时留空，由 agent 进程分配。 */
	id: string;
	name: string;
	api: ApiFormat;
	baseUrl: string;
	/** 停用的供应商不出现在模型选择里，也不会被当成默认模型。 */
	enabled: boolean;
	models: ModelEntry[];
}

export interface ProviderView extends ProviderSettings {
	/** 已经存了 API key。key 本身不出 agent 进程。 */
	hasKey: boolean;
}

/**
 * 本体的工具多大程度上不用问人就能做。`ask`：会改动工作区的工具每次都问，命令跑在只读沙箱里；
 * `auto`（默认，「帮我批准」）：只问看得出风险的，命令跑在只能写项目目录和临时目录的沙箱里；
 * `full`：一律不问，命令不进沙箱。
 */
export type PermissionMode = "ask" | "auto" | "full";

/** 回复的语气，放进系统提示词的一段；`professional` 不加这一段。 */
export type Tone = "friendly" | "professional" | "concise" | "candid" | "humorous";

/** 设置 › 个性化：对所有会话都生效的全局指令和语气。 */
export interface Personalization {
	/** 用户自己写的全局指令，放进每个会话的系统提示词；空的不放。 */
	customInstructions: string;
	tone: Tone;
}

export interface SettingsView {
	providers: ProviderView[];
	permissionMode: PermissionMode;
	personalization: Personalization;
	/** 实际生效的默认模型：设过且还可用就是它，否则是第一个可用的模型；一个都没有时为空。 */
	defaultModel?: ModelRef;
	/** 模型菜单里星标的模型，按星标的先后；可能含已经不可用的，界面跳过。 */
	favoriteModels: ModelRef[];
	/** 设置里选的默认生图模型，原样给出（可能已经不可用）；没选是空，生图时用第一个生图模型。 */
	imageModel?: ModelRef;
	/** 新会话的思考档位：建会话时记到会话上，之后改它不影响已有的会话。 */
	thinking: ThinkingLevel;
	/** 模型请求的重试策略，已收好范围；改了正在重试的请求从下一次等待起就用新值。 */
	retryPolicy: RetryPolicy;
}

/**
 * 登记过的项目：一件事和它所在的文件夹。同一个文件夹可以登记成几个项目，所以会话记的是项目 id，不靠目录认项目。
 */
export interface ProjectEntry {
	id: string;
	name: string;
	/** 在这个项目里新开的会话在这里工作；改了它，已有的会话还在原来的目录。 */
	path: string;
	/** 源文件夹；第一个仍是 path，其余目录允许读取。 */
	folders?: string[];
	/** 手动排列的会话 id；新会话排在这些会话前面。 */
	sessionOrder?: string[];
}

export type SessionUsage = Pick<UsageRequestBucket, "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "unpriced">;

/** 悬停卡片的统计；花销来自账本，不随撤回或压缩减少。 */
export interface SessionStats {
	turns: number;
	steps: number;
	usage: SessionUsage;
	/** 当前对话回复的输入统计；附带模型调用和子会话不计入。 */
	replyUsage: Pick<SessionUsage, "input" | "cacheRead" | "cacheWrite">;
	children: Array<{ owner?: string; usage: SessionUsage }>;
}

/** 新会话开在哪：项目里、某个文件夹，都不给就是不属于任何项目的聊天，开在 agent 的公共目录里。 */
export interface SessionTarget {
	project?: string;
	cwd?: string;
}

export interface SessionSummary {
	id: string;
	/** 默认为第一条消息的开头，也可由用户或插件命名；空字符串时界面显示「新会话」。 */
	title: string;
	/** 用户手动命名过，自动标题不再覆盖。 */
	titleEdited?: boolean;
	/** 工作目录：工具在这里读写、执行命令。 */
	cwd: string;
	/** 开在哪个项目里（项目 id）。没有、或者项目已经移除，就是不属于任何项目的聊天。 */
	project?: string;
	createdAt: number;
	updatedAt: number;
	running: boolean;
	/**
	 * 它派出去的后台运行（子智能体之类，见 `SessionAccess.start`）还没都回来，或者交回的结果攒着、还没送进会话。
	 * 和 `running` 各管各的：`running || background` 才是这件事还没做完（回答底下的交付卡片等它）。只在内存里，不存盘。
	 */
	background?: boolean;
	/** 这个会话选的模型；没选、或者选的已经不可用时用默认模型。 */
	model?: ModelRef;
	/** 这个会话选的思考档位；没选时用模型的默认档，模型没有这一档时就近取一档。 */
	thinking?: ThinkingLevel;
	/** 上一轮是怎么结束的；正在跑、还没跑过、或者上次没来得及记下（进程崩了）时没有。 */
	stop?: TurnStop;
	/** 归档了：移出侧栏，记录和用量都还在，在设置 › 已归档的聊天里取消归档或删除。 */
	archived?: boolean;
	/** 置顶单独显示；归档不清掉，取消归档后回到置顶区。 */
	pinned?: boolean;
	/** 手动标记的未读，下一次选中会话时清除。 */
	unread?: boolean;
	/**
	 * 子会话挂在哪个会话下面（插件建的侧边聊天、子 Agent，见 `SessionAccess.create`）。子会话不进侧栏，
	 * 工作目录和项目随父会话，没另选模型时用父会话的模型，父会话删掉时一起删。
	 */
	parentId?: string;
	/**
	 * 建这个会话的插件：只有它能在里面发起一轮。有 `owner` 没有 `parentId` 的是插件的独立会话（见 `SessionAccess.create`），
	 * 和子会话一样不进侧栏。侧栏里的会话两样都没有。
	 */
	owner?: string;
	/** 插件经 `ctx.sessions.launch` 从哪个会话开出来的（计划交出去执行的那个会话、那次调用）。会话本身独立保存，侧栏同组时嵌套在来源下面。 */
	spawnedFrom?: { sessionId: string; toolCallId?: string };
	/** 从哪条会话的消息分叉；来源存在于同一分组时嵌套显示。 */
	forkedFrom?: { sessionId: string };
	/** 记录里有几条消息（人说的、回复、工具结果都算），给已归档的页和删除前的问题说「多少」。 */
	messageCount?: number;
}

/**
 * 一轮为什么结束：答完了（done）、人按了停（aborted）、出错（error）、用满了步数（max_turns）、
 * 原地打转被叫停（stalled）、应用退出时还在跑（interrupted）。
 */
export type NoticeLevel = "info" | "warn" | "error";

export type StopReason = "done" | "aborted" | "error" | "max_turns" | "stalled" | "interrupted";

export interface TurnStop {
	reason: StopReason;
	/** 出错时给人看的那句话。 */
	error?: string;
}

/**
 * 一次连接上的岔子，从开始到收场：等着重试、接上了、放弃了、等的时候被人停下。
 * 同一次中断重试几回都是这一条，次数往上加；接上以后再断是新的一条。
 */
export interface Hiccup {
	id: string;
	/** 发生时会话里已经有几条消息：界面按它把这条记录插进转录。 */
	at: number;
	attempts: number;
	/** 这次等待在什么时刻结束（毫秒时间戳）；存时刻不存时长，时长在画出来之前就过期了。 */
	until: number;
	/** 一行放得下的原因。 */
	summary: string;
	/** 服务商的原文，展开才看。 */
	detail?: string;
	kind: "network" | "upstream" | "fatal";
	/** 同一个错误的指纹：连着好几次一字不差，界面就说「一直是同一个错误」。 */
	fingerprint: string;
	/** 同一个指纹连续出现了几次。 */
	repeated: number;
	/** `switched`：等重试时人换了模型，这次请求放手，换成新模型从同一处重发。 */
	outcome: "waiting" | "recovered" | "gave_up" | "stopped" | "switched";
	/** 换成了哪个模型（名字），只在 `switched` 时有。 */
	switchedTo?: string;
	/** 下一步该去哪：查密钥（check-key）、查模型（check-model）、看额度……，来自失败分类。 */
	hint?: string;
}

export type { ModelCatalogDocument, RetryPolicy, ThinkingLevel };

/** 测试连接的结果：真发一次请求，拿到第一个 token 就停。 */
export interface ProviderTestResult {
	ok: boolean;
	latencyMs: number;
	/** 给人看的一句话：成功时说谁回答了，失败时是原因。 */
	message: string;
	/** 测整个供应商时，端点列出来的模型 id（端点支持列出时才有）。 */
	models?: string[];
}

/** 从供应商的 `/v1/models` 拉到的模型 id，按名字排好。 */
export interface FetchModelsResult {
	ok: boolean;
	models: string[];
	error?: string;
}

/** 拉一次模型目录的结果。 */
export interface CatalogSyncResult {
	status: "updated" | "unchanged" | "failed";
	/** 失败原因，给设置页显示。 */
	error?: string;
	source: ModelCatalogDocument["source"];
}

/**
 * 导入前的预览。文件由 agent 进程读，key 不出 agent 进程，所以这里只说有没有。
 * 读不懂时 problem 说明是哪一种：不是 JSON、不是供应商文件、比这个版本新、一个能用的供应商都没有。
 */
export type ProviderImportPreview =
	| { ok: false; problem: "not-json" | "not-a-bundle" | "too-new" | "no-providers" }
	| {
			ok: true;
			entries: ProviderImportEntry[];
			/** 文件里读不懂、被丢掉的条目数。 */
			dropped: number;
	  };

export interface ProviderImportEntry {
	id: string;
	name: string;
	api: ApiFormat;
	baseUrl: string;
	models: number;
	/** 这台机器上已经有同 id 的供应商：导入会替换它。 */
	kind: "new" | "replace";
	/** 文件里带了 key。 */
	hasKey: boolean;
	/** 文件里没带 key，被替换的那个有，导入后留着本机的。 */
	keepsLocalKey: boolean;
}

/** 正在等用户决定的一次工具调用。 */
export interface ApprovalRequest {
	toolCallId: string;
	tool: string;
	/** 要做的是哪一类事：本体工具是 `bash`、`write`、`edit`，插件的工具是它的名字。卡片按它写一个小标签。 */
	kind: string;
	title: string;
	/** 卡片正文：命令、diff，插件的工具是它的参数。 */
	detail: string;
	/** 「以后不再问」记下的东西：命令或文件的绝对路径。没有时只能答这一次。 */
	subject?: string;
	/** 为什么要问：插件的层自己问时给的理由，或者模型申请提权时说的那句话。 */
	reason?: string;
	/** 申请把这一条命令放到更宽的沙箱模式里跑。只管这一次，答「以后不再问」也不会记下。 */
	escalation?: "workspace-write" | "danger-full-access";
	/**
	 * 问的是人的决定（批准一份计划），不是权限：完全访问、外层放行、「以后不再问」都不替人答，总是弹给人。
	 * 没有 `subject`，只能答这一次。
	 */
	userOnly?: boolean;
	/**
	 * 等这张卡时一句短的状态（按界面语言），画在对话末尾的运行行、侧栏的悬停和系统通知里：「等你批准计划」「等你填写表单」。
	 * 不给时本体按 `userOnly` 说「等待你的回答」或「等待你的批准」。
	 */
	waiting?: string;
	/**
	 * 这张卡等到什么时候（毫秒时间戳），到时没人答按拒绝收场：权限请求等 5 分钟，`userOnly` 的（提问、表单、计划）等
	 * 30 分钟。本体弹卡时填，插件经 `run.ask` 给的不算。给时刻而不是时长：事件跨进程送到、画出来时，时长已经不准了。
	 */
	expiresAt?: number;
}

/** 人怎么答：允许这一次、以后都不再问这一项、拒绝。 */
export type ApprovalDecision = "once" | "always" | "reject";

/**
 * 用户发出去的一条消息。
 *
 * `content` 是给模型的：字和图片按附件在正文里的位置排好，文本附件的正文也在里面。`displayText` 是气泡里给人看的
 * 那句话（带着 `【图片 1】` 这样的标记）；`attachments` 只有名字和门类，给气泡画附件用，正文不再存一份。
 * 图片的 `data` 是不带 `data:` 前缀的 base64；存进会话时大图挪到 `session-media` 里，消息只留 `media` 名。
 */
export interface OutgoingMessage {
	/** `@` 选中的历史会话，正文经 session:// 引用，不把整份转录塞进消息。 */
	sessionRefs?: { id: string; title: string }[];
	content: UserContent[];
	displayText?: string;
	attachments?: MessageAttachment[];
	/** 界面替人说的话（「继续」按钮发的那句）：照样发给模型，对话里不画成人的气泡，也不拿来当标题。 */
	synthetic?: boolean;
	/** 这一轮还在跑时：先停下它、等它收完尾，再拿这条开始新的一轮（排队条上的「现在就发」）。不给时正在跑就报错。 */
	interrupt?: boolean;
	/**
	 * 这一轮还在跑时：插进去，模型做完手上这一步、下一次请求之前读到（命令声明的 `deliver: "steer"`）。这一轮已经在收尾、
	 * 不会再来取话时排进队尾。空闲时就是新的一轮。
	 */
	steer?: boolean;
}

/**
 * 排在一个会话后面、等着轮到自己的一条（输入框上方那几行）。会话忙时人按下回车的，和侧边聊天交过来的任务排的是同一条队。
 * 存在 agent 进程里、落盘：关了窗口、重开应用还在。这一轮以完成结束时发下一条；停了、出错了留着等人。
 */
export interface QueuedMessage {
	id: string;
	/** 行里显示的那句话。 */
	preview: string;
	/** 轮到它时整份发出去的东西。 */
	message: OutgoingMessage;
	/** 不是人在这个会话的输入框里排的：`side-chat` 是侧边聊天交过来的任务，发出去的消息带着同样的来处（`UserMessage.origin`）。 */
	origin?: "side-chat";
	/** 侧边聊天交过来的：是哪一个子会话交的，它的回执条（`HandedTask`）据此列出这一条。 */
	sideId?: string;
	createdAt: number;
}

/**
 * 侧边聊天交给父会话的一件事走到了哪：子会话的回执条一行一件。还排着的就是父会话队列里那一条（`id` 相同），
 * 开始跑以后的状态宿主只记在内存里，重开应用就没了；做了什么在父会话的转录里，这里只是回执。
 */
export interface HandedTask {
	id: string;
	/** 交过去的指令原文。 */
	text: string;
	/** `running` 是父会话正在为它跑一轮。 */
	status: "queued" | "running" | "done" | "failed" | "cancelled";
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** 失败时给人看的那句话。 */
	error?: string;
	/** 没出错却没做完：原地打转被叫停、用满了步数。 */
	unfinished?: "stalled" | "max_turns";
	/** 父会话被停下、这件跟着停的是 `stop`（还能继续）；人从回执条或计划作废里收回的是 `user`。 */
	cancelledBy?: "user" | "stop";
}

export interface DocumentText {
	text: string;
	/** 有页，但一页字都没有：多半是扫描件。 */
	imageOnly?: boolean;
	/** 字太多被截断了。 */
	truncated?: boolean;
	/** 截断时原文一共多少字，界面据此说「后面还有约多少字没附上」。 */
	fullLength?: number;
}

export interface FileEntry {
	name: string;
	path: string;
	isDirectory: boolean;
}

/** 文件面板读到的一个文件。 */
export interface FileContents {
	text: string;
	/** 比读取上限长，`text` 只是开头。 */
	truncated: boolean;
	bytes: number;
	/** 不是文字（含 NUL 字节）：`text` 为空，界面只说它是二进制文件。 */
	binary?: boolean;
	/** 读的那一刻的 `mtimeMs`。 */
	modifiedAt?: number;
}

export interface SessionView {
	summary: SessionSummary;
	messages: Message[];
	/** 正在生成、还没写完的回复。 */
	draft?: AssistantMessage;
	approval?: ApprovalRequest;
	/** 排在 `approval` 后面还在等的审批张数，没有时不带。 */
	queuedApprovals?: number;
	/** 正在执行的工具调用到目前为止的输出。 */
	progress: Record<string, string>;
	/** 正在执行的工具调用开始的时刻（毫秒时间戳）。排着还没轮到的调用不在里面。 */
	startedAt: Record<string, number>;
	/** 这一轮里连接出的岔子，下一轮开始时清空，不存盘。 */
	hiccups: Hiccup[];
	/** 压缩过的上下文，旧的在前。 */
	compactions: CompactionMark[];
	/** 正在生成摘要。 */
	compacting: boolean;
	/** 排着的几条，先排的在前，见 `QueuedMessage`。 */
	queue: QueuedMessage[];
	/** 这个子会话（侧边聊天）交给父会话的那几件事，先交的在前，见 `HandedTask`。没交过时没有。 */
	tasks?: HandedTask[];
	/** 转录里那几行压缩：自动的（定下要压以后）和人敲的 `/compact`，连同进行中的那一次，旧的在前。 */
	compactionRuns: CompactionRun[];
}

/**
 * `/compact` 和自动压缩的结果。`done` 压完了；`too-short` 对话太短；`already-tight` 已经够紧凑、压了也不会更小；
 * `prune-only` 只剪了几段过长的工具输出、没有要摘要的；`cancelled` 被停下；`failed` 出错（`error` 是原因）。
 */
export type CompactionCode = "done" | "too-short" | "already-tight" | "prune-only" | "cancelled" | "failed";

/** 转录里的一次压缩：画在开始时会话的第 `at` 条消息之前（数到末尾的画在最后）。存在会话库里，撤回截掉它时一起去掉。 */
export interface CompactionRun {
	id: string;
	at: number;
	/** 开始的时刻。 */
	startedAt: number;
	/** 人敲的那一行（`/compact 保留接口设计`）；自动压缩没有。 */
	input?: string;
	status: "running" | "done" | "skipped" | "failed" | "cancelled";
	/** 走到哪一步了，见 `CompactionProgress`。 */
	phase: "summarizing" | "retrying" | "fallback";
	/** 摘要请求重试过几次。 */
	retries: number;
	/** 结束时为什么是这个结果；`failed` 时 `error` 是原因。 */
	code?: CompactionCode;
	error?: string;
	/** 压完前后发给模型的消息条数。 */
	before?: number;
	after?: number;
	/** 摘要是怎么来的，见 `CompactionVia`。 */
	via?: "fork" | "independent" | "fallback" | "dropped";
	/** 一轮收尾以后、人还没开口时压的：外面没有一轮在跑，这一行自己说「进行中」。 */
	idle?: boolean;
}

/** 一次上下文压缩：界面在 `keptFrom` 那条消息前画一条分隔线。会话里的消息一条不少，只是模型从此看到的是摘要加之后的原文。 */
export interface CompactionMark {
	/** 会话里从第几条起原样发给模型。 */
	keptFrom: number;
	/** 压缩前后发给模型的消息条数。 */
	before: number;
	after: number;
}

/** `/` 菜单里的一条命令，记着是哪个插件供的：发送前找它展开。 */
export interface CommandEntry extends SlashCommand {
	plugin: string;
}

/** `waiting`：要用的服务还没有插件提供，补上了自动加载（见 `Plugin.inject`）。 */
export type PluginState = "loading" | "active" | "waiting" | "failed" | "disabled" | "disposed";

export interface PluginStatus {
	name: string;
	/** 加载时的标识（`PluginEntry.key`）：插件的目录名，插件市场按它把条目和状态对上。 */
	key: string;
	state: PluginState;
	error?: string;
	/** 界面入口的地址；没有界面入口时为空。 */
	ui?: string;
	/** 随应用发的插件：不能停用、卸载，只能被别的插件替换（服务）或在外层接管（钩子）。 */
	builtin?: boolean;
	/** 等待中时，还没有插件提供的那几项服务。 */
	waitingFor?: string[];
}

export type AgentEvent =
	| { type: "fileRemoved"; paths: string[] }
	/** 文件树改名成功；所有窗口里看着该文件或目录的标签同步跟随。 */
	| { type: "fileMoved"; from: string; to: string }
	| { type: "sessions"; sessions: SessionSummary[] }
	/** 一轮及其后台工作全部收尾；系统通知不能把中间停顿说成完成。 */
	| { type: "idle"; sessionId: string }
	/** 项目登记、改动或移除了：全部项目，新登记的在前。 */
	| { type: "projects"; projects: ProjectEntry[] }
	/** 一条消息写进了会话。回复（assistant）同时顶替正在写的草稿，不另发清空草稿的 draft 事件。 */
	| { type: "message"; sessionId: string; message: Message }
	/** 会话截掉了尾巴（撤回、编辑重发）：只留前 `count` 条消息，压缩记录和压缩行换成留下的那些。 */
	| { type: "rewound"; sessionId: string; count: number; compactions: CompactionMark[]; runs: CompactionRun[] }
	/** 正在生成的回复的最新快照；回复写完后以 message 事件给出完整的一条。undefined 表示草稿作废、没有落进会话。 */
	| { type: "draft"; sessionId: string; draft: AssistantMessage | undefined }
	/** 一次工具调用开始执行了；跑完时随它的结果（message 事件）一起作废。 */
	| { type: "toolStart"; sessionId: string; toolCallId: string; startedAt: number }
	| { type: "progress"; sessionId: string; toolCallId: string; output: string }
	/** 弹给人的那张审批卡换了；`queuedApprovals` 是排在它后面还在等的张数（卡上写 +N），没有时不带。 */
	| { type: "approval"; sessionId: string; approval: ApprovalRequest | undefined; queuedApprovals?: number }
	/** 这一轮的连接岔子变了（开始重试、又重试一次、收场）：全部的最新快照。 */
	| { type: "hiccups"; sessionId: string; hiccups: Hiccup[] }
	/** 压缩开始、走了一步、收场了：`runs` 是全部压缩行的最新快照。 */
	| { type: "compaction"; sessionId: string; compacting: boolean; compactions: CompactionMark[]; runs: CompactionRun[] }
	/** 一个会话排着的几条变了：整条队的最新快照。 */
	| { type: "queue"; sessionId: string; queue: QueuedMessage[] }
	/** 一个子会话交给父会话的那几件事有了变化（排上、开始、收场、拿掉）：全部的最新快照。 */
	| { type: "tasks"; sessionId: string; tasks: HandedTask[] }
	/** 这一轮出了模型调用以外的问题（如没配置模型、钩子出错）。 */
	/** 有 `level` 的进提示条（插件经 `ctx.notice` 说的、循环在压缩或重发）；没有的是这一轮出了错，写在输入框上面。 */
	| { type: "notice"; sessionId: string; text: string; level?: NoticeLevel }
	/** 插件装上、卸下、启用或停用了：全部插件的最新状态。 */
	| { type: "plugins"; plugins: PluginStatus[] };

/**
 * 上下文窗口按来源拆开：对话消息、工具表（MCP 服务的工具 `mcpTools` 单独一段，其余是 `tools`）、系统提示词，
 * 以及系统提示词里单独列出的技能目录（plume.skills 的 `skills` 段）、项目指令（plume.prompt 的 `projectInstructions` 段）
 * 和项目记忆（`projectMemory` 段）。
 */
export type ContextSegmentKey = "messages" | "tools" | "mcpTools" | "skills" | "systemPrompt" | "projectInstructions" | "projectMemory";

export interface ContextBreakdown {
	/** 下一轮会用的模型的上下文窗口。 */
	limit: number;
	/** 各段之和。`measured` 时就是最近一条写完的回复报的「输入 + 缓存读取 + 缓存写入 + 输出」。 */
	used: number;
	/** 总数来自服务商；否则是按字数估的。各段永远是按字数估的，有总数时按比例缩放到它。 */
	measured: boolean;
	/** 大的在前；是 0 的不列。 */
	segments: Array<{ key: ContextSegmentKey; tokens: number }>;
	/**
	 * 项目指令和项目记忆两段里来自各文件的部分（插件经 `PromptSection.files` 标的），先项目指令、后项目记忆，各按段里的顺序。
	 * 和各段一样按字数估，按各自所在的段缩放；包在文件外面的说明文字不算哪个文件。没有标来源时是空的。
	 */
	memoryFiles: Array<{ path: string; tokens: number }>;
}

export interface AgentService {
	/** 项目覆盖的来源与差异，不返回供应商凭据。 */
	projectLayer(cwd: string): Promise<ProjectLayerView>;
	fileOperation(sessionId: string, operation: FileOperation): Promise<FileOpResult>;
	getSettings(): Promise<SettingsView>;
	/** 新建（id 为空）或整体替换一个供应商，返回它的 id。apiKey 为空表示不改已保存的 key。 */
	saveProvider(provider: ProviderSettings & { apiKey?: string }): Promise<string>;
	deleteProvider(providerId: string): Promise<void>;
	setDefaultModel(model: ModelRef): Promise<void>;
	/** 设默认生图模型；传 null 回到「自动」（第一个生图模型）。 */
	setImageModel(model: ModelRef | null): Promise<void>;
	/** 整体替换星标的模型。 */
	setFavoriteModels(models: ModelRef[]): Promise<void>;
	setPermissionMode(mode: PermissionMode): Promise<void>;
	/** 设新会话的思考档位，已有的会话不变。 */
	setDefaultThinking(thinking: ThinkingLevel): Promise<void>;
	/** 整体替换重试策略，存之前按 `normalizeRetryPolicy` 收好范围。 */
	setRetryPolicy(policy: RetryPolicy): Promise<void>;
	/** 改个性化设置里给出的几项，下一轮生效。 */
	setPersonalization(change: Partial<Personalization>): Promise<void>;
	/** 给会话选模型，下一轮生效；传空表示跟随默认模型。 */
	setSessionModel(sessionId: string, model: ModelRef | undefined): Promise<void>;
	/** 给会话选思考档位，下一轮生效；传空表示用模型的默认档。 */
	setSessionThinking(sessionId: string, thinking: ThinkingLevel | undefined): Promise<void>;
	/**
	 * 测试连接：测整个供应商（modelId 为空）时先列一次模型，再用第一个模型真发一次请求；指定了模型就只测它。
	 * 用的是已经保存的设置，key 不出 agent 进程。
	 */
	testProvider(providerId: string, modelId: string | undefined): Promise<ProviderTestResult>;
	/** 从供应商的 `/v1/models` 拉模型列表。 */
	fetchModels(providerId: string): Promise<FetchModelsResult>;
	/** agent 进程当前生效的模型目录（可能比界面打包的那份新）；版本和 knownRevision 相同时返回 null。 */
	modelCatalog(knownRevision: string | undefined): Promise<ModelCatalogDocument | null>;
	/** 立即从 pi.dev 拉一次模型目录。 */
	updateModelCatalog(): Promise<CatalogSyncResult>;
	/** 把全部供应商（连同 key，Magpie 的除外）写进 file，返回写了几个、带没带 key。路径由界面经主进程的保存对话框拿到。 */
	exportProviders(file: string): Promise<{ providers: number; containsSecrets: boolean }>;
	/** 读 file，说明导入会做什么，不写任何东西。 */
	previewProviderImport(file: string): Promise<ProviderImportPreview>;
	/** 导入 file 里选中的那几个供应商（按 id），返回导入了几个。默认模型不在了就落到第一个可用的。 */
	importProviders(file: string, providerIds: string[]): Promise<number>;
	/** 全部项目，新登记的在前。 */
	listProjects(): ProjectEntry[];
	/** 登记一个项目；名字留空时用文件夹名。 */
	createProject(name: string, path: string, folders?: string[]): Promise<ProjectEntry>;
	updateProject(projectId: string, name: string, path: string, folders?: string[]): Promise<void>;
	/** 只忘掉这条登记：磁盘上的文件夹不动，它的会话还在，归到「聊天」里。 */
	removeProject(projectId: string): Promise<void>;
	/** 调整项目顺序。 */
	reorderProjects(sourceId: string, targetId: string, placement: "before" | "after"): Promise<void>;
	/** 保存项目内会话的手动顺序；只接受本项目的非置顶、非归档顶层会话。 */
	reorderProjectSessions(projectId: string, sessionIds: string[]): Promise<void>;
	sessionStats(sessionId: string): Promise<SessionStats>;
	listSessions(): SessionSummary[];
	createSession(target: SessionTarget): Promise<SessionSummary>;
	getSession(sessionId: string): Promise<SessionView>;
	deleteSession(sessionId: string): Promise<void>;
	/** 修改会话标题，去掉首尾空白；空标题不保存，不改变最后活动时间。 */
	renameSession(sessionId: string, title: string): Promise<void>;
	/** 归档或取消归档。归档的会话照样能打开、接着聊。 */
	setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
	/** 置顶和手动未读都不改变最后活动时间。 */
	setSessionPinned(sessionId: string, pinned: boolean): Promise<void>;
	setSessionUnread(sessionId: string, unread: boolean): Promise<void>;
	/** 移入项目时切换工作目录；移出时保留目录。会话或子会话运行时不允许移动。 */
	moveSessionProject(sessionId: string, projectId: string | undefined): Promise<void>;
	/** 删掉全部归档的会话，正在跑的不动。返回删了几条。 */
	deleteArchivedSessions(): Promise<number>;
	/**
	 * 这个会话的上下文窗口用到哪儿了，见 `ContextBreakdown`。各段按这个会话最近一次发出的请求量（只在内存里），
	 * 本次启动后还没发过请求时是 null。
	 */
	contextBreakdown(sessionId: string): Promise<ContextBreakdown | null>;
	/** 会话记录占了多少，按最后活动日摊开。 */
	storageUse(): Promise<StorageUse>;
	/** 删掉最后活动日落在这一段里的会话，正在跑的跳过。花销表不动。 */
	clearSessions(range: ClearRange): Promise<ClearResult>;
	/** 把整个会话库另存为一个 SQLite 文件。路径由界面经主进程的保存对话框拿到。 */
	exportSessions(file: string): Promise<void>;
	/** 只导出这一段会话。原始库包含草稿；Markdown 只含已落盘的正文、工具摘要，附件只列名称。 */
	exportSession(sessionId: string, file: string, format: "database" | "markdown"): Promise<void>;
	/** 发出一条消息，开始一轮。立即返回；过程经 watch 推送。正在跑时只收带 `interrupt` 的。 */
	send(sessionId: string, message: OutgoingMessage): void;
	/**
	 * 排到队尾（`QueuedMessage`），返回排上的那一条。会话这会儿空着（上一轮被停下、队里还有前面的）就由这一下发出队首，
	 * 新排的这条照样排在后面。子会话里只有建它的插件能发起一轮，不收。
	 */
	queue(sessionId: string, message: OutgoingMessage, preview: string): Promise<QueuedMessage>;
	/** 「现在就发」：把这一条拿出来发，正在跑就先停下那一轮（同 `interrupt`）。没有这一条时什么都不做。 */
	sendQueued(sessionId: string, id: string): Promise<void>;
	/**
	 * 从队里拿掉这一条，交回拿掉的那条（删除、编辑退回输入框、交给插件的「更多」项都走这里）；已经发出去、不在队里时是 undefined，
	 * 调用方据此知道它没拿到，不再拿旧的那份去用。
	 */
	removeQueued(sessionId: string, id: string): Promise<QueuedMessage | undefined>;
	/** 拖动、↑↓ 改先后：`id` 那一条挪到 `targetId` 前面或后面。两条有一条不在队里时什么都不做。 */
	moveQueued(sessionId: string, id: string, targetId: string, placement: "before" | "after"): Promise<void>;
	/**
	 * 人在子会话（侧边聊天）的卡片上点了「交给主会话」：把这件事排进 `sessionId` 这个子会话的父会话，和插件的
	 * `ParentSession.enqueue` 同一条路（标着来自侧边聊天）。只认父会话，不是子会话时报错。
	 */
	queueTask(sessionId: string, instruction: string): Promise<void>;
	/**
	 * 回执条上的「重试」「继续」：子会话 `sessionId` 交过去、失败了或随父会话停下的那件事重新排进父会话队尾，和第一次交过去一样。
	 * 别的状态不动，返回排上没有。
	 */
	retryTask(sessionId: string, taskId: string): Promise<boolean>;
	/** 回执条上的「移除」：收了场的那件从列表里拿掉，父会话的转录不动。还排着、在跑的不动，返回拿掉没有。 */
	dismissTask(sessionId: string, taskId: string): Promise<boolean>;
	/**
	 * 编辑重发：第 `index` 条（人发的消息）连同它之后的全部截掉，拿 `message` 重新开始一轮。截完就返回，这一轮经 watch 推送。
	 * 正在跑时报错。图片块可以只带 `media`（会话里存着的那张），不用把像素再传一遍。
	 * `files` 为真时先把截掉的那段改过的文件退回去（钩子 session.rewind），退不回去就报错，对话不截、也不重发。
	 * 插件的子会话也能编辑重发（插件经 `ConversationProps.reask` 同意了），但不带 `files`；撤回、演算、分叉仍然只给人自己的会话。
	 */
	editMessage(sessionId: string, index: number, message: OutgoingMessage, options?: { files?: boolean }): Promise<void>;
	/** 撤回：第 `index` 条（人发的消息）连同它之后的全部截掉。正在跑时报错。`files` 同 `editMessage`。 */
	revertMessage(sessionId: string, index: number, options?: { files?: boolean }): Promise<void>;
	/** 撤回、编辑重发第 `index` 条会截掉的那段改过哪些文件、能不能一起退回，只演算，不写（钩子 session.rewind）。 */
	revertPlan(sessionId: string, index: number): Promise<RevertPlan>;
	/**
	 * 从第 `index` 条分叉出一个新会话，原会话不动。人发的消息：新会话停在它之前；落定的回复：新会话带着它。
	 * `timestamp` 用来核对是不是那一条，对不上时按时间戳重找。正在跑也可以分叉。
	 */
	forkSession(sessionId: string, index: number, timestamp: number, title: string): Promise<SessionSummary>;
	/**
	 * 从一份文档（PDF、Word、Excel、PowerPoint 和它们的开放格式、压缩包）里抽出文字，给附件用。
	 * 认不出的格式返回 null；扫描件之类没有文字层的，`imageOnly` 为 true。
	 */
	documentText(name: string, data: Uint8Array): Promise<DocumentText | null>;
	/**
	 * 给文件面板读一个文件。只认这个会话工作目录和项目源文件夹里的路径，另加这个会话最近一次请求的「记忆文件」
	 * （`ContextBreakdown.memoryFiles`，只读、按原路径给）；不在这些里、不存在、是文件夹都返回 null。
	 * 太长的只读开头（`truncated`），不是文字的只报大小（`binary`）。
	 */
	readFile(sessionId: string, path: string): Promise<FileContents | null>;
	/** 文档预览的原始数据，受同一会话读取边界约束，最多 64 MiB；版本不符时报错。 */
	readFileBytes(sessionId: string, path: string, modifiedAt: number | undefined, call: CallContext): Promise<Uint8Array>;
	/** 列出会话目录或项目源文件夹里的一级目录，不跟随软链。 */
	/** `@` 菜单列会话或已登记项目的源目录顶层；新聊天没有目录时为空。 */
	mentionFiles(target: SessionTarget, sessionId: string | undefined): Promise<(FileEntry & { origin?: string })[]>;
	listDirectory(sessionId: string, path: string): Promise<FileEntry[]>;
	/** 在原目录中改名；不覆盖同名目标，不改会话根目录。 */
	renameFile(sessionId: string, path: string, name: string): Promise<string>;
	/**
	 * 在会话工作目录里找一个写得不全的路径：裸文件名（`approvals.ts`）或相对于某个子目录的路径。
	 * 返回找到的绝对路径，按路径排好；跳过依赖和构建产物目录。
	 */
	locateFiles(sessionId: string, relative: string): Promise<string[]>;
	stop(sessionId: string): void;
	respond(sessionId: string, toolCallId: string, decision: ApprovalDecision): void;
	/** 插件经 `ctx.commands` 供的全部命令，给输入框的 `/` 菜单。同名的只留先加载的插件那条；哪个插件列不出来就跳过它。 */
	listCommands(context: CommandContext): Promise<CommandEntry[]>;
	/** 让供它的插件把 `/name rest` 展开；插件已经撤下了或不再认这个名字时报错。 */
	expandCommand(plugin: string, name: string, rest: string, context: CommandContext): Promise<CommandResult>;
	listPlugins(): PluginStatus[];
	/** 启用或停用一个插件（按插件名），写进 plugins.json，立即生效。 */
	setPluginEnabled(name: string, enabled: boolean): Promise<PluginStatus[]>;
	/** 界面语言变了：agent 进程之后给人看的报错、提示用这种语言。发给模型的文字不跟着变。 */
	setLocale(locale: Locale): void;
	/** 订阅所有会话的事件，直到调用方取消。 */
	watch(call: CallContext): AsyncGenerator<AgentEvent, void>;
	/**
	 * 调插件逻辑入口经 `ctx.serve` 开出来的方法，给它的界面入口用（`ui.remote()`）。
	 * 方法返回异步迭代器时逐个推回，调用方取消时方法收到的 signal 中止。
	 */
	callPlugin(plugin: string, method: string, args: unknown[], call: CallContext): Promise<unknown>;
}

/** 项目配置错误只携带位置，不把配置原文送进界面。 */
export type ConfigProblem = { kind: "not-object"; path: string } | { kind: "invalid-json"; path: string; detail: string };
export interface LayerOverride {
	key: string;
	kind: "array" | "scalar";
	project: unknown;
	global: unknown;
}
export interface ProjectLayerView {
	path: string;
	exists: boolean;
	error?: string;
	problem?: ConfigProblem;
	refused: string[];
	overrides: LayerOverride[];
}
export type FileOperation =
	| { type: "create"; directory: string; name: string; kind: "file" | "directory" }
	| { type: "rename" | "copy"; from: string; to: string; overwrite?: boolean }
	| { type: "trash" | "remove"; paths: string[] }
	| { type: "unique"; directory: string; name: string }
	| { type: "import"; sources: string[]; directory: string };
export interface FileOpResult {
	ok: boolean;
	path?: string;
	paths?: string[];
	error?: string;
	code?: "exists" | "invalid" | "denied" | "descendant";
}
