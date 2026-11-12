/**
 * 插件逻辑入口的 API：插件默认导出 `Plugin`，在 apply 里通过 ctx 注册工具、往钩子里加层、登记清理。
 * 界面入口的 API 在 `ui.ts`（`@plume/contract/ui`）。
 */

import type { FileChangesService, RevertPlan } from "./changes.ts";
import type { BackgroundJobsService, SessionObservation, SessionWakeupsService } from "./diagnostics.ts";
import type { ResourcesService } from "./resources.ts";
import type { AssistantMessage, DeliveredReport, Message, PeerLetter, ThinkingOption, ToolResultMessage, ToolSpec } from "@plume/llm/types";
import type {
	ApprovalDecision,
	ApprovalRequest,
	CompactionCode,
	HumanRequest,
	NoticeLevel,
	PermissionMode,
	Personalization,
	OutgoingMessage,
	SessionKind,
	SessionSummary,
	ThinkingLevel,
	TurnStop,
} from "./service.ts";
import type { UsageScan } from "./usage.ts";

/** 界面语言。只有这两种；跟随系统时先解析成其中一种再告诉 agent 进程。 */
export type Locale = "zh-CN" | "en";

export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

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
	/** 给工具卡片和插件自己用的结构化数据，存进会话，不发给模型。形状由插件定，本体不看里面。 */
	details?: unknown;
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
}

/**
 * 钩子输入和 `ToolRun` 上的 `session`：这次调用、这一步、这次请求所在的会话是哪一种、挂在哪，本体照实填。
 * 只想知道「是不是侧栏里的会话、是不是自己的子会话」时看它，不用为此去 `ctx.sessions.list()`。
 * 字段的意思同 `SessionSummary` 上的同名字段；`id` 就是 `sessionId`。
 */
export interface SessionScope {
	id: string;
	kind: SessionKind;
	parentId?: string;
	owner?: string;
	spawnedFrom?: { sessionId: string; toolCallId?: string };
	project?: string;
}

/** 审批卡上写什么，见 `ApprovalRequest`。`expiresAt` 由本体弹卡时定。 */
export type ApprovalContent = Omit<ApprovalRequest, "type" | "toolCallId" | "tool" | "expiresAt">;

/** `ToolRun.request` 弹给人的那张卡，见 `HumanRequest`。 */
export type HumanRequestInput = Pick<HumanRequest, "kind" | "title" | "payload" | "waiting">;

/**
 * 人怎么回的 `ToolRun.request`：交回了一份数据，或者没有——`declined` 人点了不答，`expired` 到时没人答，`stopped` 这一轮停了
 * （会话删了也算）。`value` 来自渲染进程，类型参数只是工具期望的形状，用之前自己核一遍。
 */
export type HumanAnswer<T = unknown> = { answered: true; value: T } | { answered: false; reason: "declined" | "expired" | "stopped" };

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
	 * 动手之前问一句（写了 `asks` 的工具用）。经钩子 tool.approve 决定，要不要真的弹给人由那里的层定（内置插件 plume.approval：
	 * 完全访问、外层放行的、答过「以后不再问」的直接放行，提权总是问人）。参数校验完、注定失败的已经报掉之后再问：
	 * 不先问人一个没法成立的问题。用户停止这一轮时得到 `"reject"`。
	 */
	ask(content: ApprovalContent): Promise<ApprovalDecision>;
	/**
	 * 停下来等人给一份数据：回答一个问题、批准一份计划、填一张表。卡片由界面入口按 `kind` 登记（`ui.requestCard`），
	 * 没登记时产品画一张只能「不答」的通用卡。和 `ask` 同排一队、同占输入框上方那一格，子会话问时卡片压在上级会话的输入框上方。
	 * 不是权限：不经钩子 tool.approve，完全访问、「以后不再问」都不替人答。等 30 分钟，到时得到 `expired`；这一轮停了得到
	 * `stopped`。`payload` 要能结构化克隆（它要跨进程送到界面）。
	 */
	request<T = unknown>(input: HumanRequestInput): Promise<HumanAnswer<T>>;
	/** 设置里现在的权限模式，用到才读：中途改了，下一个调用就照新的来。 */
	permissionMode(): Promise<PermissionMode>;
	/** 现在工具表里有哪些工具、各是哪个插件注册的（同名的只列生效的那个）。 */
	tools(): { name: string; plugin: string }[];
	/** 这一步回复里的全部调用（含这一次），按回复里的顺序。工具要知道这一步是不是只做了它这一件事时看它（todo 清单收尾）。 */
	calls: readonly ToolCall[];
	/** 钩子 tool.execute 的外层要求这次调用不改动工作区（见 `ToolExecution.readOnly`）：跑命令的工具只在只读沙箱里跑。 */
	readOnly?: boolean;
	/**
	 * 调用答完以后还在后台接着跑的事（后台命令、监视）把结果送回这个会话的渠道，见 `BackgroundChannel`。
	 * 只有顶层会话有：插件的子会话（侧边聊天、子 Agent）没人等它们的后台结果，拿不到就只能让模型自己去读。
	 */
	background?(): BackgroundChannel;
	/**
	 * 给另一个顶层会话寄一封信（`to` 是它的 id），见 `LetterReceipt`。只有顶层会话有，也只寄得到别的顶层会话：
	 * 子会话不是谁的通信对象。发件方的 id、工作目录由本体照实填上。对方不在、是子会话、是自己时抛错。
	 * 只在这次调用里用：调用答完以后再调就抛错（回执的 `answer` 不受影响）。
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

/**
 * 工具的后台结果回到会话的路。送出的每段和同一时刻别的后台结果（子会话交回的、别的后台命令的）聚合一下，作为一条运行时送达
 * 进会话：会话闲着时开一轮，忙着时在下一个步骤边界（全部工具结果之后、下一次请求之前）读入。送达经钩子 prompt.submit（`synthetic`）。
 * 渠道在人按停止、删会话、退出应用时作废（`signal` 触发）：之后送的不再到，攒着没送的也丢掉——人按停是不想再被它叫醒。
 * 撤回、编辑重发时只作废截掉的那段里的调用拿到的渠道：说起它的那次调用已经不在对话里了；留下那段里拿到的照常送达。
 * 作废只管送达，后台的事本身停不停由工具定（plume.tools 的后台命令照跑，监视跟着停）。
 */
export interface BackgroundChannel {
	/**
	 * 送一段给模型读的话，可以送多次。给函数时到真要送出那一刻才取：返回 `undefined` 就不送了（这期间模型已经自己读过）。
	 * `delivery` 给界面把这条送达画成对话里的一行（「后台命令完成」），不是一个人发的气泡，见 `DeliveryInput`。渠道已作废时返回 false。
	 */
	report(text: string | (() => string | undefined), delivery?: DeliveryInput): boolean;
	/** 渠道作废时触发。 */
	readonly signal: AbortSignal;
}

/**
 * 一份后台结果在对话里画成的那一行，`BackgroundChannel.report`、`ReportOptions.delivery`、`LaunchedSession.reportBack` 给的都是它。
 * 宿主只留这几个字段、拷一份（`details` 要能存成 JSON），记下是哪个插件交的（`DeliveredReport.plugin`），那一行交给这个插件经
 * `ui.agentDelivery` 登记的组件画，没登记就画成宿主默认的一行（`title` 和收场）。`sessionId`（点了去哪个会话）插件写不了，
 * 只有新会话交回时宿主填上。
 */
export type DeliveryInput = Pick<DeliveredReport, "id" | "title" | "status" | "incomplete" | "inline" | "details">;

/**
 * 一封信写什么（`ToolRun.letter`）。字段的意思见 `PeerLetter`：`from` 是发件方的地址，收件方回信时原样当作收件人；
 * 是请求、答复还是通知，答复对着哪几问，所在的往来链，都由寄信的插件定。
 * `guide` 是给收件方模型的处理说明（「标着 reply="expected" 的用 reply_session 回」），一次送达里一样的只写一遍。
 */
export type LetterInput = Pick<PeerLetter, "from" | "text" | "request" | "answer" | "re" | "chain"> & { guide?: string };

/**
 * 信的下落。`read`：写进了收件方的对话；`opened` 是这封信（和同批的）叫起了收件方的一轮，不是插进一轮已经在跑的。
 * `dropped`：没读到——请求还没读到收件方的人就按了停（通知和答复不丢，留到它下一轮开头读，这期间没有着落），或钩子 prompt.submit
 * 拦下了这次送达。`closed`：收件方删掉了，或应用退出了。
 */
export type LetterFate = { status: "read"; opened: boolean } | { status: "dropped" } | { status: "closed" };

/**
 * 寄出的一封信。信和后台结果走同一条路：收件方忙着时在下一个步骤边界读到，闲着时为它开一轮（停下过的也开：一封信是
 * 一件新的事），送达经钩子 prompt.submit（`synthetic`）。前面带一句本体的话：这不是用户说的，不构成用户的授权。
 */
export interface LetterReceipt {
	/** 这封信的 id，记在收件方对话里那条消息的 `peer` 上。 */
	id: string;
	/** 信有了着落时兑现，见 `LetterFate`。 */
	read: Promise<LetterFate>;
	/**
	 * 替收件方回发件方一封信（收件方没用工具回、没读到、关了时插件代答）：从收件方寄回给发件方，只能用一次。
	 * 发件方已经不在时返回 `undefined`。
	 */
	answer(letter: LetterInput): LetterReceipt | undefined;
}

/** 父会话此刻在做什么，见 `ParentSession.status`。 */
export interface ParentStatus {
	/** `running` 正在跑一轮；`background` 这一轮收了尾，它派出去的后台运行还没都回来；`idle` 真闲着。 */
	state: "running" | "background" | "idle";
	/** 队里还排着几条（人排的和交过来的都算）。 */
	queued: number;
}

/**
 * 子会话的一次工具调用够得着的那一面父会话（`ToolRun.parent`）：往它的队里排一件事、立即停下它、让它接着做、看它在不在忙。
 * 改不了文件、读不了别的会话，作用对象只有这一个父会话。写进父会话的话都标着运行时来处，不当成用户新的授权。
 */
export interface ParentSession {
	id: string;
	/**
	 * 把一件事排进父会话的队列（和人在输入框里排的同一条，落盘），父会话真闲着就马上开始。发出去的消息标着来自哪个插件
	 * （`UserMessage.origin` 是 `child`，`fromPlugin` 是建这个子会话的插件），前面带一句给模型的来处说明。`started` 是排上那一刻它就开始了。指令为空时抛错。
	 */
	enqueue(instruction: string): Promise<{ started: boolean }>;
	/**
	 * 立即停下父会话，和人按停止一样（连同它派出去的后台运行）；返回停之前的状态。`discardPlan` 是人明确不要旧目标了：
	 * 等它停稳，删掉队里交过来的任务，再记一句（界面不画成人的气泡）告诉模型旧清单作废、等新的指令。
	 */
	stop(options?: { discardPlan?: boolean }): Promise<ParentStatus>;
	/**
	 * 让父会话接着做：真闲着时以界面的名义（synthetic）发 `text`，和转录底下的「继续」一样，不等这一轮做完就返回；
	 * 正在跑、后台还有没回来的不发。返回发之前的状态。
	 */
	carryOn(text: string): Promise<ParentStatus>;
	status(): ParentStatus;
}

export interface ToolDefinition {
	name: string;
	description: string;
	/** JSON Schema。 */
	parameters: Record<string, unknown>;
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
	execute(args: Record<string, unknown>, run: ToolRun): Promise<ToolOutput>;
}

/** 钩子 tool.execute 的输入。 */
export interface ToolExecution {
	sessionId: string;
	/** 调用所在的会话，见 `SessionScope`。 */
	session: SessionScope;
	cwd: string;
	call: ToolCall;
	/** `plugin` 是注册它的插件（read、write、edit、ls、glob、grep、bash 是内置插件 plume.tools 的）。 */
	tool: { name: string; mutating: boolean; plugin: string };
	/** 外层已经放行的理由。设了它，本体就不再问人（提权、`userOnly` 和层自己问的除外），也不经钩子 tool.approve。 */
	approved?: string;
	/**
	 * 外层要求这次调用不改动工作区（计划模式）。交给工具的 `ToolRun.readOnly`：plume.tools 的 bash 不按权限模式选沙箱，
	 * 一律在只读沙箱里跑，机器上给不了只读沙箱时不跑。只能收紧：里层不该把它去掉。
	 */
	readOnly?: boolean;
	signal: AbortSignal;
	/**
	 * 问一次要不要放行，卡上是这次调用的参数和 `reason`。经钩子 tool.approve（标着 `byLayer`），由那里的层定要不要弹给人
	 * （完全访问下 plume.approval 直接放行）。返回是否放行，用户停止这一轮时得到 false。
	 */
	ask(reason: string): Promise<boolean>;
	progress(chunk: string): void;
}

/**
 * 系统提示词的一段。plume.prompt 给的段（按顺序）：`identity`（身份）、`guidelines`（做事的准则）、`boundaries`（边界）、
 * `environment`（平台、shell、是不是 git 仓库、模型）、`tone`（语气）、`userInstructions`（全局指令）、
 * `projectInstructions`（项目里的 AGENTS.md 等）、`workspace`（工作目录和会话的临时目录）。plume.tools 再加一段 `resources`（资源地址的清单）。
 */
export interface PromptSection {
	/** 段的名字，插件按它替换、删除，或把自己的段插在它前后。插件自己的段用自己的名字。 */
	id: string;
	text: string;
	/**
	 * 这段是什么，宿主按它分段统计（上下文用量的「记忆」、使用统计 Token 构成里的「指令和记忆」），不认段名。`memory` 是插件记下、
	 * 每轮带上的记忆（用户的、项目的都算）。不给的段算系统提示词（plume.prompt、plume.skills 给的几段宿主另按段名认）。
	 */
	category?: "memory";
	/**
	 * 这段里哪几截来自哪个文件：`chars` 是那一截在 `text` 里的字数（连同包着它的标签）。宿主把 `projectInstructions` 段和
	 * `category: "memory"` 的段的来源按文件列进上下文用量的「记忆文件」，这些文件在会话边界外也能在文件面板里只读打开（`path` 给绝对路径）；
	 * 别的段带了不显示。改了 `text` 的层要么跟着改它，要么去掉它。
	 */
	files?: Array<{ path: string; chars: number }>;
}

/**
 * 钩子 model.context 的输入和输出。只作用于这一次请求，会话里存的不变。
 * 本体给的 `sections` 是空的、`messages` 是会话的原样历史（压缩过的是摘要加之后的原文）；系统提示词各段、
 * 消息里的日期和插话、打断说明由内置插件 plume.prompt 在最外层（order -1000）补上，所以其他层拿到的已经是完整的一份。
 * plume.prompt 还把系统提示词按会话冻结：里层交回的段和冻结的那份不一样时，发出去的仍是冻结的那份，改动作为一条增量消息
 * （`UserMessage.promptUpdate`）接在这一轮开头。
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
	/** 这个会话现在的权限模式（含项目覆盖）。Windows 上受约束的命令跑在 PowerShell、完全访问跑在 Git Bash，系统提示词按它点名 shell。 */
	permissionMode: PermissionMode;
	/**
	 * 外层要求这一轮的命令都在只读沙箱里跑（计划模式，和 `ToolExecution.readOnly` 同一件事）。宿主不给；要设就挂在
	 * plume.prompt（order -1000）外面，它按这一档点名 shell：Windows 上只读的命令跑 PowerShell，权限模式是完全访问也一样。
	 */
	readOnly?: boolean;
	/** 设置 › 个性化：语气和全局指令。 */
	personalization: Personalization;
	/** 发出去的系统提示词，就是 `sections` 依次用空行连起来。只读：每层交接时宿主按 `sections` 重拼，改它不作数。 */
	systemPrompt: string;
	/** 系统提示词按段拆开。加、换、删都改这里，交给下一层时宿主把 `systemPrompt` 重新拼。 */
	sections: PromptSection[];
	messages: Message[];
	tools: ToolSpec[];
}

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
	 * 这句话是插件经 `ctx.sessions.launch` 发的（它开出来的会话的第一句），不是人在输入框里发的：人为自己正在写的那条消息
	 * 选的东西（输入框上的开关）不算到它头上。
	 */
	launched: boolean;
	signal: AbortSignal;
}

/**
 * 钩子 prompt.submit 的结论。最里层是 `{ block: false }`。
 * 拦下时这条消息不写进会话、这一轮不跑，`reason` 弹成提示条（给人看的话，按界面语言写）。
 * 放行时可以带 `context`：跟在这条消息后面以用户身份写进会话（标成 synthetic，界面不画成人的消息），模型看得到。
 * 放行时还可以带 `cwd`：这个会话从这一轮起改在这个目录里跑，它的子会话跟着（工作树插件给对话开了自己的检出）。
 * 只对一轮开头那条消息生效，插话、后台回报和子会话的不算；不是已有目录的绝对路径时不换，记日志。
 */
export type PromptVerdict = { block: true; reason: string } | { block: false; context?: string; cwd?: string };

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
	 * 历史上一次被改写（压缩、只剪枝）的时刻：在这之前落定的回复，用量量的是改写前的那份，不能拿来判断现在有多满。
	 * 没改写过不给。
	 */
	rewrittenAt?: number;
	/** 这一次真正要发出去的请求（经过 model.context），量有多满用它。就是要发的那一份，只读，别改。 */
	request: { systemPrompt: string; messages: Message[]; tools: ToolSpec[] };
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

/** `ContextCompact.progress` 的一步。 */
export type CompactionProgress = { phase: "summarizing" } | { phase: "retrying"; delayMs: number } | { phase: "fallback" };

/**
 * 摘要是怎么来的：`fork` 从主请求分叉，`independent` 单独发的摘要请求，`fallback` 两样都没拿到、本地机械整理，
 * `dropped` 连本地整理也放不下、直接丢了最老的几轮。
 */
export type CompactionVia = "fork" | "independent" | "fallback" | "dropped";

/**
 * 一条工具结果发给模型时的样子：结果里的文字块依次换成 `texts`，多出来的文字块去掉，图片原样。会话里存的仍是原文，
 * 卡片照旧画原文。宿主把它记在会话库里，以后每一次发请求都照它发，重开应用也一样：发出去的前缀不变，缓存接得上。
 */
export interface ToolResultView {
	toolCallId: string;
	texts: string[];
}

/**
 * 钩子 context.compact 的结论：不给是不压。最里层不压。
 * 给了 `keep`，`history` 里从 `keep` 起原样留着，之前的（含上一次压缩换上的那几条）换成 `head`。
 * `keep` 要落在上一次换上的那几条之后、最后一条之前，而且不能是工具结果（会和它回答的调用拆开）；`summary`
 * 只在按条丢弃（`via: "dropped"`）时可以是空串；不合规矩的宿主当作压缩失败。
 * `views` 是留下的那截里剪过的工具结果。只剪了工具结果、没有可摘要的（`pruneOnly`）时只给 `views`。
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
	| { pruneOnly: true; views: ToolResultView[] }
	| undefined;

/**
 * 钩子 tool.approve 的输入：一个工具调用要动手了，问要不要放行。工具自己经 `run.ask` 问的（带 diff、命令原文）、
 * 会改动工作区却没写 `asks` 的工具（执行前按参数问）、tool.execute 的层自己问的（`byLayer`）都可能到这里。
 * 最里层照着传进来的 `request` 把审批卡弹给人、等人答。
 *
 * 权限模式的含义在本体，到不了这里：完全访问、tool.execute 外层设了 `approved`、`subject` 答过「以后不再问」的，本体直接放行。
 * 提权（`request.escalation`）和 `request.userOnly` 只能由人答：它们在完全访问下也到这里，层答放行不算数、本体照样弹卡，层答拒绝照算。
 * 内置插件 plume.approval 在这里按帮我批准（`auto`）的风险规则放行；没有任何层时每一次都问人。
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
	/** 这次调用所在项目现在的权限模式。完全访问只有提权和 `userOnly` 会带到这里。 */
	permissionMode: PermissionMode;
	/** 用户停止这一轮时中止。 */
	signal: AbortSignal;
}

/**
 * 钩子 session.rewind 的输入：人撤回或编辑重发，要截掉从某条人发的消息起的那段对话。截断由宿主做，这里问的是那段里
 * 插件记着的改动（文件改动等）能不能、要不要一起退回到截断点之前。
 *
 * 先以 `restore: false` 问一次，只演算：答那段改过哪些文件、各自能不能安全退回，界面据此问人。人选了连文件一起退，宿主在截断
 * 之前以 `restore: true` 再问一次：重新校验、真的写回去；写不回去就抛错（message 原样给人看，按界面语言写），这时宿主不截对话。
 * 写回要全有或全无：一个文件不能安全退回，就一个都不写，已经写了的退回原样再抛错。
 * 只截对话、不动文件时不问。最里层答 `{ files: [], unrecorded: false }`；每一层把自己的结论并进 `next` 的结论里。
 */
export interface SessionRewind {
	sessionId: string;
	/** 要截的会话，见 `SessionScope`。 */
	session: SessionScope;
	cwd: string;
	/** 要截掉的那段：从被撤回、编辑的那条人发的消息起到最后，副本。 */
	messages: Message[];
	/** 真的写回去，还是只演算。 */
	restore: boolean;
}

/** 钩子名 → [输入, 输出]。 */
export interface Hooks {
	"tool.execute": [ToolExecution, ToolOutput];
	"model.context": [ModelContext, ModelContext];
	"step.end": [StepEnd, StepVerdict];
	"prompt.submit": [PromptSubmit, PromptVerdict];
	"context.compact": [ContextCompact, CompactSummary];
	"tool.approve": [ToolApproval, ApprovalDecision];
	"session.rewind": [SessionRewind, RevertPlan];
}

/** 输入框 `/` 菜单里的一条命令。 */
export interface SlashCommand {
	/** 敲在 `/` 后面的名字：小写字母、数字、连字符，可以用 `:` 分段（`git:commit`）。 */
	name: string;
	/** 菜单里名字后面那句说明。 */
	description: string;
	/** 命令后面接什么，还没写参数时以灰字画在输入框里。 */
	argumentHint?: string;
	/** 菜单最右边那一栏：它从哪来（「项目」「个人」）。给人看的话，按界面语言写。 */
	source?: string;
}

/** 列命令、展开命令时的环境。 */
export interface CommandContext {
	/** 下一轮在哪个目录里跑；不属于任何项目的新聊天为空。 */
	cwd?: string;
	/** 输入框所在的会话；还没发出第一条消息的新对话为空。 */
	sessionId?: string;
}

/** 一条命令展开成的消息。 */
export interface CommandExpansion {
	/** 发给模型的话。 */
	text: string;
	/** 对话里画在人的气泡里的字；不给就画 `text`。 */
	displayText?: string;
	/**
	 * 会话正忙时怎么送。`steer`：插进正在跑的这一轮，模型做完手上这一步就读到（「只看 src/」这类纠偏，等这一轮做完再说就晚了）。
	 * 不给就和平常发的话一样排到这一轮后面。会话空闲时都是开新的一轮。
	 */
	deliver?: "steer";
}

/**
 * 命令不发消息、插件自己办完了（`/btw` 把话问到侧边聊天里）：输入框清空，当前对话里什么都不留。
 * 给了 `openPanel` 就打开这个插件自己注册的那个面板；能开好几个标签的面板新开一个标签。
 * 给了 `openSettings` 就打开这个插件自己注册的、单独占设置导航一行（`page: "nav"`）的那节设置（`/commands` 打开命令管理）。
 */
export interface CommandHandled {
	handled: true;
	openPanel?: string;
	openSettings?: string;
}

/** `expand` 的结果：要发的话，或者已经办完了。 */
export type CommandResult = CommandExpansion | CommandHandled;

/**
 * 插件给 `/` 菜单供的命令。宿主每次打开菜单、每次发送命令前都现问一遍，命令文件改了不用重载插件。
 * 几个插件给了同名的命令时，先加载的插件的那条生效。
 */
export interface CommandProvider {
	list(context: CommandContext): SlashCommand[] | Promise<SlashCommand[]>;
	/**
	 * 把 `/name rest` 展开成要发的消息，或者自己办掉它（`CommandHandled`）。`name` 是 `list` 给过的名字，`rest` 是名字后面的原文
	 * （去掉首尾空白）。抛错时不发、输入框里的字留着，message 写在输入框上面（给人看的话，按界面语言写）。
	 */
	expand(name: string, rest: string, context: CommandContext): CommandResult | Promise<CommandResult>;
}

export type HookName = keyof Hooks;

/** 洋葱的一层：调 next 交给里一层，不调就是拦下。 */
export type HookLayer<N extends HookName> = (input: Hooks[N][0], next: (input: Hooks[N][0]) => Promise<Hooks[N][1]>) => Promise<Hooks[N][1]>;

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** 一次性的模型调用：一段系统提示词、一句话，要回一段字。 */
export interface ModelCompletion {
	/** 结果将覆盖持久化内容时要求完整收尾；截断等非正常完成仍计费，但调用拒绝。 */
	requireComplete?: boolean;
	systemPrompt: string;
	/** 交给模型的话，作为最后一条用户消息。 */
	prompt: string;
	/** 在 `prompt` 前面的一段对话（比如要总结的历史）。不给就只有 `prompt` 这一条。 */
	messages?: Message[];
	/** 替这个会话做：用它现在的模型，花销记在它名下。不给用默认模型，花销不归哪个会话。 */
	sessionId?: string;
	/** 指定模型（`SessionModel.id`），优先于 `sessionId` 的模型，花销仍记在 `sessionId` 名下。不在目录里时抛错，不悄悄换成别的模型。 */
	model?: string;
	/** 回复最多多少 token；不给用模型自己的上限。 */
	maxTokens?: number;
	/** 中止时请求跟着断开，调用以中止的原因结束。 */
	signal?: AbortSignal;
	/** 请求出了岔子、等一会儿再试时调（压缩那一行说「等待第 N 次重试」）。 */
	onRetry?(info: { delayMs: number }): void;
	/**
	 * 从 `sessionId` 上一次发出去的主请求分叉：系统提示词、工具表、思考档位、缓存键、输出上限都照那一次原样，`messages`
	 * 要是这个会话下一次要发的历史（`ContextCompact.request.messages`），末尾接上 `prompt`；`systemPrompt` 和 `model` 不用。
	 * 前缀和那一次相同，服务商的缓存照常命中。发出前宿主核对请求体：那一次不是这一次的前缀就不发、抛错；
	 * 没发过主请求、换了模型、回复里调了工具时也抛错。必须给 `sessionId`。
	 */
	fork?: boolean;
}

/** 一个配好的生图模型，不含供应商凭据。 */
export interface ImageModel {
	/** `供应商 id/模型 id`，`ModelImageRequest.model` 传它。 */
	id: string;
	/** 界面上的名字。 */
	name: string;
	/** 发给供应商的模型 id。 */
	modelId: string;
	/** 供应商的名字。 */
	provider: string;
}

/**
 * 找生图模型的结果：找到了就是 `model`；否则 `reason` 说为什么，`candidates` 是可以点名的那些。
 * `none` 一个生图模型都没配；`unknown` 点的名字对不上；`ambiguous` 对上了好几个。
 */
export type ImageModelMatch = { model: ImageModel } | { model?: undefined; reason: "none" | "unknown" | "ambiguous"; candidates: ImageModel[] };

/** 交给生图模型的一张图：要改的，或者照着画的。 */
export interface ImageInput {
	/** base64，不带 `data:` 前缀。 */
	data: string;
	mimeType: string;
	/** 上传时的文件名；有的端点不给名字就拒收。 */
	name?: string;
}

/** 画一次图或改一次图。 */
export interface ModelImageRequest {
	/** 用哪个生图模型（`ImageModel.id`），先经 `findImageModel` 找到。 */
	model: string;
	prompt: string;
	/** 有图就是改图：提示词说的是这些图。 */
	images?: ImageInput[];
	/** `"16:9"` 这类；不给由模型定（改图时多半照原图的形状）。 */
	aspectRatio?: string;
	/** `max` 是模型给得出的最大一档（支持的话是 4K），慢、也贵。 */
	quality?: "low" | "medium" | "high" | "max";
	/** 画几张，1–4。 */
	count?: number;
	background?: "transparent" | "opaque";
	/** 中止时请求跟着断开，调用以中止的原因结束（抛错）。 */
	signal?: AbortSignal;
	/** 要重试了：第几次、等多久、为什么。等完了不另外通知。 */
	onRetry?: (retry: { attempt: number; delayMs: number; reason: string }) => void;
}

/** 生图失败的原因。`hint` 是 `check-billing`（额度用完）、`check-key`（这个 key 不让用这个模型）、`blocked`（内容被拒）时，人要去做点什么。 */
export interface ImageFailure {
	summary: string;
	detail?: string;
	hint?: string;
	/** 额度什么时候恢复，服务商说了的话。 */
	retryAfterMs?: number;
}

/** 画出来的图，或者为什么没画出来。 */
export type ModelImageResult =
	| {
			ok: true;
			/** 按图片本身的字节认的类型，宽高从图片头读；读不出来时没有宽高。 */
			images: { data: string; mimeType: string; width?: number; height?: number }[];
			/** 服务商改写了提示词时，它说自己照着画的那段。 */
			revisedPrompt?: string;
			/** 走的是 Images API 还是 chat completions。 */
			route: "images" | "chat";
			/** 画几张只到了一部分时，没到的那几张为什么没到。 */
			failures?: string[];
	  }
	| { ok: false; failure: ImageFailure };

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

/**
 * 会话的媒体目录：会话里的图片挪出消息后按内容（sha1）存在这里，消息里只留名字（`ImageContent.media`）。
 * 存进去的名字和会话存图时起的一样，同一张图不会存两份。
 */
export interface MediaAccess {
	/** 存一张图，交回名字和磁盘上的绝对路径。只认 PNG、JPEG、WebP、GIF、BMP，别的抛错。 */
	save(image: { data: string; mimeType: string }): Promise<{ name: string; path: string }>;
	/** 按名字读回一张图；名字不是这个目录的、文件不在时是 null。 */
	read(name: string): Promise<{ data: string; mimeType: string } | null>;
	/** 一个绝对路径是不是这个目录里的图：是的话交回名字，不是是 null。 */
	nameOf(path: string): string | null;
}

/** 插件在自己的子会话中发送的内容；parent 表示派发方交代的任务，不是用户插话。 */
export type SessionMessage = Omit<OutgoingMessage, "interrupt" | "synthetic"> & { origin?: "parent" };

/** 一次后台运行的句柄。续跑同一子会话时 id 不同，结果只能送达一次。 */
export interface SessionRun {
	id: string;
	sessionId: string;
}

/** `SessionManager.report` 的选项。 */
export interface ReportOptions {
	/** 和本插件同一次送达里别的几份合成一段，见 `ReportFrame`。 */
	frame?: ReportFrame;
	/** 给界面把这份结果画成对话里的一行（「消息来自 @explore」），不是一个人发的气泡，见 `DeliveryInput`。不给就只有模型看得到。 */
	delivery?: DeliveryInput;
}

/**
 * `ReportOptions.frame`。几份结果落在同一次送达里时，同一个插件带 `frame` 的合成一段：`head` 写一次，
 * 接着各份的正文，最后是最后一份的 `tail()`——父会话读到的是「这几份到了、接下来怎么用」，不是每份各说一遍。
 */
export interface ReportFrame {
	head: string;
	/** 真要送出那一刻才取：那时还在等谁、是不是都回来了，到那一刻才定。返回 undefined 就不写。 */
	tail?(): string | undefined;
}

/** 可供子会话选择的模型，不含供应商凭据。 */
export interface SessionModel {
	id: string;
	name: string;
	contextWindow: number;
	thinking: ThinkingOption[];
}

/** `SessionAccess.compact` 压完的结果，`code` 同 `CompactionRun.code`。 */
export type CompactionOutcome = { ok: true; before: number; after: number } | { ok: false; code: Exclude<CompactionCode, "done">; error?: string };

/** `SessionAccess.launch` 开新会话要的东西。 */
export interface SessionLaunch {
	/** 开在哪个已登记的项目里（项目 id），工作目录是项目的目录。和 `cwd` 都不给时是不属于任何项目的聊天。 */
	project?: string;
	/** 不在项目里时的工作目录：已有目录的绝对路径。给了 `project` 时不看它。 */
	cwd?: string;
	/** 第一句话：照常经 `prompt.submit`，画成人的气泡，标题默认取它的开头。 */
	message: string;
	/** 用哪个模型（`SessionModel.id`）；不给用默认模型。不在目录里时抛错，不悄悄换成别的。 */
	model?: string;
	/** 思考档位；不给用设置里的默认推理强度。不认识的档位抛错；模型没有这一档时，跑的时候就近落到它有的那一档（和输入框里选的一样）。 */
	thinking?: ThinkingLevel;
	/**
	 * 从哪个会话开出来的，记进新会话摘要的 `spawnedFrom`；那个会话要在、不能是子会话。不给就不记。
	 * 要经 `reportBack` 交回时，`toolCallId` 得是本插件注册的工具在那个会话里的一次调用（提出开新会话的那次）。
	 */
	spawnedFrom?: { sessionId: string; toolCallId?: string };
	/** 标题；不给就取第一句话的开头。 */
	title?: string;
}

/** `SessionAccess.launch` 开出来的会话。 */
export interface LaunchedSession {
	session: SessionSummary;
	/** 第一轮结束时给出它为什么结束。 */
	done: Promise<TurnStop>;
	/** 它第一次真闲下来时兑现，见 `SessionAccess.launch`；带上那时的收场和最后一段回复，交回用它。 */
	idle: Promise<LaunchedIdle>;
	/**
	 * 把它做出来的结果交回开出它的那个会话（`spawnedFrom`），只能交一次：`text` 是写给模型的话，作为一条运行时送达写进那个会话
	 * （前面带着「不是用户说的话」的抬头）；`delivery` 是对话里那一行（见 `DeliveryInput`），宿主给它填上这个会话的 id
	 * （`DeliveredReport.sessionId`），默认画成「来自新会话 · 标题」，点了到这个会话。
	 * 那个会话闲着（人按停过也算，这是一件新的事）就为它开一轮，忙着在两步之间读到。
	 * 没有 `spawnedFrom`、那个会话删了或归档了、已经交过、正在退出时不送，返回 false。
	 * `spawnedFrom.toolCallId` 不是本插件的工具在那个会话里的一次调用（或撤回时被截掉了）、插件已经停用时抛错。
	 */
	reportBack(text: string, delivery: DeliveryInput): boolean;
}

/** `LaunchedSession.idle` 兑现时的样子。 */
export interface LaunchedIdle {
	/** 最近一轮怎么收场的（第一轮之后还有被唤起的几轮时，是最后那一轮）；会话这期间被删掉时不给。 */
	stop?: TurnStop;
	/** 最后一段有字的回复，没有时是空串。 */
	reply: string;
}

/** 会话为什么不再活着：删掉了、归档了、换到别的项目（工作目录变了）、退出应用。 */
export type SessionEndReason = "deleted" | "archived" | "moved" | "quit";

/**
 * 子会话复用产品的循环、审批、存储和事件，插件只能运行自己拥有的会话。
 * 不开放任意向用户会话发送消息的能力：插件够得着的会话都从宿主给的句柄来，目标不由插件随手填。
 * - 新开的会话：`launch` 开一个新的顶层会话、发出第一句话，之后它就是人的会话，插件不能再往里发；
 * - 开出它的那个会话：`LaunchedSession.reportBack` 交回一次，来处要是本插件的工具在那里的一次调用；
 * - 调用所在的会话：`ToolRun.background` 送后台结果、`ToolRun.archiveAfterTurn` 收尾后归档；
 * - 子会话的父会话：插件自己建的子会话里，它注册的工具的那次调用拿得到 `ToolRun.parent`（排活、停下、接着做），
 *   人在子会话的卡片上点的 `ToolCardProps.handToParent` 同样只到父会话；
 * - 别的顶层会话：只经那次调用的 `ToolRun.letter` 寄信，发件方由本体照实填；
 * - 自己的子会话：`report` 把后台运行的结果交给它的父会话。
 * 写进去的话都标着运行时来处，不当成人的授权；`ToolRun` 上的句柄调用答完就失效。
 * 身份和工具限制由插件经 model.context、tool.execute 管理。
 */
export interface SessionAccess {
	/** 只读观察请求、工具开始、审批、重试和运行状态；副本不含配置密钥，停用时自动撤下。 */
	observe(listener: (observation: SessionObservation) => void): void;
	/** 全部会话的摘要（含归档的、子会话），最近活动的在前。只为找一个会话时用 `get`。 */
	list(): Promise<SessionSummary[]>;
	/** 一个会话的摘要；没有这个会话（删掉了、id 不对）时是 undefined。给钩子之外拿不到 `SessionScope` 的地方（`serve` 的方法、事件回调）用。 */
	get(sessionId: string): Promise<SessionSummary | undefined>;
	/** 一个会话存下的全部消息，是会话里的原文，不受压缩影响。没有这个会话时抛错。 */
	messages(sessionId: string): Promise<Message[]>;
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
	 * 开一个新会话并发出第一句话（定时任务到点了、人在插件界面上点了「在新会话里执行」）。新会话和人在侧栏新建的一样：
	 * 进侧栏、不记在插件名下（没有 `owner`），人能接着聊，插件之后不能再往里发、也停不了删不了它。第一句话照常经
	 * `prompt.submit`，可能被拦下（这一轮按完成收场）。只能开新的；对已有会话只有 `reportBack` 往开出它的那个会话交回一次。
	 * 建好就返回：`session` 是新会话的摘要，`done` 在这第一轮结束时给出它为什么结束（之后人接着聊的几轮不算）。
	 * `idle` 在它第一次真闲下来时兑现：第一轮结束，它派出去的后台运行都回来了、送回的结果唤起的几轮也做完了，它经 `ToolRun.letter`
	 * 问出去的请求（`request: true`）也都有了答复、答复唤起的几轮也做完了。请求有了答复：经回执的 `answer` 回了信，或对方读到以后
	 * 寄回一封带 `answer` 的信（答掉它读到的全部）；对方删掉、寄信的插件停用了也不再等。
	 * 项目、目录、模型、思考档位、`spawnedFrom` 不对时抛错，message 是给人看的话（按界面语言）。
	 */
	launch(options: SessionLaunch): Promise<LaunchedSession>;
	/** 可用模型目录，只含名称、窗口和思考档位。 */
	models(): Promise<SessionModel[]>;
	/** 开始自己的子会话的一轮，立即交回句柄；首次运行固定实际模型与思考档位，续跑沿用。父轮正常结束不取消，明确停止父会话则取消。 */
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
	/** 停下自己子会话正在跑的那一轮；没在跑什么都不做。 */
	stop(sessionId: string): void;
	/** 删掉自己建的子会话（和它下面的子会话）；正在跑的先停下。 */
	delete(sessionId: string): Promise<void>;
}

/** 网页此刻的样子，见 `WebPages`。 */
export interface WebPageState {
	/** 主框架此刻的地址；第一页还没提交时是空串。 */
	url: string;
	title: string;
	/** 还在加载（主框架或子框架）。 */
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	/** 页面进程没了（崩溃、内存不够被系统杀掉），还没重新加载。 */
	crashed: boolean;
	/** 缩放倍数。 */
	zoom: number;
}

/** 网页上发生的事。每条都带着页面 id 和那一刻的 `state`。 */
export type WebPageEvent = { page: string; state: WebPageState } &
	/** `attach` 认下了这一页，从这时起能驱动它；认下之前它已经报过的事（被拦下的跳转之类）紧跟着补报。 */
	(
		| { type: "attached" }
		/** 页面没了：`<webview>` 卸掉、标签关掉、窗口关掉。之后的调用报错，直到再 `attach`。 */
		| { type: "detached" }
		/** 主框架开始换一张文档（页内跳转不算）。 */
		| { type: "navigation"; url: string }
		/** 这张文档能读了（DOM 建好，资源可能还在加载）。 */
		| { type: "dom-ready" }
		/** 开始、停止加载。 */
		| { type: "loading"; loading: boolean }
		/** 主框架换到了这一页；`inPage` 是页内跳转（锚点、`history.pushState`）。 */
		| { type: "navigated"; url: string; inPage: boolean }
		| { type: "title"; title: string }
		/** 主框架没加载出来（被取消的不算）。`description` 是 Chromium 的错误名，如 `ERR_NAME_NOT_RESOLVED`。 */
		| { type: "failed"; url: string; code: number; description: string }
		/** 页面进程没了，`reason` 是 Electron 给的原因（`crashed`、`oom`、`killed`……）。宿主不自动重新加载。 */
		| { type: "gone"; reason: string }
		/**
		 * 宿主拦下了主框架去非网页地址的一次跳转（`lark://` 这类唤起客户端的）：网页只能是 http、https 和 about:blank。
		 * `redirect` 是服务器重定向过去的，不是页面自己跳的。
		 */
		| { type: "blocked"; url: string; redirect: boolean }
		/**
		 * 页面要开新窗口（`window.open`、`target=_blank`）：宿主不开，交给插件决定。`window` 是脚本按尺寸开的小窗（第三方登录、
		 * 支付）：宿主已经把它开成挂在 Plume 窗口上的小窗口，和开它的页面连着（登录完经 `window.opener` 交回结果、自己关掉），
		 * 插件不用再开；它给人用，插件驱动不了。
		 */
		| { type: "popup"; url: string; window?: true }
		/**
		 * 宿主照 `answerDialogs` 替人答了页面的一个对话框。`beforeunload` 是离开页面的提示，没有文字；答 false 时留在原页，
		 * 等着换页的那一方等不到新文档。
		 */
		| { type: "dialog"; dialog: "alert" | "confirm" | "beforeunload"; message: string; accepted: boolean }
	);

/** 发给网页的一次原生输入，坐标是页面视口里的 CSS 像素乘上缩放。 */
export type WebInputEvent =
	| { type: "mouseMove" | "mouseDown" | "mouseUp"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number }
	| { type: "mouseWheel"; x: number; y: number; deltaX: number; deltaY: number }
	/** `keyCode` 是 Electron accelerator 的键名（`Enter`、`Tab`、`Up`、`a`）。 */
	| { type: "keyDown" | "keyUp" | "char"; keyCode: string; modifiers?: ("shift" | "control" | "alt" | "meta")[] };

/** 隐藏页面检查结果；截图宽高和起点均为 CSS 像素。 */
export interface WebInspection {
	exceptions: string[];
	errors: string[];
	width: number;
	height: number;
	shotTop?: number;
	shotHeight?: number;
	screenshot?: { data: string; mimeType: "image/png" };
}

/** 从本机 Chrome 同步登录状态的现状，见 `WebPages.chromeLogins`。 */
export interface ChromeLoginSync {
	/** 开着：应用启动时同步一次，之后 Chrome 的 cookie 一变就跟着同步。 */
	enabled: boolean;
	/**
	 * 同步不了的原因：`unsupported` 这个系统还不支持（目前只有 macOS），`no-chrome` 没找到 Chrome 的数据，
	 * `no-access` 系统不让读（macOS 要在「隐私与安全性 › 完全磁盘访问权限」里给 Plume），`keychain-denied` 钥匙串里的 Chrome 密钥没拿到，
	 * `failed` 别的原因（`detail` 里是给人看的说明）。
	 */
	problem?: "unsupported" | "no-chrome" | "no-access" | "keychain-denied" | "failed";
	detail?: string;
	/** 从哪个 Chrome 用户同步（Chrome 里显示的名字）。 */
	profile?: string;
	/** 上次同步时 Chrome 里有多少条能用的 cookie。 */
	cookies?: number;
	/** 上次成功同步的时间（毫秒）。 */
	syncedAt?: number;
}

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

/** 逻辑入口的 HTTP 请求；桌面版使用系统代理，不共享浏览器 cookie，不跟随重定向。 */
export type PluginFetch = (url: string, init?: RequestInit) => Promise<Response>;

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
	readonly log: Logger;
	/** 插件自己调一次模型、画图、读花销，见 `ModelAccess`。 */
	readonly model: ModelAccess;
	/** 读写会话的媒体目录，见 `MediaAccess`。 */
	readonly media: MediaAccess;
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

/**
 * 插件包是哪一类（`package.json` 的 `plume.kind`），决定它在「插件市场」页的哪个分类里：普通插件；技能合集（只带 `skills/`）；
 * 连接器（只带 `.mcp.json` 里的 MCP 服务）。装法、更新、卸载都一样。没写是普通插件。
 */
export type PluginKind = "plugin" | "skill" | "connector";

/**
 * 插件 `package.json` 里给市场看的说明，`@plumeai/plugin-sdk/manifest` 的 `readManifest` 读出的样子；市场目录 `marketplace.json`
 * 的一条照抄一份（加上目录名 `name`）。没写或类型不对的字段不出现。
 */
export interface PluginManifest {
	kind: PluginKind;
	/** 显示名，`plume.displayName`。 */
	displayName?: string;
	description?: string;
	/** 市场按它判断更新：x.y.z，发出去以后不可变。 */
	version?: string;
	author?: string;
	/** 货架，`plume.category`。 */
	category?: string;
	keywords?: string[];
	homepage?: string;
	license?: string;
	/** 详情页「试试这样问」，`plume.defaultPrompt`。 */
	prompts?: string[];
	/** 技能合集带几个技能：不在 `package.json` 里，发市场时数 `skills/` 下的目录写进市场目录，只有 `readCatalogInfo` 读得到。 */
	skills?: number;
}

/** 一个启用着的插件。 */
export interface InstalledPlugin {
	name: string;
	/** 插件目录：`package.json`、`README.md`、`dist/` 和随包的 `skills/` 在这里。 */
	dir: string;
	/** 随应用发的插件。 */
	builtin: boolean;
}

/**
 * 服务名 → 服务的接口。服务是一个插件开给别的插件用的一组方法：提供的插件经 `ctx.provide` 给出实现，用的插件把
 * 服务名写进 `Plugin.inject`、经 `ctx.use` 拿到。依赖的是名字，不是某个插件，所以谁提供都行，能整个换掉。
 * 仓库外的插件给自己的服务用声明合并加一项：`declare module "@plume/contract" { interface Services { … } }`。
 */
export interface Services {
	/** 与内置文件工具共用读取授权、项目根和会话批准记录。 */
	"file.read": {
		authorize(run: ToolRun, path: string): Promise<{ ok: true; absolute: string } | { ok: false; message: string }>;
	};
	"background.jobs": BackgroundJobsService;
	"session.wakeups": SessionWakeupsService;
	sandbox: SandboxService;
	"file.changes": FileChangesService;
	"project.files": ProjectFilesService;
	resources: ResourcesService;
	"session.worktree": SessionWorktreeService;
	secrets: SecretsService;
}

/**
 * 服务 `secrets`：把插件要存的密钥（令牌、密码、请求头里的凭据）加密成一段文本，插件把它写回自己的配置文件。
 * 内置插件 plume.secrets 提供：AES-256-GCM，钥匙在它的数据目录。
 *
 * 只管加解密，不替插件存：密文跟着它所属的那条配置走，删掉配置就是删掉密钥，不用另外清。
 * 挡的是配置文件被同步、拷走、贴进问题报告时带出明文；挡不住同一台机器上同一个用户的程序——插件都跑在同一个进程里，
 * 谁拿到服务都解得开谁的密文。
 */
export interface SecretsService {
	/** 加密一个值，返回带固定前缀的文本（`isSealed` 认得出），能放进 JSON 之类的任何文本里。 */
	seal(value: string): Promise<string>;
	/**
	 * 解回来。不是 `seal` 出来的、或者这把钥匙打不开（钥匙丢了换了新的、密文来自别的机器）时是 null，当成「要重新填」。
	 * 钥匙文件在却读不出来时抛错：这时不能当成「没了」，否则调用方把空值写回去，等钥匙又读得出来时已经没东西可解了。
	 */
	unseal(sealed: string): Promise<string | null>;
	/** 这段文本是不是 `seal` 出来的样子：手写进配置的明文和密文分得开。 */
	isSealed(value: string): boolean;
}

/**
 * 服务 `session.worktree`：让开出来的新会话在它自己的 git 工作树和分支里跑，不动项目的检出。内置插件 plume.git 提供。
 * 建、收回、合并回去都归提供方；用的一方只说要不要。
 */
export interface SessionWorktreeService {
	/** 这个目录在不在 git 仓库里：在才开得出工作树。 */
	available(cwd: string): Promise<boolean>;
	/**
	 * 从这次工具调用开出来的会话（`SessionLaunch.spawnedFrom` 里的 `sessionId`、`toolCallId`）要自己的工作树：它第一轮开始时开一棵，
	 * 登记只用这一次。先登记再 `ctx.sessions.launch`；返回的函数撤销登记，只在 `launch` 抛错时调（开出来以后登记由第一轮取走）。
	 */
	requestFor(origin: { sessionId: string; toolCallId: string }): () => void;
}

/** 服务 `project.files`：项目里该看哪些文件。内置插件 plume.tools 提供，它的 glob、grep 用的也是这一份。 */
export interface ProjectFilesService {
	/**
	 * `root` 之下 git 认为该看的文件（已跟踪且还在磁盘上的，加上未跟踪且没被忽略的），绝对路径，以 `root` 开头。
	 * 不在 git 仓库里、或 git 答不上来时是 null，由调用方自己走目录。问 git 时不执行仓库能控制的程序（`core.fsmonitor`、过滤器、钩子）。
	 */
	list(root: string): Promise<string[] | null>;
}

/** 沙箱的模式：只读、能写项目目录、不设限。 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** 一条已经启动的命令。 */
export interface SandboxProcess {
	readonly pid?: number;
	/** stdout 和 stderr 按到达顺序交错，和 shell 显示的一样。 */
	onOutput(listener: (chunk: string) => void): void;
	/**
	 * 命令结束了。`code` 是 null 时 `signal` 说是什么杀了它。
	 * `lingering`：命令退出了，但它自己起的进程还拿着它的输出（没重定向的 `server &`），经这个句柄还能读、能停。
	 */
	onExit(listener: (code: number | null, signal?: string | null, lingering?: SandboxProcess) => void): void;
	/** 命令根本没能启动。之后不再报退出。 */
	onError(listener: (error: Error) => void): void;
	/** 连它起的子进程一起停。 */
	kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

/** 服务 `sandbox`：在沙箱里跑 shell 命令。内置插件 plume.sandbox 提供（macOS 用 seatbelt，Windows 用受限令牌；Linux 没有后端）。 */
export interface SandboxService {
	/**
	 * 用用户的 shell 起一条命令，环境向登录 shell 要（从图标启动时也找得到用户装的工具）。`mode` 不给就不进沙箱；
	 * 给了而这台机器给不了那样的沙箱时抛错。
	 *
	 * `shellMode` 是按哪一档选 shell：会话宣布的模式，系统提示词里告诉模型的 shell 就是按它选的；不给时按 `mode`。
	 * 只在 Windows 上有区别（受约束的跑 PowerShell，完全访问跑 Git Bash）：提权的命令传更宽的 `mode` 和原来的 `shellMode`，
	 * 它仍是照被告知的那个 shell 写的。
	 */
	run(command: string, options: { cwd: string; mode?: SandboxMode; shellMode?: SandboxMode; env?: Record<string, string> }): SandboxProcess;
	/** 这段输出像不像被沙箱拒了（只读的文件系统、没有权限）：像的话模型可以申请提权重试。 */
	looksDenied(output: string): boolean;
}

/** 逻辑入口 `dist/index.mjs` 的默认导出。 */
export interface Plugin {
	name: string;
	/**
	 * 要用的服务。都有插件提供了才调 apply，缺的时候插件处于「等待」状态，补上了自动加载；
	 * 提供方换了或停了，插件先停用，再按现在的提供方重新加载（缺了就回到等待）。
	 */
	inject?: readonly (keyof Services)[];
	apply(ctx: PluginContext): void | Promise<void>;
}
