/**
 * 一个标记怎么画到画布上。
 *
 * 从 `Annotator.tsx` 里提出来，是因为截图浮层要的正是同一件事，而它曾经长出过自己的一份——那份只认得八个
 * 工具里的四个。马赛克、文字、步骤标号和直线都在浮层的工具条上，按了都悄无声息地什么也不画，因为背后的
 * 函数根本没有它们的分支。两个画法，总有一个落在后面。
 *
 * 这里的一切都在图片的**原始**像素里、在没有平移过的 context 上进行。画一块裁剪区域的调用方把 context
 * 平移到裁剪区的原点，其余不变——同一个函数就是这样同时服务标注器的整图画布和浮层的选区的。
 */

import { mosaicCells, stepNumber, wrapText, type Shape } from "./annotate.ts";

/**
 * 没有自带字号的文字，字号相对线宽是多少。
 *
 * 现在只是兜底：每段文字写下时都带着工具条给它的字号（`typeAt`）。
 */
const TEXT_SCALE = 5;
/** 行距和内边距，输入框和画图共用，两边才能分毫不差。 */
export const LINE = 1.35;
export const PAD = 0.28;

const FONT = `-apple-system, system-ui, "PingFang SC", sans-serif`;
/**
 * 一个字符串，输入框和画布就不会各走各的。
 *
 * 没有下限。以前有一个 `max(12, size)`，用在两种单位上：画布上是图片像素，输入框里是屏幕像素。一段字号
 * 为 15 个图片像素的文字，在按 0.78 显示的图上，打字时是 12 点、画出来是 11.7——提交的那一刻就缩了一下。
 * 现在字号从屏幕来，本来就不会那么小。
 */
export const fontOf = (size: number) => `${size}px ${FONT}`;

/**
 * 一次画完所有盖住的格子：平均过的副本按格子大小放大，透过这些格子组成的裁剪区画上去。
 *
 * 以前是每个格子画一次，每次一个 `block` 大小的方块。在按图片自身分辨率开的画布上，这些方块落在整像素上；
 * 在按屏幕分辨率开的画布上——这里是每个图片像素 1.56 个设备像素——它们的边落在像素之间，每一块各自抗锯齿，
 * 于是块与块之间透出一道细细的原图，在打码上画出一张网格。一张图透过一个裁剪区，里面就没有边。
 */
function paintMosaic(ctx: CanvasRenderingContext2D, shape: Shape, source: HTMLCanvasElement | null, block: number, brush: number) {
	if (!source) return;
	const cells = mosaicCells(shape.points, brush, block);
	if (cells.length === 0) return;
	ctx.beginPath();
	for (const cell of cells) {
		const [x, y] = cell.split(",").map(Number) as [number, number];
		ctx.rect(x, y, block, block);
	}
	ctx.clip();
	const smoothing = ctx.imageSmoothingEnabled;
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, source.width * block, source.height * block);
	ctx.imageSmoothingEnabled = smoothing;
}

/**
 * 第 `i` 行字形的顶边。
 *
 * 行距一半在字上面、一半在字下面，行框就是这么做的，所以输入框也是。这里弄错，画出来的文字会比打的时候
 * 偏几个像素——不大，但输入框一消失就看得出来。
 */
const baseline = (top: number, pad: number, i: number, step: number, size: number) => top + pad + i * step + (step - size) / 2;

function paint(ctx: CanvasRenderingContext2D, shape: Shape, stroke: number, step: number) {
	ctx.strokeStyle = shape.colour;
	ctx.fillStyle = shape.colour;
	ctx.lineWidth = stroke;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	const first = shape.points[0];
	const last = shape.points[shape.points.length - 1];
	if (!first || !last) return;

	if (shape.tool === "text") {
		const size = shape.size ?? stroke * TEXT_SCALE;
		const pad = size * PAD;
		ctx.font = fontOf(size);
		ctx.textBaseline = "top";

		// 和输入框折行时同一栏宽，断行的地方才一样。
		const column = (shape.width ?? Number.POSITIVE_INFINITY) - pad * 2;
		const lines = wrapText((line) => ctx.measureText(line).width, shape.text ?? "", column);
		const step = size * LINE;

		if (shape.background) {
			ctx.fillStyle = shape.background;
			const box = shape.width ?? Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
			const height = lines.length * step + pad * 2;
			ctx.beginPath();
			ctx.roundRect(first.x, first.y, box, height, size * 0.2);
			ctx.fill();
		} else {
			/*
			 * 一道细细的反差，不是光晕。
			 *
			 * 文字后面没有底，它落在什么上面都得自己保证读得清——可按 `size / 9` 描的边比字形本身的笔画还粗，
			 * 白色渗进每个字的空隙里，读起来像没对上焦的字。细到刚好把字和背景分开，再粗就多余了。
			 */
			ctx.strokeStyle = "rgba(255,255,255,0.85)";
			ctx.lineWidth = Math.max(1, size / 18);
			ctx.lineJoin = "round";
			lines.forEach((line, i) => ctx.strokeText(line, first.x + pad, baseline(first.y, pad, i, step, size)));
		}

		ctx.fillStyle = shape.colour;
		lines.forEach((line, i) => ctx.fillText(line, first.x + pad, baseline(first.y, pad, i, step, size)));
		return;
	}

	if (shape.tool === "step") {
		// 一个实心圆盘，里面是编号，大小是放下时的那个。以点击处为圆心而不是从那里开始：标号标的是一个
		// 点，不是从一个点开始。
		const radius = shape.size ?? Math.max(12, stroke * 4.5);
		ctx.beginPath();
		ctx.arc(first.x, first.y, radius, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = "rgba(255,255,255,0.95)";
		ctx.lineWidth = Math.max(2, radius / 7);
		ctx.stroke();

		ctx.fillStyle = "#ffffff";
		ctx.font = `600 ${Math.round(radius * 1.15)}px -apple-system, system-ui, sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(String(step), first.x, first.y + radius * 0.04);
		ctx.textAlign = "start";
		ctx.textBaseline = "alphabetic";
		return;
	}

	if (shape.tool === "arrow") {
		// 只和箭杆成比例：用图片像素定的下限在每张图上都是不同的大小，在大图上，正是它让细箭头的头显得
		// 那么小。
		const head = stroke * 4.5;
		const angle = Math.atan2(last.y - first.y, last.x - first.x);
		// 箭杆在箭尖前面停下，线就不会从箭头的凹口里透出来。
		const shaft = Math.max(0, Math.hypot(last.x - first.x, last.y - first.y) - head * 0.72);
		ctx.beginPath();
		ctx.moveTo(first.x, first.y);
		ctx.lineTo(first.x + Math.cos(angle) * shaft, first.y + Math.sin(angle) * shaft);
		ctx.stroke();

		// 实心三角形而不是两笔：多大都读得出是一个箭头。
		const wing = Math.PI / 7;
		ctx.beginPath();
		ctx.moveTo(last.x, last.y);
		ctx.lineTo(last.x - Math.cos(angle - wing) * head, last.y - Math.sin(angle - wing) * head);
		ctx.lineTo(last.x - Math.cos(angle + wing) * head, last.y - Math.sin(angle + wing) * head);
		ctx.closePath();
		ctx.fill();
		return;
	}

	ctx.beginPath();
	if (shape.tool === "pen") {
		const points = shape.points;
		ctx.moveTo(first.x, first.y);
		if (points.length === 1) {
			// 单击留下一个点，而不是什么都没有。
			ctx.lineTo(first.x + 0.01, first.y);
		} else {
			/*
			 * 穿过中点，每个采样点作控制点：画出来的是手画的那条曲线，而不是指针碰巧被采样到的那些位置
			 * 连成的多边形。用直线连的话，每帧几个事件，飞快画的一个圈就成了七边形。
			 */
			for (let i = 1; i < points.length - 1; i++) {
				const here = points[i]!;
				const next = points[i + 1]!;
				ctx.quadraticCurveTo(here.x, here.y, (here.x + next.x) / 2, (here.y + next.y) / 2);
			}
			ctx.lineTo(last.x, last.y);
		}
	} else if (shape.tool === "line") {
		ctx.moveTo(first.x, first.y);
		ctx.lineTo(last.x, last.y);
	} else if (shape.tool === "rect") {
		ctx.rect(first.x, first.y, last.x - first.x, last.y - first.y);
	} else {
		// 内切于拖出的框的椭圆，从一个角拖到另一个角就是这个意思。
		ctx.ellipse((first.x + last.x) / 2, (first.y + last.y) / 2, Math.abs(last.x - first.x) / 2, Math.abs(last.y - first.y) / 2, 0, 0, Math.PI * 2);
	}
	ctx.stroke();
}

/**
 * 画一整张标记清单，马赛克也在内。
 *
 * 知道「马赛克和别的画法不一样」的唯一一处——以前每个调用方都得记着这件事，浮层那份没记住，所以它的马赛克
 * 按钮什么也不画。
 */
export function paintAll(
	ctx: CanvasRenderingContext2D,
	shapes: Shape[],
	options: {
		stroke: number;
		/** 按格子大小取，因为来源的分辨率**就是**网格——见 `useAnnotator`。 */
		mosaicSourceFor: (block: number) => HTMLCanvasElement | null;
		block: number;
		brush: number;
	},
) {
	/*
	 * 标记自己的尺寸优先于当前的。
	 *
	 * options 是给没带尺寸的标记用的默认值——更早的版本标注过的图，或者此刻正在拖出来、还没提交的那个。
	 * 提交过的都带着画下时的尺寸，所以改设置不会再回头把已经做完的东西改大改小。
	 */
	shapes.forEach((shape, index) => {
		ctx.save();
		if (shape.tool === "mosaic") {
			const grid = shape.block ?? options.block;
			paintMosaic(ctx, shape, options.mosaicSourceFor(grid), grid, shape.brush ?? options.brush);
		} else {
			paint(ctx, shape, shape.stroke ?? options.stroke, stepNumber(shapes, index));
		}
		ctx.restore();
	});
}
