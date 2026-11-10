/**
 * 各个滚动面板下一帧要量的东西，合进同一个 rAF：先把所有面板都读完，再一起写。
 *
 * 每个 `Scroller` 各量各的时候，一个面板刚写完滑块，下一个面板读 `scrollTop` 就得为它把整页的样式
 * 和布局先算一遍——几个面板同时在输出，滚动事件一来就是一串交错的读写。量过：滚动事件里同步量
 * 占了渲染主线程 9%，几乎全是这种被逼出来的排版。
 *
 * 推到 rAF 不会让滑块晚一帧：滚动事件在同一帧的 rAF 回调之前派发，这里约的回调当帧就跑。
 */

/** 读这一帧要的数，交回一个只写不读的函数。 */
export type Measure = () => () => void;

const pending = new Set<Measure>();
let frame = 0;

export function queueMeasure(measure: Measure): void {
	pending.add(measure);
	if (frame) return;
	frame = requestAnimationFrame(() => {
		frame = 0;
		const reads = [...pending];
		pending.clear();
		const writes = reads.map((read) => read());
		for (const write of writes) write();
	});
}

export function cancelMeasure(measure: Measure): void {
	pending.delete(measure);
}
