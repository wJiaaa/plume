/**
 * 转录里每一行要问的外部状态，和转录自己的展示状态。
 *
 * 外部状态由转录的根放进上下文，各行自己取，不经一层层的 props 往下传，按变得多勤分三份：这是哪个会话、工作目录、能不能发
 * （`Transcript`，几乎不变）；这一轮在不在跑、每次调用的结果、正在等谁确认（`TranscriptCalls`，每来一条消息）；执行中的输出
 * （`TranscriptLive`，每一段输出）。后两份是仓库，各行只订阅自己那几次调用。
 *
 * 展示状态按会话记、不跟着 DOM 和消息走：挂载了哪一段历史、哪些思考和工具组被点开过。最多记 12 个会话。
 */

import type { ToolResultMessage } from "@plume/contract";
import { createContext, useContext, useRef, useState, useSyncExternalStore } from "react";

export interface TranscriptState {
	sessionId: string;
	cwd: string;
	/** 这是插件的子会话（侧边聊天、子 Agent）：卡片上能把事交给它的父会话（`ToolCardProps.handToParent`）。 */
	child?: boolean;
	/** 当前视图允许用户向此会话发送正文；只读子会话不提供。 */
	send?: (text: string, displayText?: string) => Promise<void>;
}

/**
 * 每次调用的结果、在不在跑、正在等谁确认。来一条消息就换一份，所以不放进 `Transcript`：放进去的话每来一个工具结果，
 * 窗口里每一行都绕过 memo 重画一遍。各处经 `useCalls` 只取自己那几次调用的，取出来的没变就不重画。
 */
export interface CallState {
	running: boolean;
	results: ReadonlyMap<string, ToolResultMessage>;
	/** 这个会话里放到后台的命令，按任务 id：启动它的那次调用写的说明和命令。查输出那一行说的是它（`describePolls`）。 */
	jobs: ReadonlyMap<string, BackgroundJobInfo>;
	/** 正在等人确认的那次调用。 */
	approval?: string;
}

export interface BackgroundJobInfo {
	description?: string;
	command?: string;
}

/**
 * 执行中的调用此刻的输出和开始时刻。每来一段输出都变，所以不放进 `Transcript`：放进去的话一条命令每打一行字，转录里每一张
 * 工具卡、每一段活都要重画一遍。每张卡经 `useCallLive` 只订阅自己那一次调用。
 */
export interface CallLive {
	progress: Readonly<Record<string, string>>;
	/** 正在执行的调用开始的时刻；排着还没轮到的没有。 */
	startedAt: Readonly<Record<string, number>>;
}

interface Store<T> {
	get(): T;
	set(next: T): void;
	subscribe(listener: () => void): () => void;
}

export type CallLiveStore = Store<CallLive>;

/**
 * 调用状态的仓库。新的一份在转录画子行之前就换上（`stage`），不等布局阶段：这一次新挂上的行（换了会话、翻出更早的轮）
 * 读到的是这一份——读到上一个会话的结果，「刚跑完」的卡会在换会话时一齐弹一下。没跟着重画的行等布局阶段 `flush` 才收到通知。
 */
export interface CallStateStore extends Store<CallState> {
	stage(next: CallState): void;
	flush(): void;
}

function createStore<T>(initial: T, same: (a: T, b: T) => boolean = Object.is): Store<T> {
	let current = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => current,
		set(next) {
			if (same(next, current)) return;
			current = next;
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export function createCallLive(initial: CallLive): CallLiveStore {
	return createStore(initial, (a, b) => a.progress === b.progress && a.startedAt === b.startedAt);
}

export function createCallState(initial: CallState): CallStateStore {
	let current = initial;
	let told = initial;
	const listeners = new Set<() => void>();
	const flush = () => {
		if (told === current) return;
		told = current;
		for (const listener of listeners) listener();
	};
	return {
		get: () => current,
		stage(next) {
			current = next;
		},
		flush,
		set(next) {
			current = next;
			flush();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export const TranscriptLive = createContext<CallLiveStore | null>(null);

/** 一次调用此刻的输出和开始时刻；只有这一次变了才重画。 */
export function useCallLive(id: string): { progress: string | undefined; startedAt: number | undefined } {
	const store = useContext(TranscriptLive);
	// i18n-exempt：写错了才会走到的开发者报错。
	if (!store) throw new Error("useCallLive 只能用在转录里");
	const progress = useSyncExternalStore(store.subscribe, () => store.get().progress[id]);
	const startedAt = useSyncExternalStore(store.subscribe, () => store.get().startedAt[id]);
	return { progress, startedAt };
}

export const TranscriptCalls = createContext<CallStateStore | null>(null);

/**
 * 从调用状态里取这一行要的那几样，取出来的和上次 `same` 就不重画。`pick` 可以每次渲染都是新的函数；取出来的数组、对象按 `same` 比，
 * 默认按引用比，只适合取 Map 里原有的对象或原始值。
 */
export function useCalls<T>(pick: (calls: CallState) => T, same: (a: T, b: T) => boolean = Object.is): T {
	const store = useContext(TranscriptCalls);
	// i18n-exempt：写错了才会走到的开发者报错。
	if (!store) throw new Error("useCalls 只能用在转录里");
	const last = useRef<{ value: T } | null>(null);
	return useSyncExternalStore(store.subscribe, () => {
		const value = pick(store.get());
		if (last.current && same(last.current.value, value)) return last.current.value;
		last.current = { value };
		return value;
	});
}

/** 两个数组逐项相同。 */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
}

export const Transcript = createContext<TranscriptState | null>(null);

export function useTranscript(): TranscriptState {
	const value = useContext(Transcript);
	// i18n-exempt：写错了才会走到的开发者报错。
	if (!value) throw new Error("useTranscript 只能用在转录里");
	return value;
}

/** 一次调用此刻的样子。没有结果的调用：参数还在写的是 `pending`；这一轮已经停了的是记录丢了，算出错。 */
export type CallStatus = "pending" | "approval" | "running" | "done" | "error";

export function callStatus(calls: CallState, id: string, stopReason: string): CallStatus {
	if (calls.approval === id) return "approval";
	const result = calls.results.get(id);
	if (result) return result.isError ? "error" : "done";
	if (stopReason === "pending") return "pending";
	return stopReason === "toolUse" && calls.running ? "running" : "error";
}

/** 结果出错是因为人按了停，不是失败：两处停下的地方都在 `details.cancelled` 上说。 */
export function stoppedByUser(result: ToolResultMessage | undefined): boolean {
	return result?.isError === true && (result.details as { cancelled?: unknown } | undefined)?.cancelled === true;
}

interface View {
	windowSize?: number;
	windowEnd?: number | undefined;
	expanded: Set<string>;
}

const views = new Map<string, View>();
const LIMIT = 12;

function viewFor(id: string): View {
	const view = views.get(id) ?? { expanded: new Set<string>() };
	views.delete(id);
	views.set(id, view);
	while (views.size > LIMIT) {
		const oldest = views.keys().next();
		if (!oldest.done) views.delete(oldest.value);
	}
	return view;
}

/**
 * 一次挂载多少轮、每次「显示更早」多放出多少——**按轮计**。
 *
 * 按行计的话，往一轮几百次调用的回合里翻页，多放出来的行全落进一个收着的块，屏幕上只有一个数字在变。
 * 按轮计，翻一次必然多出整轮，必然看得见。
 */
export const WINDOW_TURNS = 20;

export function useTranscriptWindow(id: string, step: number, total: number) {
	const view = viewFor(id);
	const [local, setLocal] = useState<{ id: string; size: number; end: number | undefined }>({ id, size: view.windowSize ?? step, end: view.windowEnd });
	const current = local.id === id ? local : { size: view.windowSize ?? step, end: view.windowEnd };
	const end = Math.min(total, current.end ?? total);
	const start = Math.max(0, end - current.size);
	const update = (size: number, end?: number) => {
		Object.assign(viewFor(id), { windowSize: size, windowEnd: end });
		setLocal({ id, size, end });
	};
	return {
		start,
		end,
		earlier: () => update(current.size + step, current.end),
		later: () => update(current.size + step, end + step >= total ? undefined : end + step),
		// 回到末尾时不扔掉已经挂上的轮：缩回 `step` 会在发消息时卸掉长转录的上半截，视口先掉几百像素再滑回来。
		latest: () => update(Math.max(step, current.size), undefined),
		/** 让第 `index` 块挂上：问题导航跳到一问旧的。只挂它附近的一窗，不把它到末尾之间的每一轮都挂上。 */
		reveal: (index: number) => {
			if (index >= start && index < end) return;
			const nextEnd = Math.min(total, Math.max(step, index + step - 5));
			update(step, nextEnd === total ? undefined : nextEnd);
		},
	};
}

/** 点开过的东西变了就叫各处重读：转录自己也会替人点开（`expandInTranscript`），各处不能只信自己记的那份。 */
const disclosureListeners = new Set<() => void>();
const subscribeDisclosure = (listener: () => void) => {
	disclosureListeners.add(listener);
	return () => {
		disclosureListeners.delete(listener);
	};
};

function setExpanded(id: string, key: string, open: boolean): void {
	const view = viewFor(id);
	if (view.expanded.has(key) === open) return;
	if (open) view.expanded.add(key);
	else view.expanded.delete(key);
	for (const listener of disclosureListeners) listener();
}

/** 替人点开这个会话里的一处：要摆到人面前的调用收在一段活里时（`ui.revealToolCall`），先把那一段点开。 */
export function expandInTranscript(sessionId: string, key: string): void {
	setExpanded(sessionId, key, true);
}

/** 一处可以点开的东西开着没有，按会话记住：切走再切回来，点开过的还开着。不在转录里（没有会话）的只记在自己身上。 */
export function useTranscriptDisclosure(key?: string): [boolean, (update: (open: boolean) => boolean) => void] {
	const id = useContext(Transcript)?.sessionId ?? null;
	const scoped = key && id ? id : null;
	const remembered = useSyncExternalStore(subscribeDisclosure, () => Boolean(scoped && key && views.get(scoped)?.expanded.has(key)));
	const [local, setLocal] = useState(false);
	const open = scoped ? remembered : local;
	return [
		open,
		(update) => {
			const next = update(open);
			if (scoped && key) setExpanded(scoped, key, next);
			else setLocal(next);
		},
	];
}
