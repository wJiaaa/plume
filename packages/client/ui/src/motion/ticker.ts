/**
 * 流式输出期间会动的东西共用的一拍：放字、淡入、数字爬升、思考球。用法和
 * `requestAnimationFrame` 一样，只是回调不在每一帧来，而是约 30 次每秒（窗口最小化时 10 次）、
 * 并且同一拍里的全部一起来。
 *
 * 为什么要一拍：120Hz 屏上，这几样东西各开一个 rAF，只要其中一个这一帧改了页面，整条样式、布局、
 * 绘制、合成就得为这一帧跑一遍。正文其实每秒只长三四十次，剩下的帧全是这几个循环各自撑起来的。
 * 量过：主会话加三个侧边聊天同时输出，渲染进程 105–114%、GPU 53%；把 rAF 合到 30Hz 并停掉
 * CSS 动画后 44% / 17%。只做其中一样只降两成——另一样还在每帧弄脏页面。
 *
 * 同一拍一起跑也是要点：几个面板各自放字、各自淡入，挤进同一个 rAF 回调里，React 把它们的
 * setState 合成一次提交，页面也只脏这一帧。
 *
 * 用户直接操作的动画（拖动、点「回到底部」的那一下滑行）不走这里，它们要跟手。贴底跟随的弹簧也不走：
 * 试过按拍走，视口每四帧才挪一次，量到相邻帧速度差 p95 从 1px 涨到 10.5px，
 * 就是 `useFollowBottom` 专门要避开的那种「一顿一顿」。正文按拍长、视口逐帧追，台阶由弹簧抹平。
 * 折中成最多 60Hz 也试过：每秒只省下约 28ms 主线程（滚动位置更新加悬停命中测试），速度差 p95 照样
 * 涨到 8.5px，不值。
 */

/** 一拍多长。 */
export const TICK_MS = 1000 / 30;

/**
 * 窗口最小化时一拍多长。主窗口关了 `backgroundThrottling`，最小化以后浏览器照常全速出帧；字照样往外放，
 * 只是没人看。只认最小化不认失焦：并排摆着的窗口人还看得见，放字一顿一顿就像卡了。
 */
const MINIMIZED_TICK_MS = 1000 / 10;

/**
 * 帧时间戳有抖动：120Hz 下第四帧可能只隔 33.2ms。差这一点就要多等一帧的话，30Hz 会掉成 24Hz。
 * 留的余量要小于半帧（120Hz 下 4.2ms），不然会提前一帧，变成 40Hz。
 */
const SLACK = 3;

/**
 * 拍与拍之间睡在计时器上，提前这么久醒来去等 vsync。挂着的 rAF 会让合成器每一帧都来要一次主线程帧，
 * 所以不能一直挂着等；醒得太早要多等几帧，太晚会错过这一拍。半个 120Hz 帧：120Hz 下落在到点前
 * 最后两个 vsync 之间，60Hz 下也在最后一个之前。
 */
const EARLY = 4;

const due = new Map<number, (now: number) => void>();
let seq = 0;
let frame = 0;
let timer = 0;
let last = Number.NEGATIVE_INFINITY;
let minimized = false;

/**
 * 窗口是不是最小化了。页面自己察觉不到（`visibilityState` 仍是 visible、rAF 照跑），由产品接主进程的
 * 最小化通知，经 `setWindowMinimized` 喂进来。最小化时拍子放慢，`ticked.ts` 的装饰动画停住，
 * 贴底跟随不滑。
 */
export function windowMinimized(): boolean {
	return minimized;
}

export function setWindowMinimized(value: boolean): void {
	if (value === minimized) return;
	minimized = value;
	// 最小化时约下的那一拍可能还要等近 100ms：还原后的第一眼就该是正常节奏。
	if (value || !timer) return;
	window.clearTimeout(timer);
	timer = 0;
	schedule();
}

const interval = () => (minimized ? MINIMIZED_TICK_MS : TICK_MS);

function pump(now: number): void {
	frame = 0;
	if (now - last < interval() - SLACK) {
		frame = requestAnimationFrame(pump);
		return;
	}
	last = now;
	const run = [...due.values()];
	due.clear();
	for (const callback of run) callback(now);
	if (due.size) schedule();
}

function schedule(): void {
	if (frame || timer) return;
	const wait = last + interval() - SLACK - EARLY - performance.now();
	if (wait <= 0) {
		frame = requestAnimationFrame(pump);
		return;
	}
	timer = window.setTimeout(() => {
		timer = 0;
		frame = requestAnimationFrame(pump);
	}, wait);
}

/** 下一拍调用 `callback`，参数和 rAF 一样是帧时间戳。隔了一阵没人要拍时，第一拍就在下一帧。 */
export function requestTick(callback: (now: number) => void): number {
	const id = ++seq;
	due.set(id, callback);
	schedule();
	return id;
}

export function cancelTick(id: number): void {
	due.delete(id);
	if (due.size) return;
	cancelAnimationFrame(frame);
	window.clearTimeout(timer);
	frame = 0;
	timer = 0;
}
