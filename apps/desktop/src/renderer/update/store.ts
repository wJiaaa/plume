/**
 * 界面这边知道的更新情况，整个窗口一份。
 *
 * 角标和设置 › 关于画的是同一个版本、同一个下载、同一组按钮，各自一个 hook 就是两份定时检查、两份订阅、两份很快对不上的
 * `info`。所以状态放在模块里，组件订阅。`phase` 其实归主进程，这里是它上次说的话的缓存。
 *
 * 自动检查的间隔只在界面里用，记在 localStorage 里（和侧栏、转录的显示偏好一样）。
 */

import { useSyncExternalStore } from "react";
import type { UpdateInfo, UpdatePhase } from "../../shared/update.ts";

export interface UpdateState {
	info: UpdateInfo | null;
	phase: UpdatePhase;
	/** 人点的那次检查，按钮好说自己在忙；定时的不算。 */
	checking: boolean;
}

/** 设置 › 关于里能选的间隔（小时），和那里的选项一致。 */
const INTERVAL_HOURS = new Set([1, 4, 6, 8, 12, 24]);
const DEFAULT_INTERVAL_HOURS = 6;
const INTERVAL_KEY = "plume.update.intervalHours";

// 每次变化换一个新对象、不改旧的：useSyncExternalStore 按引用比快照。
let snapshot: UpdateState = { info: null, phase: { at: "idle" }, checking: false };
const listeners = new Set<() => void>();

function set(next: Partial<UpdateState>): void {
	snapshot = { ...snapshot, ...next };
	for (const listener of listeners) listener();
}

/**
 * 冒烟经它把 `info`、`phase` 直接放进来：拍角标和对话框的各个阶段不需要真去 GitHub 下两百兆。
 * 加载时就挂上，脚本能在第一个订阅者之前调。
 */
(window as Window & { __plumeUpdatePreview?: typeof set }).__plumeUpdatePreview = set;

/** 问主进程最新的 release。`force` 跳过它半小时的缓存：人按了「检查更新」却拿到缓存的回答，等于什么都没告诉他。 */
export async function check(force = false): Promise<void> {
	if (force) set({ checking: true });
	try {
		const info = await window.plume.updates.check(force);
		// 查不了（`checked: false`）不是「更新没了」：拿它覆盖会让没网的人一点角标，角标和里面的对话框就一起消失。
		if (info.checked || !snapshot.info?.available) set({ info });
	} catch {
		// 检查是应用自己的事，失败不打扰人。
	} finally {
		if (force) set({ checking: false });
	}
}

let interval = readInterval();
let timer: number | null = null;
const intervalListeners = new Set<() => void>();

function readInterval(): number {
	try {
		const saved = Number(localStorage.getItem(INTERVAL_KEY));
		return INTERVAL_HOURS.has(saved) ? saved : DEFAULT_INTERVAL_HOURS;
	} catch {
		return DEFAULT_INTERVAL_HOURS;
	}
}

function restartTimer(): void {
	if (timer !== null) window.clearInterval(timer);
	timer = window.setInterval(() => void check(), interval * 60 * 60 * 1000);
}

export function setCheckInterval(hours: number): void {
	interval = hours;
	localStorage.setItem(INTERVAL_KEY, String(hours));
	if (started) restartTimer();
	for (const listener of intervalListeners) listener();
}

export function useCheckInterval(): number {
	return useSyncExternalStore(
		(listener) => {
			intervalListeners.add(listener);
			return () => intervalListeners.delete(listener);
		},
		() => interval,
	);
}

let started = false;

/**
 * 第一个订阅者开始，之后一直开着：定时器和订阅跟窗口同寿，最后一个组件卸掉时拆掉的话，下载就在没人听的情况下跑。
 * 先问一次当前阶段：进行中的下载到下一块数据之前不说话，暂停着的永远不说话，只听不问会在进行中的下载上画一个空闲的角标。
 */
function start(): void {
	if (started) return;
	started = true;
	void check();
	restartTimer();
	void window.plume.updates
		.state()
		.then((phase) => set({ phase }))
		.catch(() => {});
	window.plume.updates.onProgress((phase) => set({ phase }));
}

function subscribe(listener: () => void): () => void {
	start();
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 角标、对话框和设置 › 关于画的一切，从这一处来。 */
export function useUpdate(): UpdateState {
	return useSyncExternalStore(subscribe, () => snapshot);
}
