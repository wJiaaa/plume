/**
 * 插件界面入口 `dist/ui.mjs` 用的类型。界面入口跑在渲染进程，按 props 画；要 agent 进程里的东西，只能经 `remote()` 调自己的逻辑入口。
 */

import type { Remote } from "@plume/rpc";
import type { ComponentType, MouseEvent, ReactNode } from "react";
import type { ChangeHunk } from "./changes.ts";
import type { Locale, SlashCommand, ToolCall, ToolOutput } from "./plugin.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	ContextBreakdown,
	FileContents,
	OutgoingMessage,
	PermissionMode,
	SessionSummary,
	SessionTarget,
	SessionView,
	ThinkingLevel,
} from "./service.ts";
import type { AssistantMessage, DeliveredReport, UserMessage } from "@plume/llm/types";

export type { Remote, SessionView, ToolCall, ToolOutput };

/** 回复正文中的围栏代码块；语法与内容由插件校验，宿主不执行其中的代码。 */
export interface CodeBlockProps {
	language: string;
	code: string;
	sessionId: string;
	/** 消息在此会话里的展示标识，不是数据库记录 id。 */
	messageId: string;
	/** 消息内的正文段及代码块位置。 */
	blockId: string;
	/** 消息仍在生成或平滑显示尚未结束。 */
	streaming: boolean;
	/** 原始围栏已闭合且消息成功完成；中断、截断不算完成。 */
	complete: boolean;
	fallback: ReactNode;
	/** 只在真实点击或表单提交事件中同步调用；发送到此块所属会话。只读视图和未完成块没有此入口。 */
	send?: (text: string, event: import("react").SyntheticEvent) => Promise<void>;
}

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
	 * 卡片画在插件的子会话（侧边聊天）里时才有：把一件事排进它父会话的队列，标着来自侧边聊天，和
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

/** 内置工具里做同一类事的那个，见 `ToolLine.like`。 */
export type ToolLike = "read" | "grep" | "edit" | "write" | "bash";

/** `ui.toolLine`：转录里怎么说一个工具。 */
export interface ToolLine {
	/**
	 * 做的事，一个动词短语（「查找符号」）。一次调用说成「动作 对象」（「查找符号 runAgent」），一段活里几次合在一起数个数
	 * （「查找符号 3 个」）。
	 */
	verb: LocalizedText;
	/** 这一次要点名的对象，从参数里取；参数是模型给的、没校验过，取不出就返回 undefined，只说动作。 */
	subject?(args: Record<string, unknown>): string | undefined;
	/**
	 * 做的事像哪个内置工具：和它归成一类（读、搜索归「探索」，改、写归「改文件」，`bash` 归「跑命令」），连着做时并进同一段活；
	 * 运行行用同一种说法；没给 `icon` 时用它的图标。不给就自成一类：只有连着调这个工具才合成一段，图标是终端那枚。
	 */
	like?: ToolLike;
	/**
	 * 归哪一类活，名字插件自己起（`"browser"`）：同一类的几个工具连着做时合成一段，和读、跑命令、改文件那几类也接成一段——
	 * 边改边在页面上验是一件事。给了就不按 `like` 归类，`like` 照旧管运行行和图标。
	 */
	group?: string;
	/** 几次合在一起时数次数，不数个数：「操作网页 4 次」，不是读着像四张网页的「操作网页 4 个」。 */
	times?: true;
	/**
	 * `verb` 只说这一次调用（跑着时那一行、展开后的那一行）；一段活收起后合在一起说时，照没登记说法的工具说「使用工具」。
	 * 给不算一件活、只是收尾手续的工具用（子智能体交结果的 `yield`）。
	 */
	callOnly?: true;
	/** 行首的图标，13px，颜色跟着文字走（currentColor）。 */
	icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
}

export interface PanelProps {
	/** 标签归属会话的只读视图，随事件更新；不跟随窗口焦点。子会话面板保留 owner 语义；新对话尚无会话时为空。 */
	session?: SessionView;
	/**
	 * 标签归属会话下一轮的工作目录；子会话面板沿用 owner 的目录语义。还没发消息的新对话是选中项目的目录，不属于项目的聊天为空。
	 * 后台标签仍收到自己的目录，不使用窗口当前聚焦会话的目录。
	 */
	cwd?: string;
	/**
	 * 这个面板所在标签的 id，标签关掉之前不变。能开好几个的面板用它分开各自的东西（终端：连的是哪个 shell）。
	 * 组件卸掉不等于标签关了：未设 keepAlive 时换会话、去设置页可能卸掉，回来再挂上同一个 id。
	 */
	tab: string;
	/**
	 * 标签归属会话正在显示、面板区已展开，而且它是当前标签。后台标签和收起的面板区看不见，
	 * 定时去网络上取东西之类只为了给人看的事，看不见时停下。
	 */
	shown: boolean;
	/** 改标签上的字，不给回到面板名。能开好几个的面板靠它让几个标签分得出谁是谁。 */
	setTitle(title: string | undefined): void;
	/**
	 * 人点标签上的 ✕ 时先调它：返回 false 就不关，关了的标签不会再回来，它自己的东西（终端的 shell）在这里收掉。
	 * 后设的替换先设的，返回的函数撤掉。没设就直接关。
	 */
	onClose(handler: () => boolean | Promise<boolean>): () => void;
}

/** `ui.listCommands` 列出的一条命令。`plugin` 是供它的插件名，产品自己的命令没有。 */
export interface ListedCommand extends SlashCommand {
	plugin?: string;
}

export interface PageProps {
	/** 当前打开的会话；还没打开会话时为空。只读，随会话的事件更新。 */
	session?: SessionView;
	/**
	 * 当前工作区：打开着会话时是它的项目和工作目录（可能是工作树），没打开会话时是空白页选着的项目或目录；
	 * 哪个都没选时为空。项目的目录按 `project` 在 `ui.useProjects()` 里查。
	 */
	workspace?: SessionTarget;
}

export interface PageOptions {
	/** 页面的名字：侧栏里那一行的字。 */
	title: LocalizedText;
	/** 侧栏那一行的图标，颜色跟着文字走（currentColor）；不给用产品的默认图标。 */
	icon?: ComponentType<{ size?: number; className?: string }>;
	order?: number;
	/**
	 * 页面自己画窗口顶行，默认 false。
	 *
	 * 平时宿主在页面上方留一行和标题栏一样高的空白（窗口的拖动区域）。两栏的页面（左边列表、右边详情）这样排，
	 * 分隔线从这一行下面才开始，悬在半空；盖满整页的一层也只能从它下面开始。设成 true 以后宿主不留这一行，页面从
	 * 正文卡片的顶边开始，每一栏最上面放一个 `@plume/ui` 的 `PageTopRow`（高度、拖动、给红绿灯让位都在里面）。
	 * 宿主在页面外层给 `--plume-top-row-height`（顶行高）和 `--plume-top-row-inset`（侧栏收起时左边要让出的宽度）。
	 */
	topRow?: boolean;
}

/**
 * 皮肤能改的 token，对应 @plume/styles theme.css 里的 `--plume-<名字>`；theme.css 加减 token 时同步这里。
 *
 * 前四个是种子：背景、前景、强调色、对比度（0–1，默认 0.6）。其余的面、线、字都由种子推出来，
 * 皮肤通常只改种子；推出来的哪一档不满意，再单独覆盖那一档。
 */
export type SkinToken =
	| "bg"
	| "fg"
	| "accent"
	| "contrast"
	| "shell"
	| "root"
	| "root-image"
	| "accent-dim"
	| "sidebar"
	| "card"
	| "card-hover"
	| "elevated"
	| "input"
	| "float"
	| "knob"
	| "shade"
	| "window-tint"
	| "line"
	| "line-soft"
	| "line-float"
	| "ink"
	| "ink-muted"
	| "ink-faint"
	| "ok"
	| "danger"
	| "warning"
	| "violet"
	| "chart-2"
	| "chart-3"
	| "chart-4"
	| "chart-5"
	| "chart-6"
	| "on-accent"
	| "code-bg"
	| "code-fg"
	| "code-line-height"
	| "code-tracking"
	| "inline-code-bg"
	| "inline-code-fg"
	| "inline-code-ring"
	| "syntax-operator"
	| "diff-add"
	| "diff-remove"
	| "syntax-keyword"
	| "syntax-string"
	| "syntax-number"
	| "syntax-comment"
	| "syntax-function"
	| "syntax-type"
	| "syntax-variable"
	| "syntax-punctuation"
	| "syntax-tag"
	| "syntax-attribute"
	| "radius-panel"
	| "radius-field"
	| "radius-item"
	| "radius-menu"
	| "font-sans"
	| "font-mono"
	| "ui-size"
	| "code-size";

/**
 * 插件给产品显示的一段字：固定的字符串，或者按当前界面语言给出的函数。
 * 用函数而不是每种语言一份，界面加一种语言时插件的写法不用变；没翻译的语言由插件自己决定退回哪一种。
 */
export type LocalizedText = string | ((locale: Locale) => string);

/**
 * 回复里的网址、文件签还能用什么打开（内置浏览器），见 `UiContext.linkOpener`。
 * 宿主只在人点了的那一刻调 `open`；开在哪、开成什么样由插件定。
 */
export interface LinkOpener {
	/** 网址右键菜单里那一行、文件签悬停按钮的字。 */
	label: LocalizedText;
	/** 那一行、那个按钮的图标，颜色跟着文字走（currentColor）。 */
	icon?: ComponentType<{ size?: number; className?: string }>;
	/** 开得了网址（http、https）：回复里网址的右键菜单多这一行。 */
	web?: boolean;
	/** 点网址时由它开，不交给系统浏览器（人在插件设置里选的）；Shift 点照旧交给系统浏览器。点的那一刻同步问。 */
	takesClicks?(): boolean;
	/** 开得了这个本机文件（绝对路径）：文件签悬停时多一个按钮，点签本身照旧在文件面板里打开。画的时候同步问，别做耗时的事。 */
	file?(path: string): boolean;
	/** 开它。`sessionId` 是链接所在的会话；新对话里为空。 */
	open(target: { url: string } | { path: string }, sessionId: string | undefined): void | Promise<void>;
}

/**
 * 排队条上一条消息「更多」菜单里多的一项（在侧边聊天中打开），见 `UiContext.queueAction`。
 * 宿主只在人点了那一项时调 `run`，调之前已经把这条从排队里拿掉；拿到别处去发由插件定。
 */
export interface QueueAction {
	/** 菜单里那一行的字。 */
	label: LocalizedText;
	/** 那一行的图标，颜色跟着文字走（currentColor）。 */
	icon?: ComponentType<{ size?: number; className?: string }>;
	/** `message` 是排着的那条，和直接发出去的一样（正文、附件、气泡上的字）；`sessionId` 是它排在哪个会话。抛错时弹提示，这条不放回排队。 */
	run(message: OutgoingMessage, sessionId: string): void | Promise<void>;
}

export interface PanelOptions {
	/** 面板的名字：开始页卡片的标题、标签上的字。 */
	title: LocalizedText;
	/** 卡片上标题下面的一句说明。 */
	description?: LocalizedText;
	/** 卡片和标签上的图标，颜色跟着文字走（currentColor）；不给用产品的默认图标。 */
	icon?: ComponentType<{ size?: number; className?: string }>;
	/**
	 * 打开这个面板的快捷键，Electron accelerator 的写法（`Control+\``、`CommandOrControl+Shift+P`），卡片上会显示它。
	 * 作用于当前会话：面板区没开或在看别的就切到它（没开着就新开一个标签），正在看它就收起。和别的面板重了归后注册的，它撤下后还给前一个；Plume 自己的快捷键（⌘B、后退前进、Esc）和它自己面板的快捷键拿不走。
	 */
	shortcut?: string;
	order?: number;
	/** 同一会话能不能开好几个标签（终端：一个标签一个 shell）。默认每会话只开一个；不同会话的标签分别保留。 */
	multiple?: boolean;
	/** 只从卡片打开的辅助面板设为 false，不在面板开始页列出；仍可经 openPanel 打开。默认 true。 */
	listed?: boolean;
	/** 可在重启后恢复标签。默认 false；声明后插件须按 tab 恢复自己的数据，不能只留在组件内存里。 */
	restore?: boolean;
	/** 可弹出到独立窗口。默认 false；声明后须能在另一渲染进程按 tab 接回数据，卸载不能销毁资源。 */
	detachable?: boolean;
	/**
	 * 标签一直挂着，直到关掉：换会话、去设置页都不卸掉组件，只是藏起来。给卸掉就丢东西、又没法从逻辑入口接回来的面板
	 * （网页：`<webview>` 一卸页面就没了，后台会话里 agent 也操作不了它）。默认 false。
	 * 所有 keepAlive 标签放在统一扁平常驻层，切换会话不重挂；后台仍收到标签归属会话的 `session` 和 `cwd`。
	 * 弹出、收回窗口仍会重新挂载，不改变 detachable 的资源恢复约定；用不着的页面自己少挂（挂着的每一页都是一个进程）。
	 */
	keepAlive?: boolean;
	/**
	 * 现在能不能新开。不给就一直能用；按目录（同 `PanelProps.cwd`）和有无会话分别计算。
	 * 目录或有无会话变化、窗口回到前台、一轮结束时重算；答 false（或还没答上来、抛错）时不列入新开列表、快捷键不新开，已有标签不隐藏、不卸载。
	 */
	available?: (context: PanelAvailabilityContext) => boolean | Promise<boolean>;
}

export interface PanelAvailabilityContext {
	/** 同 `PanelProps.cwd`。 */
	cwd?: string;
	/** 有没有打开的会话：新对话还没发消息时是 false。只围着一个会话转的面板（侧边聊天、子 Agent）没有会话就不列。 */
	session: boolean;
}

/** 会话建好之前人在输入框里选的模型（`SessionModel.id`）和思考档位；没有 `model` 是跟随父会话（独立会话用默认模型）。 */
export interface SessionChoice {
	model?: string;
	thinking?: ThinkingLevel;
}

/**
 * 产品的对话视图画一个会话（插件自己的子会话：侧边聊天、子 Agent；或插件的独立会话：页面上的助手），和主列是同一套转录：
 * 工具卡片、思考、运行行都一样。子会话等人批准时，审批卡压在主输入框上方，标明是哪个子会话在请求；独立会话不挂在哪个对话下，
 * 审批卡压在这个视图的输入框上方。
 */
export interface ConversationProps {
	/** 要画的会话。还没有（侧边聊天的第一句还没发）时画 `empty` 和输入框。 */
	sessionId?: string;
	/**
	 * 底下的输入框。不给就只读（子 Agent 的全过程）。按发送时调 `send`，输入框随即清空；会话正在跑时发送键换成停止键，按了调 `stop`。
	 * 发出去的话怎么进会话由插件定（逻辑入口经 `ctx.sessions.send`），这里只管收字。
	 */
	composer?: {
		/** 输入框跨窗口保留文字、附件和引用时传 PanelProps.tab；页面上的助手传一个自己固定的名字。 */
		draftKey?: string;
		placeholder?: LocalizedText;
		/** `choice`：会话还没建、给了 `blank` 时，人在第一句之前选的模型和档位，插件建会话时照它给。 */
		send(text: string, choice?: SessionChoice): void | Promise<void>;
		/** 支持附件时接收完整消息；不提供时保持纯文字输入。`choice` 同 `send`。 */
		sendMessage?(message: OutgoingMessage, choice?: SessionChoice): void | Promise<void>;
		/** steer 运行时也能发，发送键不变停止键。 */
		mode?: "turn" | "steer";
		disabled?: boolean;
		/**
		 * 发送按钮左边的模型和思考档位，量的是这个会话（子会话没选的跟着父会话，独立会话没选的用默认模型）；会话还没建时只有给了 `blank` 才画。
		 * `choose`：和主输入框同一枚按钮，能换，子会话的模型菜单最前面多一项「跟随主会话」；`show`：只读的模型名和档位，悬停说明末尾接 `modelTip`。
		 * 不给就不画。插件经 `ui.composerItem(…, { side: "end" })` 加的格子（上下文用量）不用声明，会话在就画。
		 */
		model?: "choose" | "show";
		/**
		 * 会话还没建（第一句还没发）时 `model: "choose"` 也画，人先选好，第一句发出去时选的经 `send`、`sendMessage` 的 `choice` 交回。
		 * `parentId`：第一句会开在哪个会话下面，菜单最前面的「跟随主会话」跟它，不给是独立会话；`model`：人没动过时插件要用的模型，不给就跟随父会话（独立会话用默认模型）。
		 */
		blank?: { parentId?: string; model?: string };
		/** `model: "show"` 时悬停说明的最后一句：模型是怎么定下的、去哪里改。 */
		modelTip?: LocalizedText;
		/** 发送按钮左边、用量和模型前面，插件自己的东西。 */
		footer?: ReactNode;
		stop?(): void;
	};
	/**
	 * 人在这里说的最后一句能「编辑并重新提问」：宿主截掉它和之后的，拿改过的字替插件重跑一轮（照常经 `prompt.submit`），
	 * 不问要不要连文件一起退回。没有撤回和分叉：那两样把话放回主对话的输入框、往会话列表里开新会话，子会话两样都没有。
	 * 一轮在跑时按钮置灰。侧边聊天开它；子 Agent 的全过程不开（它的话是派它的会话写的，不是人）。
	 */
	reask?: boolean;
	/** 仅定制这个视图里的用户消息；fallback 是产品原有气泡，不改存储。 */
	renderUserMessage?(message: UserMessage, fallback: ReactNode): ReactNode;
	/** 仅过滤这个视图的回复正文与复制，供回报卡去重，不影响工具、思考或历史。 */
	replyText?(text: string, message: AssistantMessage): string;
	/** 还没有消息时画在转录的位置上（`PanelEmpty` 之类）。不给就是空白。 */
	empty?: ReactNode;
}

/**
 * 插件给自己的工具画的审批卡（`ui.approvalCard`）。卡片压在输入框正上方的那一格由产品摆，排队、停下这一轮时撤卡也归产品；
 * 组件画整张卡（外框、正文、按钮），人拍板时调 `respond`。要连同回答交给工具的别的话（修改意见、评论），先经自己的
 * `remote()` 交给逻辑入口，再 `respond`：工具从 `run.ask` 返回以后去取。
 */
export interface ApprovalCardProps {
	request: ApprovalRequest;
	/** 在问的会话；子会话（侧边聊天、子 Agent）问时是子会话的 id。 */
	sessionId: string;
	/** 问的是子会话时它的标题，卡上要写明是谁在请求。 */
	from?: string;
	/** 排在这张后面还在等的审批张数，卡上写 +N（`@plume/ui` 的 `ApprovalFrame` 替你写）。到期时刻在 `request.expiresAt`。 */
	queued: number;
	/** 交出回答。没送到时抛错，卡片自己把错误摆出来、让人再答。 */
	respond(decision: ApprovalDecision): Promise<void>;
	/** 设置里现在的权限模式。 */
	permission: PermissionMode;
	/**
	 * 把权限模式从请求批准切到帮我批准，给「接受并开启自动模式」这样的按钮：先切，再 `respond`。
	 * 只在人点了卡上的按钮时调；不在请求批准档时什么都不改（不会把完全访问降下来）。
	 */
	allowAuto(): Promise<void>;
	/** 窄窗口：面板区一次只摆一格，打开面板会盖住这张卡，要读的东西画在卡里。 */
	compact: boolean;
	/** 产品的通用审批卡。认不出这次请求时直接返回它。 */
	fallback: ReactNode;
}

/** 始终位于主输入框上方的一整行，不随转录滚动或浮到侧边。 */
export interface ComposerAboveProps {
	session: SessionView;
}

/** `ui.agentDelivery` 的组件收到的：送达所在的会话，和这一次送达里本插件的子会话交回的几份。 */
export interface AgentDeliveryProps {
	sessionId: string;
	reports: DeliveredReport[];
}

/** 复用产品 Markdown，包括会话范围内的文件链接。 */
export interface MarkdownProps {
	text: string;
	sessionId?: string;
	streaming?: boolean;
	className?: string;
	/**
	 * 一句短话：只画行内记号（代码、加粗、强调、删除线），包在一个 `span` 里，不分段、不带段距；链接和图片只留字，不给点。
	 * 结构化回报里一条记录的一句话用它：交给整个 Markdown 会包出段落，原样摆着反引号又像一份没排版的草稿。
	 */
	inline?: boolean;
}

export interface ComposerItemProps {
	/** 输入框所在的会话。新对话里还没有会话，是 undefined：这一格在新对话的输入框里也画。 */
	sessionId?: string;
	/** 这个会话正在跑一轮。 */
	running: boolean;
	/** 下一轮会用的模型（会话选的，或默认模型）；一个可用的模型都没有时为空。 */
	model?: { id: string; name: string; contextWindow: number };
}

export interface ComposerItemOptions {
	/** `start` 排在「添加附件」那一组后面，只在主输入框；`end` 在右边、模型选择前面，插件子会话（`ui.Conversation`）的输入框里也画，拿到的是子会话。默认 `start`。 */
	side?: "start" | "end";
	order?: number;
}

export interface ComposerChipProps {
	/** 输入框所在的会话；还没发出第一条消息的新会话为空。 */
	sessionId?: string;
	/** 下一轮在哪个目录里跑：会话的工作目录，新会话是选中项目的目录；不属于任何项目的聊天为空。 */
	cwd?: string;
	/** 这个会话正在跑一轮。 */
	running: boolean;
	/**
	 * 以人的身份在这个会话里发一句话，和人在输入框里打字按发送一样：画成人的气泡，模型当它是人说的；正在跑时排进队里。
	 * 只在人点了这一格里写明要发什么的按钮时调（工作树的「交给这个对话解决」），不拿来替人做决定。新对话（没有 `sessionId`）里什么都不做。
	 */
	send(text: string): void;
}

/** `ui.environmentSection` 的组件拿到的：卡片跟着的会话。 */
export interface EnvironmentSectionProps {
	session: SessionView;
}

/** 别的插件登记的一节环境卡片，见 `UiContext.useEnvironmentSections`。 */
export interface EnvironmentSectionEntry {
	/** `插件名/id`，全局唯一，可以拿来记「这一节藏起来了」。 */
	key: string;
	/** 卡片「显示哪些内容」菜单里的名字。 */
	label: LocalizedText;
	order: number;
	/** 已经包好错误边界：一节出错只撤下这一节。 */
	component: ComponentType<EnvironmentSectionProps>;
	/**
	 * 登记时给了 `attention` 才有：画环境卡片的插件把它挂在开关旁边（它什么都不画），这一节等人处理的那句话变了就调 `onChange`。
	 * 已经包好错误边界，出错时当作没有。
	 */
	attention?: ComponentType<EnvironmentAttentionProps>;
}

/** `EnvironmentSectionEntry.attention` 拿到的。 */
export interface EnvironmentAttentionProps {
	session: SessionView;
	/** 这一节等人处理的那句话，见 `UiContext.environmentSection` 的 `attention`；没有时是 undefined。 */
	onChange(text: string | undefined): void;
}

export interface ConversationCardProps {
	/** 卡片跟着的会话：正文里开着的那一个。 */
	session: SessionView;
	/**
	 * 画在哪：`floating` 浮在转录右上角（或停靠在右边那一列），`inline` 在输入框正上方。浮着的要自己的底色和阴影，压在正文上面也读得清。
	 * 登记时给了 `lane` 的卡片总是 `floating`。
	 */
	placement: "floating" | "inline";
	/** 停下这个会话正在跑的一轮，和输入框的停止按钮一样。只在人点了卡片上的按钮时调。 */
	stop(): void;
	/**
	 * 替人说一句让它接着做，和转录底下的「继续」一样：这句话发给模型，界面不画成人的气泡、不当会话标题。
	 * 只在人点了卡片上的按钮时调（「继续」「重试这一步」），不拿来替人说别的。
	 */
	carryOn(text: string): void;
}

export interface ComposerChipOptions {
	/** `start` 排在项目签后面，`end` 靠右。默认 `start`。 */
	side?: "start" | "end";
	order?: number;
}

/**
 * 侧栏一行会话行首的记号（14px 的状态槽）。在跑、未读由产品画，盖过插件的记号；空闲时才问插件。
 * 不是自己要说的会话原样返回 `fallback`（下一个插件的记号，最里层是产品的空心圈）。图标 11px 左右、颜色用淡字，悬停说明经 `data-plume-tip`。
 */
export interface SessionMarkProps {
	session: SessionSummary;
	fallback: ReactNode;
}

/** 提示条的轻重：`info` 留得短，`warn`、`error` 留得长些、颜色不同。 */
export type NotifyLevel = "info" | "warn" | "error";

/**
 * 侧栏行首说的、会话摘要里没有的事：`waiting` 是它或它的子会话停下来等人批准，`done`、`failed` 是在人没看着时跑完、没跑完
 * （出错、跑到上限、卡住）而人还没打开看。人按停的、看着跑完的不留记号；在跑看摘要的 `running`。
 */
export type SessionActivity = "waiting" | "done" | "failed";

/**
 * `page: "extensions-skills"`、`"extensions-connectors"` 的组件收到的：页头的刷新（技能还有项目选择）由「插件市场」画，
 * 组件照着读、照着画列表。别的位置的组件什么也不收。
 */
export interface ExtensionsSectionProps {
	/** 只给技能：选中的项目目录，null 是只看个人的（和插件带来的）。 */
	project?: string | null;
	/** 人点了刷新就变一次，组件跟着重读。 */
	refreshKey?: number;
	/** 打开一个插件的详情（「插件市场」里点开它看到的那一页）。`key` 是插件的目录名（`InstalledPlugin.dir` 的最后一段）。 */
	openPlugin?(key: string): void;
}

/** 「插件市场」那一类页顶「添加」菜单里的一项，见 `SettingsSectionOptions.actions`。 */
export interface SectionAction {
	label: LocalizedText;
	/** 名字下面的一句小字。 */
	detail?: LocalizedText;
	icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
	run(): void | Promise<void>;
}

export interface SettingsSectionOptions {
	/**
	 * 这一节的标题：插件详情里「设置」下面的小标题；单独占导航一行时是那一行的字和页头标题。放进产品的页面里时只当无障碍名，
	 * 页面上的小标题由组件自己画；`general`、`session-models` 例外，它是那一行的名字。
	 */
	title: LocalizedText;
	/** 小标题或页头标题下面的一段介绍；`general`、`session-models` 是那一行名字下面的一句说明。 */
	detail?: LocalizedText;
	/** 导航那一行的图标，颜色跟着文字走（currentColor）；不给用产品的默认图标。只在 `page: "nav"` 时画。 */
	icon?: ComponentType<{ size?: number; className?: string }>;
	order?: number;
	/**
	 * `page: "nav"` 时排在导航哪一组，组里按 `order` 排；不是 `nav` 时给了算错：
	 * - 不给是「基本」组，排在产品自己那几行后面；
	 * - `agent` 是「Agent 能力」组，排在「智能体」后面。给的是管 Agent 能做什么的页（命令、钩子、网页搜索）；
	 * - `data` 是「数据」组，排在「存储」前面。给的是读写本机数据的页（符号索引、使用统计）；
	 * - `vcs` 是「代码与版本控制」组。给的是管仓库、工作树的页（工作树）。
	 */
	group?: "agent" | "data" | "vcs";
	/**
	 * 画在哪。不给时画进这个插件的详情（「插件市场」里点开它看到的那一页）的「设置」一节：只和这个插件有关的
	 * 选项放这里，不占设置导航。用户不管装了哪个插件、都会到设置里直接找的功能才另给位置：
	 * - `nav` 单独占设置导航的一行（使用统计这类），页头由产品按 `title`、`detail` 画；
	 * - `extensions-skills`、`extensions-connectors` 是「插件市场」页的「技能」「连接器」两类，画在筛选条的「已安装」里；
	 *   刷新（技能还有看哪个项目）由市场画在页头，经 `ExtensionsSectionProps` 交给组件。
	 *   给的是管技能、MCP 连接器的插件：装了哪些、开着没有、配好没有，和还能装什么放在一处看。
	 * - `general` 是「常规」页「常规」那张卡里的一行，排在「显示思考过程」后面：名字和说明由产品按 `title`、`detail` 画，
	 *   组件只画右边的控件（通常是一个 `Toggle`）。给的是随应用发、不能停用的插件自己的开关（智能标题总结）。
	 * - `personalization` 是「个性化」页，画在「全局指令」和「语气」之间。给的是和那一页说的是同一件事的东西（比如记忆）。
	 * - `agents` 是「智能体」页，画在页头下面、「会话」一组上面，整节由组件自己画（子智能体的名单）。
	 * - `session-models` 是「智能体」页「会话」那张卡里的一行：名字和说明由产品按 `title`、`detail` 画，组件只画右边的控件
	 *   （通常是一个 `ModelSelect`），给某个功能选用哪个模型。
	 * 「智能体」页只在有插件往里画东西时出现在导航里。给了位置的，插件详情里有一个去那里的入口。
	 */
	page?: "nav" | "general" | "personalization" | "agents" | "session-models" | "extensions-skills" | "extensions-connectors";
	/**
	 * `page: "extensions-skills"`、`"extensions-connectors"` 时放进页顶「添加技能」「添加连接器」的条目，技能的排在产品自己那一项
	 * （让 agent 写一个）后面；只有一项时按钮直接做它。给的是只有这个插件做得到的添加方式（打开个人技能目录、手动添加连接器）。
	 * 跑完市场换到「已安装」，这一节接着画（比如弹出添加的对话框）。
	 */
	actions?: SectionAction[];
}

/**
 * 产品的模型下拉：和输入框旁的模型菜单是同一份列表（常用、按供应商分组、搜索），最前面多一项「跟随」。
 * 只列可用的模型，不经手密钥。选了不改哪个会话，只把选中的模型 id（`SessionModel.id`）交给 `onChange`，选「跟随」给空串。
 */
export interface ModelSelectProps {
	/** 选中的模型 id；空串是跟随。 */
	value: string;
	onChange(modelId: string): void;
	ariaLabel: string;
	/** 「跟随」那一项的名字（「跟随主会话」）。 */
	inheritLabel: string;
	/** 「跟随」那一项下面的小字，也进悬停提示。 */
	inheritDetail?: string;
	/** 跟随时实际会用的模型；给了就在框里写它的名字，后面跟着 `inheritedSource`。 */
	inheritedModelId?: string;
	/** 跟随时写在模型名后面的来源（「随主会话」「默认」）。 */
	inheritedSource?: string;
	disabled?: boolean;
	/**
	 * 只剩一枚箭头，贴在它管的那颗按钮旁边当分体按钮（计划卡上的「在新会话里执行」）：窄处装不下一个带名字的选择。
	 * 选了什么由那颗按钮自己说，悬停提示说全名。
	 */
	compact?: boolean;
}

/**
 * 主输入框右下角那两枚：模型和思考档位，样子、菜单都和输入框里的一样。给开新会话之前先选好它怎么跑的地方用（建议新会话的卡片）。
 * 不改哪个会话，只把选择交出来。没选时显示默认模型和设置里的默认推理强度，和新会话发第一句之前的输入框一样。
 */
export interface ModelControlsProps {
	/** 选中的模型 id（`SessionModel.id`）；空串是默认模型。 */
	model: string;
	/** 选中的思考档位；不给是默认推理强度。模型没有这一档时显示的是就近落到的那一档，和跑的时候一致。 */
	thinking?: ThinkingLevel;
	onModelChange(modelId: string): void;
	onThinkingChange(thinking: ThinkingLevel): void;
	disabled?: boolean;
}

/** 「跟随」时会落到哪个模型上，给设置页的下拉算继承的那一项。 */
export interface ModelDefaults {
	/** 新会话的默认模型；一个可用的都没有时为空。 */
	defaultModel?: string;
	/** 当前打开的会话的模型；没打开会话时是默认模型。 */
	sessionModel?: string;
	/** 新会话的思考档位（设置 › 常规的默认推理强度）。 */
	thinking: ThinkingLevel;
}

/** 登记过的项目。 */
export interface ProjectInfo {
	id: string;
	name: string;
	path: string;
}

/** 屏幕上的一块矩形，逻辑像素。 */
export interface ScreenRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * 截屏这件事里插件自己做不到的部分：拍屏幕、开盖住整块屏幕的窗口、钉在桌面上的窗口、系统剪贴板、全局快捷键。
 * 这些只有主进程能做，宿主做；选区、标注、工具栏、设置由插件画（`screenOverlay`、`pinnedShot`、`settingsSection`）。
 */
export interface ScreenCapture {
	/**
	 * 拍下指针所在的那块屏幕，铺一层盖住它的浮层，浮层里画 `screenOverlay` 注册的组件。没有注册浮层组件时报错。
	 * macOS 没给屏幕录制权限时弹出系统的授权提示，这一次不开浮层，返回 false。
	 */
	start(): Promise<boolean>;
	/**
	 * 全局快捷键（Electron accelerator 的写法，如 `Alt+A`）：Plume 不在前面也收得到，按下等于 `start()`。
	 * 传 null 取消。同一个插件只有一个，后设的替换先设的。被别的程序占了是 `taken`，写法不认识是 `invalid`。
	 */
	setShortcut(accelerator: string | null): Promise<"ok" | "taken" | "invalid">;
	/** 系统的选文件夹对话框（保存位置用）；取消是 null。 */
	pickDirectory(title: string): Promise<string | null>;
	/** 系统桌面文件夹的路径：没设保存位置时存到这里。 */
	desktopDirectory(): Promise<string>;
}

/** 一次截屏：浮层每开一次换一个 id，组件随之重新挂上。 */
export interface ScreenCaptureSession {
	id: number;
	/** 整块屏幕的快照，物理像素，RGBA 逐行排。 */
	snapshot: { pixels: Uint8ClampedArray; width: number; height: number };
	/** 这块屏幕在全局坐标里的位置和大小，逻辑像素。浮层窗口正好盖住它，组件里的坐标都从它的左上角算。 */
	bounds: ScreenRect;
	/** 物理像素 / 逻辑像素。 */
	scaleFactor: number;
	/** 快照的色彩空间，画到 canvas 上要用同一个，颜色才不偏。 */
	colorSpace: "srgb" | "display-p3";
	/** 开始时指针在哪，相对 `bounds` 的左上角。 */
	cursor: { x: number; y: number };
}

export interface ScreenOverlayProps {
	session: ScreenCaptureSession;
	/** 背景画好了。宿主这时才把浮层亮出来：先亮再画，屏幕会闪一下空白。 */
	ready(): void;
	/** 完成：浮层收起，Plume 回到前面（从 Plume 里发起的话）。给了 png（data URL）就放进剪贴板。 */
	finish(png?: string): Promise<void>;
	/** 不截了：浮层收起，焦点还给截屏前的窗口。 */
	cancel(): void;
	/** 把一张图钉在桌面上：浮层收起，在 `at`（全局坐标）开一个置顶的小窗口，里面画 `pinnedShot` 注册的组件。 */
	pin(png: string, at: ScreenRect): Promise<void>;
	/** 只放进剪贴板，浮层不收。 */
	copy(png: string): Promise<void>;
	/** 浮层暂时让鼠标点到底下去，Esc 也不再拦（浮层上只剩一条提示的时候）。 */
	passThrough(on: boolean): void;
	/** 订阅 Esc。截屏期间宿主注册了全局的 Esc，浮层没拿到焦点也收得到。返回的函数取消订阅。 */
	onEscape(listener: () => void): () => void;
}

export interface PinnedShotProps {
	/** 钉住的图，PNG data URL；宽高是逻辑像素，也是窗口的大小。 */
	image: { src: string; width: number; height: number };
	/** 窗口准备好了（图画上了），宿主这时才显示它。 */
	ready(): void;
	close(): void;
	/** 拖窗口：按下时调 dragStart，之后每次移动给出离按下点的偏移（屏幕坐标）。 */
	dragStart(): void;
	dragMove(dx: number, dy: number): void;
}

/** 浅色、深色分别覆盖哪些 token，值是 CSS 值；没写的沿用默认。 */
export interface Skin {
	/** 数据皮肤的显示名；与 mode 一起提供时接管配色，外观页只读展示，停用后恢复用户偏好。 */
	name?: string;
	/** 临时覆盖应用深浅模式，不改写用户保存的主题偏好；system 跟随系统。不提供 token 时使用产品默认配色。 */
	mode?: "system" | "light" | "dark";
	light?: Partial<Record<SkinToken, string>>;
	dark?: Partial<Record<SkinToken, string>>;
}

/** 已结束的最新一轮回复下面的扩展；跟随转录滚动，开始新一轮时撤下。 */
export interface TurnFooterProps {
	session: SessionView;
	/** 这一轮最后一条回复的时间戳。 */
	timestamp: number;
}

/**
 * 一轮收尾那条回复底下那一排操作（时间、复制、分叉）里的一个按钮，每一轮都有，不只最新一轮。
 * `from` 是这一轮开口的那条消息在会话里的位置，`to` 是收尾那条回复的位置加一：插件按自己记下的消息位置挑出归这一轮的东西。
 */
export interface ReplyActionProps {
	sessionId: string;
	from: number;
	to: number;
}

export interface FileDiffProps {
	hunks: ChangeHunk[];
	path?: string;
	showPath?: boolean;
	maxLines?: number;
}

export interface FilePreviewProps {
	sessionId: string;
	path: string;
	/** 插件通过自己的 remote 读取的文件，不扩大宿主的文件读取权限。 */
	contents: FileContents;
}

/** 只读文档的数据由调用方读取；预览插件不接收磁盘路径，也不取得调用方的目录权限。 */
export interface DocumentPreviewProps {
	name: string;
	/** 文件或版本变化时换这个值，取消旧读取并重建预览。 */
	identity: string;
	readBytes(signal: AbortSignal): Promise<Uint8Array>;
	fallback?: ReactNode;
}

export interface FileMenu {
	open: boolean;
	onContextMenu(event: MouseEvent, target: { path: string; onOpen?: () => void }): void;
	element: ReactNode;
}

/** 只在人点击明确的按钮时打开空白对话并准备草稿，不发送、不创建会话记录。 */
export interface ConversationDraft {
	/** 已登记项目的 id；与 cwd 二选一。 */
	project?: string;
	/** 没有本地项目时，逻辑入口准备好的工作目录的绝对路径。 */
	cwd?: string;
	text: string;
}

/** 一段引用保留正文及说话者，不携带 DOM。 */
export interface DraftQuote {
	id: string;
	text: string;
	from: "user" | "assistant";
}
export interface QuoteAction {
	label: LocalizedText;
	run(quote: DraftQuote, sessionId: string): void | Promise<void>;
}
export interface SessionChange {
	sessionId: string;
	type: "messages" | "summary" | "deleted";
	tools?: string[];
}

/** 插件在 `@` 菜单里提供的一项，选中只插入 token，不会自动发送。 */
export interface ComposerMention {
	id: string;
	title: string;
	description?: string;
	origin?: string;
	kind: "subagent" | "plugin";
	token: string;
	avatar?: string;
}

export interface UiContext {
	quoteAction(action: QuoteAction): void;
	/** 追加到当前可见的同插件面板，或开新标签；保留草稿，不自动发送。 */
	quoteInPanel(panelId: string, sessionId: string, quote: DraftQuote): void;
	/** 仅接受当前真实点击，与主输入框的停止相同。 */
	stopSession(sessionId: string, event: MouseEvent): Promise<void>;
	onSessionsChanged(listener: (event: SessionChange) => void): () => void;
	openMediaFile(name: string, sessionId: string): Promise<void>;
	revealMediaFile(name: string): Promise<void>;
	revealMediaLabel(): string;
	ComposerSend: ComponentType<{ running: boolean; disabled?: boolean; tip?: string; onSend(): void; onStop(event: MouseEvent<HTMLButtonElement>): void }>;
	/** 文件树等入口打开终端；处理器只在用户操作时运行。 */
	terminalOpener(open: (directory: string, sessionId: string) => void | Promise<void>): void;
	/**
	 * 回复里 shell 代码块的「在终端运行」：人点击后调用 `run(command, sessionId)`，`command` 已去掉提示符（`$ `、`> `）和注释行，
	 * 要原样执行；`sessionId` 是代码块所在的会话。登记和没有处理器时的提示同 `terminalOpener`。
	 */
	terminalRunner(run: (command: string, sessionId: string) => void | Promise<void>): void;

	/** 会话标题栏的局部控件；只在有会话时显示，组件不能接管标题或布局。 */
	sessionToolbar(id: string, component: ComponentType<{ session: SessionView }>): void;
	/** 会话菜单中的操作，点击后调用；没有会话时不显示。 */
	sessionMenuItem(
		id: string,
		item: { label: LocalizedText; icon?: ComponentType<{ size?: number }>; run(session: SessionSummary): void | Promise<void> },
	): void;
	/** 运行时送达行的查看入口；后注册者生效，停用时恢复前一个。 */
	deliveryAction(kind: "job", run: (sessionId: string, id: string) => void): void;
	/**
	 * 本插件的子会话交回的结果（`ctx.sessions.report` 带了 `delivery` 的）在对话里画成哪一行：一次送达里本插件交的几份一起交给它，
	 * 画成一行。只画自己交的那几份，别的插件交的由它们自己登记的组件画；同一插件再登记换掉前一个，停用时撤下，没登记时不画。
	 */
	agentDelivery(component: ComponentType<AgentDeliveryProps>): void;
	/** 当前项目的系统打开方式；复用文件预览的默认目标和菜单。 */
	readonly ProjectOpener: ComponentType<{ path: string }>;
	readonly name: string;
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
	 */
	toolCard(tool: string, component: ComponentType<ToolCardProps>, options?: { order?: number; match?: "tool" | "prefix"; inline?: boolean }): void;
	/**
	 * 转录里怎么说自己的工具：通用卡片那一行、合成一段活的那一行、运行行，见 `ToolLine`。只改说法和归类，画法照通用卡片；
	 * 同时登记了 `toolCard` 的，卡片单独一行（`inline` 的照常并进一段活），`fallback` 用这里的说法。同一工具后登记的生效，它撤下后前一个恢复；插件登记的
	 * 优先于产品给内置工具的说法。
	 */
	toolLine(tool: string, line: ToolLine): void;
	/**
	 * 给自己的工具画审批卡，见 `ApprovalCardProps`。`tool` 是 `ApprovalRequest.tool`；order 和让位规则同 `toolCard`：
	 * 渲染出错时让给下一个，都不行用产品的通用卡。
	 * `match: "kind"` 时第一个参数对的是 `ApprovalRequest.kind`：工具名不固定、一类问题从几个工具里问出来时用（MCP 服务
	 * 中途要人填的表单，问它的是哪个 `mcp__…` 工具都有可能）。同一次请求两种都对得上时，按工具名登记的在前。
	 */
	approvalCard(tool: string, component: ComponentType<ApprovalCardProps>, options?: { order?: number; match?: "tool" | "kind" }): void;
	/**
	 * 往工作区加一个面板，标签按会话保留，宽度和收起偏好在窗口内共享。
	 * 全屏按会话保存，盖满工作区；窄窗口也盖满工作区，正文和面板放不下横排时上下排列。
	 * 面板区顶上一排标签，每个开着的面板一个；点「+」开一个开始页标签，上面每个面板一张卡片，按 order 从小到大排（默认 0，相同时按注册先后），点卡片这个标签就变成那个面板。
	 * id 在插件内唯一。标题、说明给函数的，产品每次按当前界面语言调用它；只给一个字符串就哪种语言都显示它。
	 */
	panel(id: string, component: ComponentType<PanelProps>, options: PanelOptions): void;
	/**
	 * 往侧栏的去处里加一个页面：侧栏一行，点了正文区整块换成这个页面。按 order 从小到大排（默认 0，相同时按注册先后），
	 * 都排在产品自己的「插件」前面。id 在插件内唯一；标题给函数的，产品每次按当前界面语言调用它。
	 */
	page(id: string, component: ComponentType<PageProps>, options: PageOptions): void;
	/** 换皮肤：可重复调用更新，null 撤下自己的皮肤；最后注册的生效，撤下后前一个恢复。 */
	skin(skin: Skin | null): void;
	/** 登记界面入口的订阅清理；停用、重载或加载失败时执行，旧入口不能再注册皮肤。 */
	effect(dispose: () => void): void;
	/**
	 * 输入框底下那排控件加一格：`start` 在左边，排在产品自己的「添加附件」和权限后面；`end` 在右边，排在模型选择前面
	 * （上下文用量这类读数）。各自按 order 从小到大（默认 0，相同时按注册先后）。
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
	 * `lane: true` 的卡片（环境卡片）占右边 300px 宽的一列，从不放到输入框上方：对话那一列让出 324px 后正文还有 520px 时停靠，
	 * 转录和输入框整体往左让、卡片不盖住字；不够时浮在转录右上角。这一列从顶到转录底，卡片太长要自己滚（`max-height: 100%`、
	 * `min-height: 0`，正文 `overflow-y: auto`）。这一列有卡片时，别的卡片浮得下就排到它下面，浮不下照旧在输入框上方。
	 */
	conversationCard(id: string, component: ComponentType<ConversationCardProps>, options?: { order?: number; lane?: boolean }): void;
	/**
	 * 往会话的环境卡片里加一节（卡片由运行诊断插件画）：和这个会话相关的一件周边的事，比如当前分支的拉取请求，每一行都只是入口，
	 * 点了去插件自己的页面或面板。没什么可说时返回 null，卡片不留空位，也不画分隔线。`label` 是卡片「显示哪些内容」菜单里的名字。
	 * 按 order 从小到大排进卡片自己的几节之间（默认 0）。id 在插件内唯一，停用时撤下。
	 *
	 * `attention` 是一个 React hook：这一节此刻有没有等人处理的事（建议的新会话还没人决定），有就返回一句给人看的话（按界面语言，
	 * 「2 条建议的新会话等你决定」），没有返回 undefined。卡片收着、这一节没被藏起来时，标题栏上开关卡片的那颗挂一个圆点，这句话
	 * 接在它的说明后面。只为提醒人回来做决定，不为「有东西在跑」——那样圆点会一直亮着。规则同 React 的 hook。
	 */
	environmentSection(
		id: string,
		component: ComponentType<EnvironmentSectionProps>,
		options: { label: LocalizedText; order?: number; attention?: (session: SessionView) => string | undefined },
	): void;
	/** React hook：各插件登记的环境卡片分区，按 order 排好，给画环境卡片的插件用；增减跟着变。只在组件里调。 */
	useEnvironmentSections(): readonly EnvironmentSectionEntry[];
	/**
	 * 输入框空着时的灰字建议（下一步想说什么），按 Tab 整段填进去，人看过再自己发。宿主画输入框时按注册先后问，
	 * 取第一个给出字的；只问开着的会话，新对话不问。返回空串或 undefined 表示这次没有建议。
	 * 只在渲染时同步调，别在里面做耗时的事。一个插件只能有一个，再注册换掉上一个。
	 */
	/** 每次打开 `@` 时列出当前目录可用的引用；停用后自动撤销，一个插件一份。 */
	mentions(provider: (context: { cwd?: string; sessionId?: string }) => ComposerMention[] | Promise<ComposerMention[]>): void;
	composerHint(hint: (session: SessionView) => string | undefined): void;
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
	 * 在指定会话的文件面板打开已有文件，读取仍受该会话的文件边界约束；唯一的例外是这个会话最近一次请求的「记忆文件」
	 * （`PromptSection.files` 标的项目指令、项目记忆来源），在边界外也能只读打开。
	 */
	openFile(path: string, sessionId: string): Promise<void>;
	/**
	 * 纯文字里印出来的一条路径（终端输出、日志）在这个会话里指的那个文件，返回绝对路径。绝对路径看它在不在；相对路径先按会话工作目录、
	 * 项目源文件夹拼，不在就按结尾找，只认唯一的一个。不存在、不止一个、是文件夹、在会话文件边界外都是 null；答出来的 `openFile` 打得开。
	 */
	findFile(path: string, sessionId: string): Promise<string | null>;
	/**
	 * 一次拖放带着的本机绝对路径：访达里拖来的文件、文件面板里拖的行。不带路径的拖动是 null。
	 * 在 drop 处理函数里同步调，它返回后就读不到了；dragover 时浏览器不给读内容，带路径也只答空数组。
	 */
	droppedPaths(transfer: DataTransfer): string[] | null;
	/** 产品的文件右键菜单；root 用于复制相对路径，hook 只在组件里调用。 */
	useFileMenu(root: string): FileMenu;
	/** 产品的语法高亮 diff 和文件预览；插件不需要另带一套代码渲染器。 */
	readonly FileDiff: ComponentType<FileDiffProps>;
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
	 * 主输入框排队条上，每条排着的消息「更多」菜单里多一项，见 `QueueAction`；排在产品自己的「编辑」后面，几个插件按注册先后。
	 * 没有插件登记时排队条直接放「编辑」按钮，不出菜单。一个插件只能有一个，再注册换掉上一个。
	 */
	queueAction(action: QueueAction): void;
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
	/** 打开本插件注册的页面，和点侧栏去处里那一行一样；不接受别的插件的页面。只在人点了按钮时调（输入框上方提示条的「查看」）。 */
	openPage(id: string): void;
	/**
	 * 侧栏去处里本插件那一页的那一行右端挂一个数（有东西在等人看：没人看见的失败）。`null` 或 0 拿掉；人正在那一页上时不画。
	 * `label` 说这个数是什么意思，给读屏和悬停提示。`attention` 为 true 时也列进通知菜单。只能挂本插件注册的页面；插件停用时一起拿掉。
	 */
	pageBadge(id: string, badge: { count: number; label: LocalizedText; attention?: boolean } | null): void;
	/** 用户点击时在系统浏览器打开 HTTP(S) 链接，不允许凭据或其他协议。 */
	openExternal(url: string): Promise<void>;
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
	 * 这个会话的上下文窗口用到哪儿了：对话消息、工具表、系统提示词、项目指令、项目记忆各占多少，项目指令和项目记忆来自哪几个文件，见 `ContextBreakdown`。
	 * 各段按最近一次发出的请求估，本次启动后这个会话还没发过请求时是 null。每次调用现算，在要看的时候调（比如点开读数时），别每次渲染都调。
	 */
	contextBreakdown(sessionId: string): Promise<ContextBreakdown | null>;
	/**
	 * 输入框 `/` 菜单此刻有的命令，同名去重后的样子：产品自己的（`/clear`，没有 `plugin`）在前，再是各插件经 `ctx.commands`
	 * 供的。`cwd` 是按哪个目录列（项目里的命令文件、技能跟着变）。只读，展开、发送仍走输入框。每次调用现问，要看时再调。
	 */
	listCommands(context?: { cwd?: string }): Promise<ListedCommand[]>;
	/** 产品的对话视图，见 `ConversationProps`。 */
	readonly Conversation: ComponentType<ConversationProps>;
	/** 产品的会话背景设置：选图、拖入图片、预览、铺放、效果、浓淡、显示位置，以及整个窗口的磨砂质感（不看皮肤、不要图）；外观页不再有这一节，背景只经它设置。 */
	readonly ChatBackgroundSettings: ComponentType<{ title?: string }>;
	/** 产品的正文渲染器，插件的任务和回报卡不另带一套 Markdown。 */
	readonly Markdown: ComponentType<MarkdownProps>;
	/** 产品的模型下拉，见 `ModelSelectProps`。 */
	readonly ModelSelect: ComponentType<ModelSelectProps>;
	/** 输入框里的模型和思考档位那两枚，见 `ModelControlsProps`。 */
	readonly ModelControls: ComponentType<ModelControlsProps>;
	/** React hook：「跟随」会落到的模型和默认思考档位，见 `ModelDefaults`；设置改了跟着变。只在组件里调。 */
	useModelDefaults(): ModelDefaults;
	/** React hook：登记过的项目，按侧栏的顺序；增删改跟着变。只在组件里调。 */
	useProjects(): readonly ProjectInfo[];
	/**
	 * 自己逻辑入口经 `ctx.serve` 开出来的对象。apply 时拿到，存起来给组件用；逻辑入口没开或停用了，调用以错误结束。
	 * T 写逻辑入口那边的接口，末尾的 CallContext 参数这边不传。
	 */
	remote<T extends object>(): Remote<T>;
}

/** `ui.draftInSession` 放进输入框的东西。 */
export interface SessionDraft {
	text: string;
	/** 作为附件挂上的图，base64（不带 `data:` 前缀）。 */
	images?: ComposerImage[];
	/** 输入框原本是空的、人刚点过时直接发出去，见 `UiContext.draftInSession`。 */
	send?: boolean;
	/** 换掉整段草稿，而不是接在后面。 */
	replace?: boolean;
}

/** 放进输入框的一张图。 */
export interface ComposerImage {
	data: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	/** 附件的名字；不给按截图起名。 */
	name?: string;
	/** 它是媒体目录里哪张图的标注副本（`ImageContent.from`）：发出去以后记在图片块上，画廊的链路据此穿过这一步。 */
	from?: string;
}

/** `ui.openImage` 看的一张图。 */
export interface ViewerImage {
	/** `data:` URL 或 `ui.mediaUrl` 的地址。 */
	src: string;
	alt?: string;
	/** 标注完按「完成」时带标注的副本去哪（`data:` URL）。 */
	onAttach?: (dataUrl: string) => void;
}

/** 界面入口的默认导出，name 必须和逻辑入口相同。 */
export interface UiPlugin {
	name: string;
	apply(ui: UiContext): void;
}
