/**
 * 界面入口两份共用的状态：从对话派生出来的关联会话（逻辑入口说的，按对话记）和人收起了哪几条。
 * 对话里的建议卡、offer 行、环境卡片的「关联会话」分组读的是同一份，订阅会话摘要/删除变化后自动刷新，
 * 无论通过建议卡、直接开、offer、移交、计划、侧边聊天还是分叉开出，也不管运行、停止还是完成都保持同步。
 */

import type { Remote, SessionActivity, UiContext } from "@plume/contract/ui";
import { useEffect, useSyncExternalStore } from "react";
import type { SpawnSessionApi, StartedSuggestion } from "./api.ts";

const listeners = new Set<() => void>();
function emit(): void {
	for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

let api: Remote<SpawnSessionApi> | undefined;
const EMPTY: StartedSuggestion[] = [];
const started = new Map<string, StartedSuggestion[]>();
/** 正在问的：几张卡片同时挂上时只问一次。 */
const asking = new Map<string, Promise<void>>();
/** 请求在路上时又来了新变化：这一趟回来后再问一次。 */
const dirty = new Set<string>();
/** 当前有组件挂载在读的父会话 id 及其计数，只在会话列表变化时刷新它们。 */
const watched = new Map<string, number>();

function sameList(a: readonly StartedSuggestion[] | undefined, b: readonly StartedSuggestion[]): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const left = a[i]!;
		const right = b[i]!;
		if (
			left.sessionId !== right.sessionId ||
			left.callId !== right.callId ||
			left.title !== right.title ||
			left.createdAt !== right.createdAt ||
			left.running !== right.running ||
			left.background !== right.background ||
			left.stopReason !== right.stopReason ||
			left.archived !== right.archived
		)
			return false;
	}
	return true;
}

export function connect(remote: Remote<SpawnSessionApi>, ui: Pick<UiContext, "onSessionsChanged" | "effect">): void {
	api = remote;
	const stop = ui.onSessionsChanged((event) => {
		if (event.type !== "summary" && event.type !== "deleted") return;
		for (const parentId of watched.keys()) void refreshStarted(parentId);
	});
	ui.effect(() => {
		stop();
		api = undefined;
		started.clear();
		asking.clear();
		dirty.clear();
		watched.clear();
		listeners.clear();
	});
}

/** 再问一遍 `parentId` 下全部关联会话。 */
export function refreshStarted(parentId: string): Promise<void> {
	if (!api) return Promise.resolve();
	const existing = asking.get(parentId);
	if (existing) {
		dirty.add(parentId);
		return existing;
	}
	const currentApi = api;
	const pending = currentApi
		.started(parentId)
		.then(
			(list) => {
				if (api !== currentApi) return;
				if (!sameList(started.get(parentId), list)) {
					started.set(parentId, list);
					emit();
				}
			},
			() => undefined,
		)
		.finally(() => {
			asking.delete(parentId);
			if (dirty.delete(parentId) && api === currentApi) void refreshStarted(parentId);
		});
	asking.set(parentId, pending);
	return pending;
}

/** `parentId` 下的全部关联会话；挂上时问一次，随后随会话摘要/删除事件自动刷新。 */
export function useStarted(parentId: string): StartedSuggestion[] {
	const list = useSyncExternalStore(subscribe, () => started.get(parentId) ?? EMPTY);
	useEffect(() => {
		watched.set(parentId, (watched.get(parentId) ?? 0) + 1);
		void refreshStarted(parentId);
		return () => {
			const count = (watched.get(parentId) ?? 1) - 1;
			if (count <= 0) watched.delete(parentId);
			else watched.set(parentId, count);
		};
	}, [parentId]);
	return list;
}

/** 环境卡片里一条关联会话此刻该显什么状态：停下、跑完、出错、归档都一直留着，不随停止或看过消失。 */
export type EnvironmentStatus = "running" | "waiting" | "done" | "stopped" | "failed" | "archived" | "started";

export function environmentStatus(entry: StartedSuggestion, activity: SessionActivity | undefined): EnvironmentStatus {
	if (entry.archived) return "archived";
	if (activity === "waiting") return "waiting";
	if (entry.running || entry.background) return "running";
	if (entry.stopReason === "aborted") return "stopped";
	if (entry.stopReason === "error" || entry.stopReason === "max_turns" || entry.stopReason === "stalled") return "failed";
	if (entry.stopReason === "done") return "done";
	if (activity === "done" || activity === "failed") return activity;
	return "started";
}

/**
 * 收起只是这台机器上的事：建议还在记录里。按调用 id 记在 localStorage，远多于一个对话会提的条数，超过就忘掉最早的。
 */
const DISMISSED_KEY = "plume.sessionSuggestions.dismissed";
const DISMISSED_KEEP = 200;

function readDismissed(): string[] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

let dismissed: string[] | undefined;

export function useDismissed(): string[] {
	return useSyncExternalStore(subscribe, () => (dismissed ??= readDismissed()));
}

export function dismiss(callId: string): void {
	const ids = [...(dismissed ??= readDismissed()).filter((one) => one !== callId), callId].slice(-DISMISSED_KEEP);
	dismissed = ids;
	emit();
	try {
		localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
	} catch {
		// 存不下就只在这次窗口里收起。
	}
}
