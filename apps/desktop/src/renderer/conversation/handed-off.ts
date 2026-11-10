/**
 * 输入框上方那一条（`HandedOffStrip.tsx`）的数据：这个会话交出去的会话有哪几个、各自此刻在做的那一步。
 *
 * 交出去的会话是 `spawnedFrom` 指回这里的那些：计划交给新会话、建议的新会话、审阅会话，不管是哪个插件开的。
 * 不碰界面，分组和测试直接跑。
 */

import type { AgentEvent, AssistantMessage, SessionSummary } from "@plume/contract";
import type { SessionActivity } from "@plume/contract/ui";
import { useSyncExternalStore } from "react";

type HandedOffState = "running" | SessionActivity;

export interface HandedOff {
	session: SessionSummary;
	state: HandedOffState;
}

/**
 * 从 `parentId` 交出去、此刻值得说一声的会话。在跑、在等人的要说；跑完、出错的留到人点进去看过为止——侧栏的
 * `done`/`failed` 本来就是「你还没看」，打开那个会话时清掉，这一行跟着走。什么也没发生过的不占地方，归档的也不列：
 * 它不在侧栏里了，点过去也是离开。
 */
export function handedOffFrom(
	sessions: readonly SessionSummary[],
	activityOf: (sessionId: string) => SessionActivity | undefined,
	parentId: string,
): HandedOff[] {
	const out: HandedOff[] = [];
	for (const session of sessions) {
		if (session.spawnedFrom?.sessionId !== parentId || session.archived) continue;
		const own = activityOf(session.id);
		// 和侧栏行首同一个次序：等人批准排最前，那是一个会一直等下去的会话。
		const state = own === "waiting" ? own : session.running ? "running" : own;
		if (state) out.push({ session, state });
	}
	return out;
}

type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * 每个会话最近开始的那一步：调用本身，说法在画的时候取（`describeOne`），跟着界面语言和插件登记的说法走。
 *
 * 事件流本来就带着每个会话的事件；哪个会话会被哪一行读，这里不必知道。`toolStart` 只带调用 id，所以先记下写进会话、
 * 还没出结果的调用，开始时按 id 认出是哪一个。一轮停下就清掉，不留一句已经不在做的事。
 */
const pending = new Map<string, Map<string, ToolCallBlock>>();
const doing = new Map<string, ToolCallBlock>();
const listeners = new Set<() => void>();

function changed(): void {
	for (const listener of listeners) listener();
}

function forget(sessionId: string): void {
	pending.delete(sessionId);
	if (doing.delete(sessionId)) changed();
}

export function noteSessionDoing(event: AgentEvent): void {
	switch (event.type) {
		case "message": {
			const { message } = event;
			if (message.role === "assistant") {
				const calls = message.content.filter((block): block is ToolCallBlock => block.type === "toolCall");
				if (calls.length === 0) return;
				const known = pending.get(event.sessionId) ?? new Map<string, ToolCallBlock>();
				for (const block of calls) known.set(block.id, block);
				pending.set(event.sessionId, known);
			} else if (message.role === "toolResult") pending.get(event.sessionId)?.delete(message.toolCallId);
			return;
		}
		case "toolStart": {
			const block = pending.get(event.sessionId)?.get(event.toolCallId);
			if (!block || doing.get(event.sessionId) === block) return;
			doing.set(event.sessionId, block);
			changed();
			return;
		}
		case "rewound":
			forget(event.sessionId);
			return;
		case "sessions": {
			const running = new Set(event.sessions.filter((session) => session.running).map((session) => session.id));
			for (const id of new Set([...pending.keys(), ...doing.keys()])) if (!running.has(id)) forget(id);
			return;
		}
		default:
			return;
	}
}

export function sessionDoing(sessionId: string): ToolCallBlock | undefined {
	return doing.get(sessionId);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

const idle = () => () => undefined;

/** 这个会话最近开始的那一步，随事件更新；`active` 为 false（那边没在跑）时不订阅，返回 undefined。 */
export function useSessionDoing(sessionId: string, active: boolean): ToolCallBlock | undefined {
	return useSyncExternalStore(active ? subscribe : idle, () => (active ? sessionDoing(sessionId) : undefined));
}
