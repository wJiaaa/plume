import { isAbsolute } from "node:path";
import type {
	ApprovalDecision,
	AssistantMessage,
	Hiccup,
	Message,
	MessageAttachment,
	OutgoingMessage,
	PendingRequest,
	SessionSummary,
	TurnStop,
	UserContent,
	UserMessage,
} from "@plume/contract";
import type { ModelConfig } from "@plume/llm/types";
import { RepetitionWatch, type ContextRecord, type SentRequest } from "@plume/loop";
import { text } from "../i18n.ts";
import { MEDIA_NAME } from "../media.ts";
import type { StoredSettings } from "../models.ts";

/** 内存里的一个会话：`messages` 是 undefined 时用到才从库里读（见 `messagesOf`），`record` 同样。 */
export function newSession(summary: SessionSummary, messages: Message[] | undefined, record?: ContextRecord): Session {
	return {
		summary,
		messages,
		...(record ? { record } : {}),
		progress: new Map(),
		startedAt: new Map(),
		hiccups: [],
		repetition: new RepetitionWatch(),
	};
}

/** 插件给的会话标题：压成一行、最长 80 字；不是字符串时是空串。 */
export function oneLineTitle(title: unknown): string {
	return typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * 界面送来的消息，收成会话里的一条用户消息。界面是自己人，但这是进程边界：形状不对的块丢掉，不让一个坏块弄坏整份会话。
 * 附件的 `path` 只认绝对路径，它以后会被拿去打开、在访达里显示。
 */
export function userMessage(input: OutgoingMessage): UserMessage {
	const content: UserContent[] = [];
	for (const block of Array.isArray(input?.content) ? input.content : []) {
		if (block?.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
		else if (block?.type === "image" && typeof block.data === "string" && block.data && IMAGE_TYPES.has(block.mimeType)) {
			content.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else if (block?.type === "image" && typeof block.media === "string" && MEDIA_NAME.test(block.media) && IMAGE_TYPES.has(block.mimeType)) {
			// 编辑重发带回的是会话里已经存着的那张：只给名字，像素在 session-media 里，发给模型前读回来。
			content.push({ type: "image", data: "", mimeType: block.mimeType, media: block.media });
		}
	}
	if (!content.some((block) => block.type === "image" || block.text.trim())) throw new Error(text("session.emptyMessage"));
	const attachments: MessageAttachment[] = [];
	for (const item of Array.isArray(input.attachments) ? input.attachments : []) {
		if (typeof item?.name !== "string") continue;
		attachments.push({
			name: item.name,
			...(typeof item.kind === "string" ? { kind: item.kind } : {}),
			...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
			...(typeof item.path === "string" && isAbsolute(item.path) ? { path: item.path } : {}),
			...(typeof item.label === "string" ? { label: item.label } : {}),
		});
	}
	return {
		role: "user",
		content,
		timestamp: Date.now(),
		...(typeof input.displayText === "string" ? { displayText: input.displayText } : {}),
		...(attachments.length > 0 ? { attachments } : {}),
		...(Array.isArray(input.sessionRefs)
			? { sessionRefs: input.sessionRefs.filter((ref) => typeof ref?.id === "string" && typeof ref.title === "string").map(({ id, title }) => ({ id, title })) }
			: {}),
		...(input.synthetic === true ? { synthetic: true } : {}),
		...(input.interrupt === true ? { interrupting: true } : {}),
	};
}

export interface Session {
	summary: SessionSummary;
	messages: Message[] | undefined;
	draft?: AssistantMessage;
	/** 观察者（`SessionObservation` 的 draft）看过快照、还没作废也没落进会话的那次请求的 id，见 `observeDraft`。 */
	observedDraft?: string;
	/** 在等人答的审批，按问的先后：第一张弹给人，其余排着，见 `askUser`。 */
	approvals?: PendingApproval[];
	progress: Map<string, string>;
	/** 正在执行的调用开始的时刻。 */
	startedAt: Map<string, number>;
	/** 这一轮里连接出的岔子，见 `Hiccup`。 */
	hiccups: Hiccup[];
	/** 压缩和被剪掉的结果（会话库 `sessions` 行上的 `context`），和消息一起按需读进来。 */
	record?: ContextRecord;
	compacting?: boolean;
	/** 上一次发出去的主请求，压缩从它分叉，见 `SentRequest`。 */
	sent?: SentRequest;
	/** 一轮收尾后的压缩占着的控制器（`compactIdle`）：这时发来的话不算撞上正在跑的一轮，停下它接着开新的一轮。 */
	idleHold?: AbortController;
	/** 已通知完成的那次收尾，自动压缩再次放开控制器时不重复。 */
	idleStop?: TurnStop;
	/** 同一个调用反复得到同样的结果，见 `repetition.ts`。只在内存里：重开应用后从头数。 */
	repetition: RepetitionWatch;
	/** 最近读到的项目层供本会话重试使用，不与其他会话共用。 */
	projectLayer?: Record<string, unknown>;
	projectRead?: Promise<StoredSettings>;
	projectNotices?: string;
	/** 上一次主请求之后历史被有意改写过（压缩、剪枝、撤回）：下一条回复记账时归因缓存未命中用，见 `diagnoseCache`。 */
	cacheBoundary?: "compaction" | "rewind";
	/**
	 * 占着这个会话的那件事：一轮（`runTurn`）、`/compact`、一轮收尾后的压缩（`compactIdle`）。`controller` 停它，`turn` 是它收场的结果，
	 * 两个一起设、一起清（`release`），所以「会话在不在忙」只看 `held`，不另看 `turn`、`summary.running`。
	 * 在忙时分几段，各由一个字段认出：循环在跑、还来取插话（`looping`，见 `looping()`），收尾后的压缩（`idleHold`），
	 * 其余是 `/compact` 或被打断、停下后正在收尾（`begin` 开的下一轮等的就是这时的 `turn`）。
	 */
	controller?: AbortController;
	turn?: Promise<TurnStop>;
	/**
	 * 正在跑、还会在下一次请求前来取插话的那一轮（`runTurn` 开头记下它的控制器，收尾时清掉）。和 `controller` 不是一回事：
	 * 收尾的压缩、`/compact`、被打断后还没收完尾的那一轮也占着控制器，那时候没有循环来取，插进去的话就没人收。
	 */
	looping?: AbortController;
	steering?: UserMessage[];
	/** 明确停止后，只有用户的新一轮能重新允许后台派发。 */
	stopped?: boolean;
	/** 应用正在退出：这时停下的一轮记成「被中断」，不是人按的停。 */
	quitting?: boolean;
	/** 正在发的请求在听换模型（`StreamTurn.onSwitch`）：人换了会话的模型时叫它们，带上换成的那个。 */
	switching?: Set<(to: Pick<ModelConfig, "id" | "name">) => void>;
	/** 这一轮（记的是它的控制器）里有工具要求收场后归档，见 `ToolRun.archiveAfterTurn`。 */
	archiveAfterTurn?: AbortController;
	/**
	 * 它被别的会话的信、开出来的会话的交回接连叫起了几轮，人一开口就清零（见 `wakeReports`，`LetterReceipt`）。只在内存里。
	 */
	autoWakes?: number;
	/** 代管插件替人答了的卡：调用 id → 那个插件。调用收场时取走，记进结果的 `answeredBy`（见 `tool-run.ts` 的 `relayed`）。 */
	answeredBy?: Map<string, string>;
	/** 经 `ctx.sessions.launch` 开出它、还在等它第一次真闲下来（`LaunchedSession.idle`）的插件：这期间它收得到这个会话的观察，见 `concerned`。 */
	launchedBy?: string;
}

/**
 * 一张卡怎么收场的：人答了审批、交回了数据，或者没人答（到时、停下）。`by` 是替人答它的代管插件（`SessionAccess.respond`、`answer`），
 * 人自己答的不带。
 */
export type Settled = { decision: ApprovalDecision; by?: string } | { value: unknown; by?: string } | { gone: "expired" | "stopped" };

/** 排着等人的一张卡：审批（`ask`）或等人给数据（`request`）。 */
export interface PendingApproval {
	request: PendingRequest;
	settle(outcome: Settled): void;
}
