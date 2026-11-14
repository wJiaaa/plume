import { cancelTick, motionReduced, requestTick } from "@plume/ui";
import { useEffect, useRef } from "react";

/** 画布的 CSS 尺寸：一行字里的一个小记号，和旁边的读数一样高。 */
const WIDTH = 36;
const HEIGHT = 14;
/** 一秒往左走几像素：宽 36 就是最近四秒。 */
const PX_PER_SECOND = 9;
const SPAN_MS = (WIDTH / PX_PER_SECOND) * 1000;
/** 按这么长一格合并：草稿 50ms 推一次，逐次画会挤成一团。 */
const BIN_MS = 200;
/** 一格里写了这么多字，柱子画满。 */
const FULL_CHARS = 60;

/**
 * 运行行上的小心电图：最近几秒每一格到了多少字，一直往左走。
 *
 * 运行行上别的会动的东西（思考球、换词、秒数）都按钟点走，模型一个字不回也照样转。只有它跟着数据：字到一格长一根，
 * 没有底线：只在字在来的时候挂出来（见 `RunningIndicator`），没东西可画时整个收起，不留一条像占位符的空线。
 * 宽 36、每秒走 9 像素，窗口正好四秒：断流后最后一根柱子走出画面，和行尾「没有新输出」出现是同一刻。
 *
 * 按拍画（`ticker.ts`），和思考球同一拍；滚出视口就停。不动的时候只在字变时画一次。
 */
export function StreamTrace({ chars }: { chars: number }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const arrivals = useRef<{ at: number; chars: number }[]>([]);
	const last = useRef(chars);
	const paint = useRef<() => void>(() => {});

	// 字数变少是换了一条回复（上一步收尾、下一步开写），不算到了字。
	useEffect(() => {
		const grew = chars - last.current;
		last.current = chars;
		if (grew <= 0) return;
		const now = performance.now();
		arrivals.current = [...arrivals.current.filter((arrival) => now - arrival.at < SPAN_MS + BIN_MS), { at: now, chars: grew }];
		if (motionReduced()) paint.current();
	}, [chars]);

	useEffect(() => {
		const element = canvas.current;
		const context = element?.getContext("2d");
		if (!element || !context) return;
		const ratio = Math.min(2, window.devicePixelRatio || 1);
		element.width = Math.round(WIDTH * ratio);
		element.height = Math.round(HEIGHT * ratio);
		// 颜色挂上时读一次（`currentColor`，强调色）：每拍读计算样式，页面别处一脏就要整页重算。
		const color = getComputedStyle(element).color;
		const draw = (now: number) => {
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, WIDTH, HEIGHT);
			context.fillStyle = color;
			const bins = new Map<number, number>();
			for (const arrival of arrivals.current) {
				if (now - arrival.at > SPAN_MS + BIN_MS) continue;
				const bin = Math.floor(arrival.at / BIN_MS);
				bins.set(bin, (bins.get(bin) ?? 0) + arrival.chars);
			}
			for (const [bin, count] of bins) {
				const end = Math.min(now, (bin + 1) * BIN_MS);
				const age = now - end;
				const height = 2 + Math.min(1, count / FULL_CHARS) * 9.5;
				// 刚到的那一格从底下长出来，不是凭空出现。
				const grow = Math.min(1, (now - bin * BIN_MS) / 250);
				context.globalAlpha = Math.max(0, 1 - age / SPAN_MS) * 0.95;
				context.fillRect(WIDTH - (age / 1000) * PX_PER_SECOND - 1.5, HEIGHT - 1.5 - height * grow, 1.5, height * grow);
			}
		};
		paint.current = () => draw(performance.now());
		let tick = 0;
		const loop = (now: number) => {
			if (!motionReduced()) draw(now);
			tick = requestTick(loop);
		};
		draw(performance.now());
		// 滚出视口就停：一段长回复把运行行顶到屏幕外以后，没人看得见它。
		const observer = new IntersectionObserver(([entry]) => {
			cancelTick(tick);
			tick = entry?.isIntersecting ? requestTick(loop) : 0;
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
			cancelTick(tick);
		};
	}, []);

	return <canvas ref={canvas} aria-hidden className="block shrink-0 text-accent" style={{ width: WIDTH, height: HEIGHT }} />;
}
