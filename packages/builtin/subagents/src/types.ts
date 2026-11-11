import type { Message, SessionMessage, ThinkingLevel, TurnStop } from "@plume/contract";
import type { JsonSchema, SchemaMode } from "./yield.ts";

type TaskState = "queued" | "running" | "done" | "failed" | "stopped";

/** 工具卡片只保存定位信息；会变化的状态由插件的登记簿提供。 */
export interface Dispatch {
	id: string;
	session: string;
	parent: string;
	agent: string;
}

/** 派发那一刻的身份：续跑沿用它，中途改了、删了定义也不会让正在干活的子会话换了指令或多出工具。 */
interface Identity {
	prompt: string;
	tools: readonly string[] | "*";
	/** 交回什么样的对象；没有的做完了用正文回答。 */
	output?: JsonSchema;
	schemaMode?: SchemaMode;
	/** 每段几步，见 `checkpoint.ts`；没有的是 60。 */
	maxTurns?: number;
}

export interface TaskRecord extends Dispatch {
	description: string;
	prompt: string;
	identity: Identity;
	state: TaskState;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	attempt: number;
	runId?: string;
	stop?: TurnStop;
	/** 交给父会话的正文：没跑完的说明、`yield` 的对象写成的字，或者它最后说的话。 */
	answer?: string;
	/** 这次运行最后一条回复的时刻：回报卡挂在它下面。 */
	answerTimestamp?: number;
	/** 这次运行经 `yield` 交回的对象，界面按结构画；`warnings` 是用完重试后照收的不合格之处。 */
	output?: Record<string, unknown>;
	warnings?: string[];
	/** 停下了但活没干完（到了检查点、原地打转、服务出错）：父会话和面板都要读得出来，它交的只是一部分。 */
	incomplete?: boolean;
	error?: string;
	reported: boolean;
	resumable: boolean;
	model?: { id: string; name: string };
	thinking?: ThinkingLevel;
	/** 尚未开跑的任务也需要保留派发方交代的完整内容。 */
	pending?: SessionMessage;
}

export interface ModelChoice {
	model?: string;
	thinking?: ThinkingLevel;
}
export type AgentSettings = Record<string, ModelChoice>;

/** 名单里每个人和他写明的脸，界面按它给每个名字排一张不撞的脸。 */
export interface Face {
	name: string;
	avatar?: string;
}

export function isDispatch(value: unknown): value is Dispatch {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return [record.id, record.session, record.parent, record.agent].every((part) => typeof part === "string" && part.length > 0);
}

export function dispatchFromProgress(progress: string | undefined): Dispatch | undefined {
	if (!progress) return undefined;
	try {
		const value: unknown = JSON.parse(progress);
		return isDispatch(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function descriptionOf(args: Record<string, unknown>): string {
	return typeof args.description === "string" ? args.description.trim() : "";
}

export function isActive(task: Pick<TaskRecord, "state">): boolean {
	return task.state === "queued" || task.state === "running";
}

/**
 * 这次运行最后真正说过的话，而不是最后一条消息：停在工具调用上的那一轮没有字，只读最后一条的话，偏偏是被截断、
 * 最值得问「它得出了什么」的那几次答不上来。正文已经重说过一遍的过程播报不算，免得父会话读两遍。
 */
export function lastProse(messages: readonly Message[], since: number): { text: string; timestamp?: number } {
	const produced = messages.slice(since);
	const timestamp = produced.findLast((message) => message.role === "assistant")?.timestamp;
	for (let index = produced.length - 1; index >= 0; index--) {
		const message = produced[index]!;
		if (message.role !== "assistant") continue;
		const final = message.content.some((block) => block.type === "text" && block.phase === "final_answer" && block.text.trim() !== "");
		const text = message.content
			.flatMap((block) => (block.type === "text" && !(final && block.phase === "commentary") ? [block.text] : []))
			.join("\n")
			.trim();
		if (text) return { text, timestamp };
	}
	return { text: "", timestamp };
}

/** 没做完的出路：上下文还在就接着跑，不在了才重派；做完了但没做完活（步数用完）的同样要一条出路。 */
export function wayBack(task: TaskRecord): "resume" | "redispatch" | undefined {
	if (isActive(task)) return undefined;
	if (!task.incomplete && task.state !== "failed" && task.state !== "stopped") return undefined;
	if (task.resumable) return "resume";
	return task.state === "done" ? undefined : "redispatch";
}

/** 去重只认最终报告对应的那条回复，不因其他消息碰巧说了一样的话而隐藏它。 */
export function reportProse(task: TaskRecord, body: string, timestamp: number): string {
	return !isActive(task) && task.answer && timestamp === task.answerTimestamp && task.answer.includes(body.trim()) ? "" : body;
}
