/**
 * The neutral message shape, and what a reply costs.
 *
 * One shape flows through the whole system. Provider adapters translate it into their wire format
 * on the way out and back on the way in, so the agent loop, the session store and the desktop UI
 * never see provider-specific JSON.
 */

// A reply records which wire format produced it, so it can be replayed to the right adapter.
import type { ApiFormat } from "./provider.ts";
import type { Failure } from "../ai/failure.ts";

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
	/** Opaque provider handle (Responses item id, etc.) needed to replay this block. */
	signature?: string;
	/**
	 * Responses 上 message 项自带的 `phase`：`commentary` 是干活途中的播报，`final_answer` 是收尾的答复。
	 *
	 * 最终答复按设计要能单独读懂，会把同一次回复里先播报过的话再说一遍——不记下来就分不清哪段是哪段，
	 * 界面两段都画、看上去整段重复。回放时也要原样带回去，模型靠它认出自己哪些话是播报。见 `restated`。
	 */
	phase?: "commentary" | "final_answer";
	/**
	 * 这段正文写完了（适配器发了 `text_end`）。只出现在流式的 `message_update` 里，不进最终存下的消息。
	 *
	 * 界面靠它分清「写完了、在等这条回复收尾」和「写到一半停住了」：有的网关在最后一个字和收尾事件之间
	 * 要空一两秒，两者光看正文长得一样。见 `agent/stream-turn.ts`。
	 */
	ended?: true;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/** Opaque provider handle: Anthropic thinking signature or Responses reasoning item id. */
	signature?: string;
	/** Provider-encrypted reasoning payload, replayed verbatim on the next turn. */
	encrypted?: string;
	/** Safety filters removed the visible text but the encrypted payload is still replayable. */
	redacted?: boolean;
	/**
	 * 入站时这段推理挂在哪个键上——原样记下，下一轮用同一个键还回去。
	 *
	 * Chat Completions 上同一件事有三个字段名：`reasoning_content`（DeepSeek、llama.cpp）、`reasoning`
	 * （OpenRouter）、`reasoning_text`。一个只认自己那个键的端点，收到另一个键就当没收到。
	 *
	 * 只有 Chat Completions 这一条链写和读它；缺省（旧会话、Anthropic 和 Responses 产生的块）一律按
	 * `reasoning_content` 处理，也就是这条链从前唯一发过的那个键——所以加这个字段不改变任何既有语义。
	 *
	 * 值也可能是 `"<think>"`：推理是从正文开头内联的标签里切出来的，回放时要包回 content 原样还回去，
	 * 而不是换成某个字段。见 `ai/think-tag.ts`。
	 */
	reasoningField?: string;
	/**
	 * 这段推理开始的时刻（`Date.now()`），由各适配器在思考块开始时记下，结束时据此算出 `durationMs`。
	 * 界面在推理还在写的时候拿它给这一段选一个固定的说法。
	 */
	startedAt?: number;
	/**
	 * 这段推理从开始到写完用了多久，毫秒，由各适配器在思考块结束时记下。写完之后界面读它，不再拿现在比。
	 *
	 * 缺省是旧会话、或者推理写到一半就断了（没等到结束事件）——那时说不出一个真的时长，界面不编一个。
	 * 一次性把整块推理吐出来的中转上，开始和结束几乎同时到，这里就只有几毫秒：量的是看得见的那一段。
	 */
	durationMs?: number;
}

export interface ImageContent {
	type: "image";
	/** base64, no data: prefix. Empty on the display path when pixels live in `media`. */
	data: string;
	mimeType: string;
	/**
	 * Content-addressed file under `session-media`.
	 *
	 * The window only ever sees this name. The model gets `data` back at the
	 * request boundary, not when a conversation is opened.
	 */
	media?: string;
	/**
	 * The `session-media` picture this one is a marked-up copy of, when it is one.
	 *
	 * For the gallery's history: an annotated copy is new bytes, so without this the edit made from it
	 * would start a history of its own. Never reaches a provider — the adapters read `data` and `mimeType`.
	 */
	from?: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Raw argument text as streamed; kept for salvage when JSON is truncated. */
	argumentsText?: string;
	/** Provider item id (Responses `item.id`), distinct from the `call_id` in `id`. */
	signature?: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;
export type UserContent = TextContent | ImageContent;

// ---------------------------------------------------------------------------
// Usage & stop reasons
// ---------------------------------------------------------------------------

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	total: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		/** How these dollar values were obtained. Absent on logs written before this field existed. */
		source?: "manual" | "catalog" | "provider" | "mixed";
		/** The selected rates are stored so later catalogue updates cannot rewrite history. */
		rates?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
		};
	};
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isEmptyUsage(usage: Usage): boolean {
	return usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 &&
		usage.cacheWrite === 0 && (usage.reasoning ?? 0) === 0 && usage.total === 0 &&
		usage.cost.input === 0 && usage.cost.output === 0 && usage.cost.cacheRead === 0 &&
		usage.cost.cacheWrite === 0 && usage.cost.total === 0;
}

export function addUsage(a: Usage, b: Usage): Usage {
	// Empty accumulators contribute no pricing provenance; every billed request does.
	const first = isEmptyUsage(a) ? b.cost : a.cost;
	const second = isEmptyUsage(b) ? a.cost : b.cost;
	const source = first.source === second.source ? first.source : "mixed";
	const sameRates =
		first.rates !== undefined &&
		second.rates !== undefined &&
		first.rates.input === second.rates.input &&
		first.rates.output === second.rates.output &&
		first.rates.cacheRead === second.rates.cacheRead &&
		first.rates.cacheWrite === second.rates.cacheWrite;
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
		total: a.total + b.total,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
			...(source !== undefined ? { source } : {}),
			...(sameRates ? { rates: first.rates } : {}),
		},
	};
}

/** What the request behind a reply actually sent and received, retries excluded. See `lastAttemptUsage`. */
export function requestUsage(message: Pick<AssistantMessage, "usage" | "lastAttemptUsage">): Usage {
	return message.lastAttemptUsage ?? message.usage;
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * One attached file, as a message records it.
 *
 * A named type rather than the shape written inline, which is what it used to be — in nine places
 * across seven files, because every layer between the composer and the session log restates the
 * option bag it forwards. Two fields were added to the message and reached none of those
 * signatures; the values still flowed (a structural type does not strip anything at runtime), but
 * the next person to write against the type would have dropped them, and the one after that would
 * have had no way to know they existed.
 */
export interface MessageAttachment {
	name: string;
	/** `fileKind` on the desktop side — image, document, archive, text. Purely for the icon. */
	kind?: string;
	mimeType?: string;
	/**
	 * Where the file came from on this machine, when it came from a file at all.
	 *
	 * What it buys: a sent message can still offer to open the spreadsheet it carried, or show it
	 * where it lives. Without it the bubble knows a name and nothing else, so the only honest
	 * thing it can do with a file it is displaying is display it.
	 *
	 * Optional because a good share of attachments never were files. A pasted screenshot, a
	 * region grabbed inside the app — those are pixels in memory with a name invented for them,
	 * and there is nothing on disk to open. Absent is also what every message written before this
	 * field existed looks like, which is the same thing and wants the same treatment: offer
	 * nothing rather than offer something that fails.
	 *
	 * Not a promise that the file is still there. It records where it was at send time; anything
	 * acting on it checks first, because the transcript outlives the file by design.
	 */
	path?: string;
	/**
	 * What it was called on screen — 「图片 1」 for a pasted screenshot whose `name` is the
	 * `image.png` the clipboard invented.
	 *
	 * Kept because the message text refers to it by this name: a draft writes 【图片 1】 where the
	 * file was dropped, and the bubble has to find that mark again to draw it as a label rather
	 * than as a stray pair of brackets. Absent on messages written before labels existed, where
	 * the mark spelled the filename instead — both are still recognised.
	 */
	label?: string;
}

/** Runtime-owned facts carried beside a lossy summary, never extracted from summary text. */
export interface CompactionContext {
	originalRequest?: string;
	latestRequest?: string;
	/** Ordered excerpts of real user messages; rendering has its own window budget. */
	requests?: { ordinal: number; text: string; timestamp: number }[];
	todos?: { content: string; status: "pending" | "in_progress" | "completed" }[];
}

export interface UserMessage {
	role: "user";
	content: UserContent[];
	timestamp: number;
	/** Set when the message was injected by the runtime rather than typed by a human. */
	synthetic?: boolean;
	/** Only runtime-generated compaction heads carry this snapshot. */
	compactionContext?: CompactionContext;
	/** File references survive another compaction without parsing model-written summaries. */
	compactionFiles?: { read: string[]; changed: string[] };
	/** An explicit runtime control discarded the old plan; it did not mark work completed. */
	clearsTaskPlan?: boolean;
	/**
	 * 会话中途改了的 system prompt 段落：段落 id → 新文本，`null` 是这一段没了。
	 *
	 * 存成数据而不是让下一轮去解析正文：正文是写给模型的，措辞会改；而下一轮
	 * 要据此算出「模型此刻以为各段是什么」，重启后也要从日志算出同一个答案。见 `prompt/update.ts`。
	 */
	promptUpdate?: { section: string; text: string | null }[];
	/**
	 * Who sent this, when it was not the person looking at the transcript.
	 *
	 * `child`: a task one of this session's child sessions (the side chat, say) handed over lands
	 * here as an ordinary user message. Without this you would scroll back and find an instruction you have no memory
	 * of writing, in your own voice, with no way to tell where it came from.
	 *
	 * `parent` 是子智能体转录里「派它出去的那个 Agent 说的话」——开头那份任务、续跑时补的那一句。
	 * 面板上它不该画成人发的气泡：那不是看着面板的人说的。
	 *
	 * `plugin` 是代管这个会话的插件转进来的话（Plume 的 `SessionAccess.post`）：外面的人经插件发来的，不是人在输入框里打的。
	 */
	origin?: "child" | "parent" | "plugin";
	/**
	 * `origin` 是 `child` 时，交来这件事的子会话是哪个插件建的（子会话的 `owner`）；是 `plugin` 时，转来它的代管插件。界面按它标出插件的显示名。
	 * 宿主在这件事从队列里发出去时填上；交来它的子会话那时已经删掉了就不带，界面改用通用的说法。
	 */
	fromPlugin?: string;
	/** Clean user input text for UI display, excluding injected skill or session instructions. */
	displayText?: string;
	/** Skill triggered by this prompt, along with its filesystem path for viewing. */
	skillRef?: {
		name: string;
		path?: string;
		pluginId?: string;
	};
	/** Historical sessions referenced by @ in this prompt. */
	sessionRefs?: Array<{
		id: string;
		title: string;
	}>;

	/**
	 * 后台子代理送回来的结果、或后台命令结束的消息——这条消息是运行时替它们递过来的，不是人说的话。
	 *
	 * 人在主会话等子代理的时候插了话，父会话先去回应人，子代理留在后台接着跑；它们跑完之后，结果
	 * 作为这样一条消息回到主会话（见 `runtime/agent-session/delivery-message.ts`）。`content` 是给模型读的报告
	 * 原文；这一项给界面画成一行「谁的结果到了」，而不是一个人发的气泡——那不是人说的话，而报告
	 * 本身在派发卡片和子智能体面板里都看得到。
	 */
	delivery?: DeliveredReport[];
	/**
	 * 另一个会话的模型发来的消息——不是看着这个面板的人说的话。
	 *
	 * `content` 是给模型读的那份（外面套着 `<session-message>`）；这一项给界面画成「来自 X」，
	 * 并让回信的那一方接上同一条链（插件经 `ToolRun.letter` 寄，配对和代答见 `@plume/contract` 的 `LetterReceipt`）。
	 */
	peer?: PeerLetter[];
	/**
	 * 被正在跑的那次运行接了进去，而不是开了一次新的运行。
	 *
	 * 循环把它接进去的那一刻打上（`agent/loop.ts` 的 `takeSteering`），因为只有那里知道它到底进没
	 * 进去：会话忙时收下的话，循环没来得及取的，会排到下一次运行开头，那时它开的是新的一次。界面
	 * 靠它分辨送达是把空闲的会话叫醒了，还是插在一轮中间——后者不是新的一轮。
	 */
	steered?: true;
	/**
	 * 这句话打断了正在跑的那一轮：会话先停下手上的事，再拿它开新的一轮（`AgentSession.prompt` 的
	 * `deliver: "interrupt"`，排队条上的「现在就发」）。
	 *
	 * 只在真的打断了什么时才打上——会话闲着时它就是一句普通的话。发给模型时据此说清楚它是在模型
	 * 工作时说的、上一条回复是被它截断的（`prompt/steering.ts`）；不说的话，模型看到的只是自己写到
	 * 一半的回复后面跟着一条新消息，分不清那半截是被人停下的还是自己断的。
	 */
	interrupting?: true;
	/**
	 * The files that were attached, by name and kind — never their contents.
	 *
	 * A text attachment's body is expanded into the prompt, which is what the model needs and the
	 * last thing a reader wants to scroll past: a thousand-line document arrived as a thousand lines
	 * inside the message bubble, and getting back above it was a chore. `displayText` keeps the
	 * bubble to what was actually typed, and this is what lets it still say which files went with it.
	 *
	 * Metadata only, deliberately. The contents are already in `content`; a second copy here would
	 * double the size of every session log for something no reader ever looks at.
	 */
	attachments?: MessageAttachment[];
}

/**
 * 送达消息里的一份：谁交的、说的是什么事、怎么收场的。界面画成对话里的一行，不是一个人发的气泡；
 * 怎么画由交它的插件定，宿主只认这几个通用字段。
 */
export interface DeliveredReport {
	/** 交它的那一方定的 id（子代理的任务 id、后台命令的任务 id……），界面拿它找回自己那一份。 */
	id: string;
	/** 交这份的插件，宿主照实填：界面交给它登记的那一行画，导出时按 `title` 写。 */
	plugin: string;
	/** 一句话说是什么事；没人接管时界面的默认那一行、导出的 Markdown 都写它。 */
	title: string;
	status: "done" | "failed" | "aborted";
	/** 没做完就停下了（检查点、原地打转、上游出错）——报告是阶段性的。 */
	incomplete?: boolean;
	/** 点了去哪个会话。只有宿主写得出：新会话交回开出它的会话时（`LaunchedSession.reportBack`）填它的 id。 */
	sessionId?: string;
	/**
	 * 插在一轮中间、并进正在做的那段活里，挨着的几份并成一行：后台命令的结果——放到后台的那次调用当场就跑完了，
	 * 结果单独一行等于把同一件事说两遍。不带的照旧自己一行：接下来那段话是就着它说的。
	 */
	inline?: boolean;
	/** 交它的插件自己的数据，宿主不读，原样留着给它画那一行。 */
	details?: unknown;
}

/**
 * 另一个会话发来的一条消息。
 *
 * 请求、通知、答复走同一条路：对方在跑就在两步之间读到，闲着就开一轮。问是发出即返回，请求的答复
 * 由收件方交回，作为一封 `answer` 信送到发件方，收件方没答时由本体代答；通知没有答复。
 */
export interface PeerLetter {
	/** 这一封的 id：本体据此认出读到它的那条消息，代答时从那里往后找回复。 */
	id?: string;
	/** 请求：发件方要一个答复。没有就是通知（或答复）。 */
	request?: true;
	/**
	 * 这是对我问过的请求的答复：`replied` 是对方交回的；`unreplied` 是对方读到请求的那一轮
	 * 收场了却没回，正文是那一轮最后说的话；`dropped` 是请求没被读到就被对方的人停下了；`closed` 是对方会话关了。
	 * 后三种由本体代写，见 `@plume/contract` 的 `LetterReceipt`。
	 */
	answer?: "replied" | "unreplied" | "dropped" | "closed";
	/** 答复对着我发过的哪几封：每封开头一截，按发出的顺序。 */
	re?: string[];
	/** 对方会话的 id，界面据此跳过去。 */
	sessionId: string;
	/** 寄出那一刻对方的地址，`名字 [ref]`；要再找它时原样当作 `to`。 */
	from: string;
	text: string;
	/** 对方的工作目录，跨项目时路径的意思会变，模型要知道是从哪儿说的。 */
	cwd?: string;
	/** 这封信所在的往来链，按经手的会话 id 排；跳数上限由寄信的插件定。 */
	chain?: string[];
}

export interface RequestPrefix {
	/** 这次请求体切成了几段（工具、系统提示词、逐条消息）。 */
	segments: number;
	/** 第一处和上一次不同的段及其前后长度（字符）；没有就是上一次原样是这次的前缀。 */
	change?: { segment: string; before: number; after: number };
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	api: ApiFormat;
	provider: string;
	model: string;
	usage: Usage;
	/**
	 * The final attempt's own usage, set only when failed attempts were folded into `usage`.
	 *
	 * `usage` is the bill, and the bill has to include what abandoned retries cost. The context
	 * window, though, held one request, not their sum, so anything asking "how big was the
	 * conversation" reads this instead — through `requestUsage`. Absent without retries and on
	 * logs written before it existed; `usage` is then that one request.
	 */
	lastAttemptUsage?: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	/**
	 * Whether what ended this was the connection rather than the request.
	 *
	 * A dropped socket and a rejected API key both arrive as `stopReason: "error"`, and only one of
	 * them is worth going back for. Which it was is known exactly once — where the error is caught,
	 * with the cause still attached — and by the time it has been flattened into a message string
	 * telling them apart is pattern-matching on prose. So it is written down while it is still a
	 * fact.
	 */
	errorRetryable?: boolean;
	/**
	 * 这次失败是什么——分类的结果，不是一串给人猜的字符串。
	 *
	 * `errorMessage` 留着是为了读得懂旧会话，但它把一次失败压成了一行字，之后每个想知道「这该不该
	 * 重试」「这句话该怎么说给人听」「有没有下一步可给」的地方，都只能对着那行字做模式匹配。结论
	 * 在 `failure.ts` 里只产生一次，然后一路带着走。
	 */
	failure?: Failure;
	/**
	 * 这次请求体和同一会话上一次相比，前缀从哪里开始不同。缓存未命中的归因证据，见
	 * `ai/prefix-fingerprint.ts`。没有这个字段是没量（旧日志、第一次请求、替身流）。
	 */
	prefix?: RequestPrefix;
	/** Provider response id, used for Responses-API conversation chaining. */
	responseId?: string;
	/** Latency in milliseconds from request start to completion */
	durationMs?: number;
	/** Latency in milliseconds of actual streaming token generation (from first token chunk to completion) */
	sseDurationMs?: number;
	timestamp: number;
}

export interface ToolResultMessage {
	/** Actual execution boundary; absent in historical messages. */
	startedAt?: number;
	durationMs?: number;
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: UserContent[];
	/** Structured payload for rich UI rendering; never sent to the model. */
	details?: unknown;
	/** 只给人看、不交给模型的图（Plume 的 `ToolOutput.shownImages`）：和 `details` 一样不进请求体。 */
	shownImages?: ImageContent[];
	isError: boolean;
	/** See `ToolResult.uneventful`. Carried on the message so compaction can see it. */
	uneventful?: boolean;
	/** See `ToolOutput.instructions`. Carried on the message so compaction can see it. */
	instructions?: boolean;
	/**
	 * See `ToolResult.terminate`. Carried on the message so the loop can see it.
	 *
	 * 和 `details` 一样，只在本进程里活着——不进 provider 的请求体。写进会话日志是无害的：循环只
	 * 看自己这一轮刚拿到的结果，重放历史时没人会再读它。
	 */
	terminate?: boolean;
	/**
	 * 这次调用弹的审批卡或等人给数据的卡，是代管这个会话的插件替人答的（Plume 的 `SessionAccess.respond`、`answer`）：那个插件的名字。
	 * 人自己在卡上答的不带。界面据此在这次调用旁边写明是谁代答的；不进请求体，模型读到的说明写在结果正文里。
	 */
	answeredBy?: string;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
