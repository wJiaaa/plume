/**
 * 一个项目目录现在检出在哪：是不是仓库、在哪个分支、是不是正在切换。
 *
 * 分支签、改动计数和 Git 面板是各自挂着的组件，彼此看不到对方的状态，却说的是同一件事。放在这里共用一份：
 * 分支签切了分支，面板当场换成占位重读；改动计数每次读数都顺带知道当前分支，终端里、agent 切的分支也就跟上了。
 * 模块级、不存盘：只是这个窗口眼下知道的。
 */

import { useEffect, useReducer } from "react";
import { git } from "./remote.ts";

export interface Checkout {
	repo: boolean;
	branch: string | null;
	/** git 答不上来的原因。 */
	problem?: string;
}

const known = new Map<string, Checkout>();
/** 正在切换的目录：分支签照着它闪动，名字先不换。 */
const switching = new Set<string>();
const reading = new Map<string, Promise<void>>();
const listeners = new Set<(cwd: string) => void>();

function changed(cwd: string): void {
	for (const listener of listeners) listener(cwd);
}

/** 问一次 git；同一时刻同一个目录只问一次。 */
export function readCheckout(cwd: string): Promise<void> {
	const inflight = reading.get(cwd);
	if (inflight) return inflight;
	const flight = git()
		.probe(cwd)
		.then(
			(probe) => setCheckout(cwd, { repo: probe.repo, branch: probe.branch, ...(probe.problem ? { problem: probe.problem } : {}) }),
			() => {},
		)
		.finally(() => reading.delete(cwd));
	reading.set(cwd, flight);
	return flight;
}

function setCheckout(cwd: string, next: Checkout): void {
	const held = known.get(cwd);
	if (held && held.repo === next.repo && held.branch === next.branch && held.problem === next.problem) return;
	known.set(cwd, next);
	changed(cwd);
}

/** 别处读到了当前分支（改动计数的每次读数）：变了才叫醒大家。 */
export function noteBranch(cwd: string, branch: string | null): void {
	const held = known.get(cwd);
	if (held && held.branch === branch) return;
	setCheckout(cwd, { repo: true, branch });
}

export function setSwitching(cwd: string, on: boolean): void {
	if (on) switching.add(cwd);
	else switching.delete(cwd);
	changed(cwd);
}

/** 这个目录眼下知道的样子；还没问过就去问。 */
export function useCheckout(cwd: string | null): (Checkout & { switching: boolean }) | null {
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (!cwd) return;
		const listener = (at: string) => {
			if (at === cwd) rerender();
		};
		listeners.add(listener);
		if (!known.has(cwd)) void readCheckout(cwd);
		return () => void listeners.delete(listener);
	}, [cwd]);
	const held = cwd ? known.get(cwd) : undefined;
	return held && cwd ? { ...held, switching: switching.has(cwd) } : null;
}
