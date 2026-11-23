import { DURATION, EASING, motionReduced } from "@plume/ui";
import { type RefObject, useLayoutEffect, useRef } from "react";

interface Widths {
	box: HTMLElement;
	columns: HTMLTableColElement[];
	last: number[] | null;
	animations: Animation[];
	reset: unknown;
}

/** 流式块按自然宽度排版，变宽时从上一帧缓过去；静态块挂上时不测量、不播放。表格同时缓每列，避免后面的列被新字突然推走。 */
export function useGrowingWidth(ref: RefObject<HTMLElement | null>, value: unknown, active: boolean, reset: unknown = false, table = false): void {
	const held = useRef<Widths | null>(null);
	useLayoutEffect(() => {
		const box = ref.current;
		if (!box || (!active && !held.current)) return;
		const state = (held.current ??= {
			box,
			columns: table ? Array.from(box.querySelectorAll("col")) : [],
			last: null,
			animations: [],
			reset,
		});
		const instant = state.reset !== reset;
		state.reset = reset;
		queue(state, instant);
	}, [ref, value, active, reset, table]);

	useLayoutEffect(() => {
		const box = ref.current;
		const parent = box?.parentElement;
		if (!box || !parent || !active) return;
		let width: number | undefined;
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return;
			const next = entry.contentRect.width;
			// 高度随出字变化，不为它重新测宽；窗格变宽时直接跟随，不和面板自己的动画再叠一层。
			if (width !== undefined && next !== width && held.current) queue(held.current, true);
			width = next;
		});
		observer.observe(parent);
		return () => observer.disconnect();
	}, [ref, active]);

	useLayoutEffect(
		() => () => {
			if (!held.current) return;
			pending.delete(held.current);
			clear(held.current);
			held.current = null;
		},
		[],
	);
}

const pending = new Map<Widths, boolean>();
function queue(state: Widths, instant: boolean): void {
	const first = pending.size === 0;
	pending.set(state, instant || pending.get(state) === true);
	if (first) queueMicrotask(flush);
}

function read(state: Widths): number[] {
	return [
		state.box.getBoundingClientRect().width,
		...(state.columns.length ? Array.from(state.box.querySelectorAll("thead th"), (cell) => cell.getBoundingClientRect().width) : []),
	];
}

function clear(state: Widths): void {
	for (const animation of state.animations) animation.cancel();
	state.animations = [];
	state.box.style.width = "";
	state.box.style.tableLayout = "";
	delete state.box.dataset.growingWidth;
	for (const column of state.columns) column.style.width = "";
}

/** 先批量读当前宽，再全部放回自然排版、批量读目标，最后统一写；不能每个块各做一次读写交错。 */
function flush(): void {
	const jobs = [...pending].filter(([state]) => state.box.isConnected);
	pending.clear();
	const starts = jobs.map(([state]) => (state.animations.length ? read(state) : state.last));
	for (const [state] of jobs) {
		clear(state);
		// 同一个块被编辑成另一张表时，React 可能换掉列节点，不能继续向旧列写尺寸。
		if (state.box.tagName === "TABLE") state.columns = Array.from(state.box.querySelectorAll("col"));
	}
	const targets = jobs.map(([state]) => read(state));
	for (const [index, [state, instant]] of jobs.entries()) {
		const target = targets[index]!;
		const start = starts[index];
		state.last = target;
		if (instant || motionReduced() || !start || start.length !== target.length || target.every((width, i) => Math.abs(width - start[i]!) < 0.5)) continue;
		const { box, columns } = state;
		// fixed 只在过渡里接管列宽。结束后回到浏览器自然排版，字体、字号和静态页面的尺寸变化无需常驻观察器。
		box.dataset.growingWidth = "";
		if (columns.length) box.style.tableLayout = "fixed";
		const elements: HTMLElement[] = [box, ...columns];
		const animations = elements.map((element, i) => {
			element.style.width = `${target[i]}px`;
			return element.animate([{ width: `${start[i]}px` }, { width: `${target[i]}px` }], { duration: DURATION.base, easing: EASING.out });
		});
		state.animations = animations;
		void Promise.all(animations.map((animation) => animation.finished)).then(
			() => {
				if (state.animations === animations) clear(state);
			},
			() => {},
		);
	}
}
