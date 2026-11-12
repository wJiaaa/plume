import type { AssistantMessage, Message, SessionView, ToolResultMessage } from "@plume/contract";
import type { TraceObservation } from "./api.ts";

export type Source =
	| "system"
	| "context"
	| "user"
	| "thinking"
	| "assistant"
	| "tool-call"
	| "tool-result"
	| "subagent"
	| "compaction"
	| "request"
	| "lifecycle"
	| "notice"
	| "approval";
export const SOURCES: Source[] = [
	"system",
	"context",
	"user",
	"thinking",
	"assistant",
	"tool-call",
	"tool-result",
	"subagent",
	"compaction",
	"request",
	"lifecycle",
	"notice",
	"approval",
];
export type Status = "running" | "done" | "error" | "cancelled" | "interrupted";
export interface Entry {
	id: string;
	seq: number;
	turn: number;
	ts: number;
	source: Source;
	summary: string;
	detail?: string;
	input?: string;
	output?: string;
	toolName?: string;
	callId?: string;
	/** 观察到的那次请求：输入（发出去的消息和工具表）打开详情时经 `DiagnosticsApi.request` 取。 */
	requestId?: string;
	status?: Status;
	startedAt?: number;
	finishedAt?: number;
	durationMs?: number;
	provider?: string;
	model?: string;
	usage?: AssistantMessage["usage"];
	metadata?: unknown;
	images?: Array<{ data: string; mimeType: string; media?: string }>;
}

function textOf(message: Message): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function outputPath(entry: Entry): boolean {
	return typeof object(entry.metadata).outputPath === "string";
}
const headline = (text: string) => text.trim().split("\n")[0]?.slice(0, 240) ?? "";
const replyStatus = (reply: AssistantMessage): Status =>
	reply.stopReason === "aborted" ? "cancelled" : reply.stopReason === "error" ? "error" : reply.stopReason === "pending" ? "running" : "done";

/**
 * 轨迹和任务共用同一份调用；缺失的历史耗时不推算，不把等待执行误标为已经完成。
 * `prompts` 是请求里系统提示词的指纹到正文（`DiagnosticSnapshot.prompts`）。
 */
export function entriesOf(view: SessionView, observations: TraceObservation[], prompts: Record<string, string> = {}): Entry[] {
	const entries: Entry[] = [];
	const results = new Map(view.messages.flatMap((message) => (message.role === "toolResult" ? [[message.toolCallId, message] as const] : [])));
	const starts = new Map<string, number>();
	const responses = new Map<string, { reply: AssistantMessage; timestamp: number }>();
	const requested = new Set<number>();
	const notices = new Map<string, Entry>();
	let turn = 0;
	const turns = view.messages.map((message) => {
		if (message.role === "user" && !message.synthetic) turn++;
		return Math.max(1, turn);
	});
	const atTurn = (at: number) => turns[Math.min(at, turns.length - 1)] ?? 1;
	const add = (entry: Omit<Entry, "seq">) => {
		entries.push({ ...entry, seq: entries.length + 1 });
	};
	for (const observation of observations) {
		const { event, timestamp } = observation;
		if (event.type === "toolStart") starts.set(event.toolCallId, event.startedAt);
		if (event.type === "response") {
			responses.set(event.id, { reply: event.reply, timestamp });
			requested.add(event.reply.timestamp);
		}
	}
	for (const [index, message] of [...view.messages, ...(view.draft ? [view.draft] : [])].entries()) {
		const common = { turn: atTurn(index), ts: message.timestamp };
		if (message.role === "user") {
			const source = message.delivery?.length ? "subagent" : message.synthetic ? "context" : "user";
			add({
				...common,
				id: `message:${index}`,
				source,
				summary: headline(message.displayText ?? textOf(message)),
				detail: textOf(message),
				images: message.content.filter((part) => part.type === "image"),
			});
		} else if (message.role === "assistant") {
			if (!requested.has(message.timestamp))
				add({
					...common,
					id: `request:message:${index}`,
					source: "request",
					summary: message.model,
					status: replyStatus(message),
					provider: message.provider,
					model: message.model,
					usage: message.usage,
					durationMs: message.durationMs,
					detail: message.errorMessage,
				});
			message.content.forEach((part, block) => {
				const id = `message:${index}:${block}`;
				if (part.type === "toolCall") {
					const result = results.get(part.id);
					const startedAt = result?.startedAt ?? starts.get(part.id) ?? view.startedAt[part.id];
					const status: Status = result
						? object(result.details).cancelled
							? "cancelled"
							: result.isError
								? "error"
								: "done"
						: view.summary.running
							? "running"
							: "interrupted";
					const subject = part.arguments.description ?? part.arguments.command ?? part.arguments.path ?? part.arguments.pattern ?? part.name;
					add({
						...common,
						id,
						source: "tool-call",
						summary: typeof subject === "string" ? subject : part.name,
						toolName: part.name,
						callId: part.id,
						input: JSON.stringify(part.arguments, null, 2),
						output: result ? textOf(result) : view.progress[part.id],
						metadata: result?.details,
						status,
						startedAt,
						finishedAt: result?.timestamp,
						durationMs: result?.durationMs ?? (startedAt !== undefined && result ? Math.max(0, result.timestamp - startedAt) : undefined),
						images: result?.content.filter((item) => item.type === "image"),
					});
				} else if (part.type === "thinking")
					add({ ...common, id, source: "thinking", summary: headline(part.thinking), detail: part.thinking, durationMs: part.durationMs });
				else add({ ...common, id, source: "assistant", summary: headline(part.text), output: part.text, status: replyStatus(message) });
			});
		} else {
			add({
				...common,
				id: `result:${message.toolCallId}`,
				source: "tool-result",
				summary: message.toolName,
				output: textOf(message),
				metadata: message.details,
				callId: message.toolCallId,
				toolName: message.toolName,
				status: object(message.details).cancelled ? "cancelled" : message.isError ? "error" : "done",
			});
		}
	}
	for (const [index, observation] of observations.entries()) {
		const { event, timestamp, at } = observation;
		const common = { turn: atTurn(Math.max(0, at - 1)), ts: timestamp };
		if (event.type === "request") {
			const response = responses.get(event.id);
			const reply = response?.reply;
			add({
				...common,
				id: `request:${event.id}`,
				requestId: event.id,
				source: "request",
				summary: event.model,
				status: reply
					? replyStatus(reply)
					: view.summary.running && index === observations.findLastIndex((item) => item.event.type === "request")
						? "running"
						: "interrupted",
				startedAt: timestamp,
				finishedAt: response?.timestamp,
				durationMs: reply?.durationMs,
				provider: event.provider,
				model: event.model,
				usage: reply?.usage,
				output: reply ? textOf(reply) : undefined,
				detail: reply?.errorMessage,
				metadata: reply && {
					stopReason: reply.stopReason,
					failure: reply.failure,
					firstTokenMs: reply.durationMs !== undefined && reply.sseDurationMs !== undefined ? reply.durationMs - reply.sseDurationMs : undefined,
				},
			});
			const prompt = prompts[event.systemPrompt];
			if (prompt) add({ ...common, id: `system:${event.id}`, source: "system", summary: headline(prompt), detail: prompt });
		} else if (event.type === "approval" && event.approval) {
			const approval = event.approval;
			notices.set(`approval:${approval.toolCallId}`, {
				...common,
				seq: 0,
				id: `approval:${approval.toolCallId}`,
				source: "approval",
				summary: approval.tool,
				callId: approval.toolCallId,
				metadata: approval,
				status: view.approval?.toolCallId === approval.toolCallId ? "running" : undefined,
			});
		} else if (event.type === "hiccups") {
			for (const hiccup of event.hiccups)
				notices.set(`retry:${hiccup.id}`, {
					...common,
					seq: 0,
					id: `retry:${hiccup.id}`,
					source: "notice",
					summary: hiccup.summary,
					detail: hiccup.detail,
					metadata: hiccup,
					status:
						hiccup.outcome === "waiting"
							? view.summary.running
								? "running"
								: "interrupted"
							: hiccup.outcome === "recovered"
								? "done"
								: hiccup.outcome === "stopped"
									? "cancelled"
									: "error",
				});
		} else if (event.type === "notice")
			add({
				...common,
				id: `notice:${index}`,
				source: "notice",
				summary: event.text,
				detail: event.text,
				status: event.level === "error" || event.level === undefined ? "error" : undefined,
			});
		else if (event.type === "running")
			add({ ...common, id: `lifecycle:${index}`, source: "lifecycle", summary: "", status: event.running ? undefined : "done" });
	}
	entries.push(...notices.values());
	for (const run of view.compactionRuns)
		add({
			id: `compaction:${run.id}`,
			turn: atTurn(run.at),
			ts: run.startedAt,
			source: "compaction",
			summary: run.input ?? "",
			status: run.status === "failed" ? "error" : run.status === "skipped" ? "done" : run.status,
			detail: run.error,
			metadata: run,
		});
	return entries.sort((a, b) => a.ts - b.ts || a.seq - b.seq).map((entry, index) => ({ ...entry, seq: index + 1 }));
}

const searchIndex = new WeakMap<Entry, string>();
export function filterEntries(entries: Entry[], query: string, status = "", sources: Source[] = []): Entry[] {
	const needle = query.trim().toLocaleLowerCase();
	return entries.filter((entry) => {
		if ((status && entry.status !== status) || (sources.length && !sources.includes(entry.source))) return false;
		if (!needle) return true;
		let text = searchIndex.get(entry);
		if (text === undefined) {
			text = JSON.stringify(entry).toLocaleLowerCase();
			searchIndex.set(entry, text);
		}
		return text.includes(needle);
	});
}

export function latestTodos(messages: Message[]): Array<{ content: string; status: "pending" | "in_progress" | "completed" }> {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "toolResult" || message.isError) continue;
		// 清单按结果里的通用声明认（`ChecklistDetails`），不认是哪个工具交的。
		const details = object(message.details);
		if (!Array.isArray(details.checklist)) continue;
		return details.checklist.flatMap((item: unknown) => {
			const todo = object(item);
			return typeof todo.content === "string" && (todo.status === "pending" || todo.status === "in_progress" || todo.status === "completed")
				? [{ content: todo.content, status: todo.status }]
				: [];
		});
	}
	return [];
}

export function jobCall(messages: Message[], id: string): ToolResultMessage | undefined {
	return messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && [object(message.details).jobId, object(message.details).id].includes(id),
	);
}
