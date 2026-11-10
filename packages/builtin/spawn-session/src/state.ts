/**
 * 界面入口两份共用的状态：开始了的建议（逻辑入口说的，按对话记）和人收起了哪几条。对话里的卡片、环境卡片那一节、开关上的圆点
 * 读的是同一份，所以在一处点了开始、收起，三处一起变。
 */

import type { Remote } from "@plume/contract/ui";
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
export function connect(remote: Remote<SpawnSessionApi>): void {
	api = remote;
}

const EMPTY: StartedSuggestion[] = [];
const started = new Map<string, StartedSuggestion[]>();
/** 正在问的：几张卡片同时挂上时只问一次。 */
const asking = new Map<string, Promise<void>>();

/** 再问一遍 `parentId` 里开始了哪几条。 */
export function refreshStarted(parentId: string): Promise<void> {
	const existing = asking.get(parentId);
	if (existing || !api) return existing ?? Promise.resolve();
	const pending = api
		.started(parentId)
		.then(
			(list) => {
				started.set(parentId, list);
				emit();
			},
			() => undefined,
		)
		.finally(() => asking.delete(parentId));
	asking.set(parentId, pending);
	return pending;
}

/** `parentId` 里开始了的建议；挂上时问一次。 */
export function useStarted(parentId: string): StartedSuggestion[] {
	const list = useSyncExternalStore(subscribe, () => started.get(parentId) ?? EMPTY);
	useEffect(() => {
		void refreshStarted(parentId);
	}, [parentId]);
	return list;
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
