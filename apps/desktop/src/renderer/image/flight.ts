/**
 * 图片在缩略图和看图器之间飞行的两端，写成关键帧。
 *
 * 从看图器里拆出来、只做几何，是因为看图器量错盒子不止一次，而每次唯一的症状都是图片动得有点怪——这一块
 * 能用测试钉住，不必靠眼睛看。
 *
 * 起点是一次等比缩放加一道裁切，不是挤压。缩略图通常显示的是一张形状不同的图的 `cover` 裁切，所以让图片
 * *盖满*缩略图的那个缩放会让它有几块露在外面；`clip-path` 把那几块裁掉，它的圆角再除以缩放倍数，缩放之后
 * 就正好是缩略图自己的圆角。于是第一帧就是缩略图本身——尺寸、裁切、圆角都一样——回去时的最后一帧也是。
 * 这正是图片整段飞行都能保持完全不透明的原因：从前那个 0.4 的起点是为了遮住一块裁切，现在那块根本不画，
 * 而它让每一次到达都先闪一下半透明的副本。
 */

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** 缩略图里真正显示图片的那一块，以及它的圆角有多大。 */
export interface Thumb {
	box: Box;
	radius: number;
}

/** 飞行的一端：`Element.animate` 收的关键帧（写成 type，才有 `Keyframe` 要的索引签名）。 */
export type FlightKeyframe = {
	transform: string;
	clipPath: string;
};

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

/**
 * 全尺寸的图要画在哪、怎么画，才和它的缩略图一模一样。
 *
 * `to` 是图片停稳后的盒子——量的时候身上没有 transform。量一个还在路上的盒子，起点曾经因此变成缩略图的
 * 2.8 倍。
 */
export function atThumbnail(thumb: Thumb, to: Box): FlightKeyframe {
	const from = thumb.box;
	const scale = Math.max(from.width / to.width, from.height / to.height, 0.01);
	const dx = from.x + from.width / 2 - (to.x + to.width / 2);
	const dy = from.y + from.height / 2 - (to.y + to.height / 2);
	// 用图片自己未缩放的像素算：每一边缩略图没有显示的那一条。
	const insetX = Math.max(0, (to.width - from.width / scale) / 2);
	const insetY = Math.max(0, (to.height - from.height / scale) / 2);
	return {
		transform: `translate(${px(dx)}, ${px(dy)}) scale(${Math.round(scale * 1e5) / 1e5})`,
		clipPath: `inset(${px(insetY)} ${px(insetX)} ${px(insetY)} ${px(insetX)} round ${px(thumb.radius / scale)})`,
	};
}

/**
 * 停在看图器里的图片。
 *
 * 写成带圆角的 `inset()` 而不是 `none`：裁切只能在同一种形状之间插值，从 `inset(…)` 到 `none` 会在最后一帧
 * 跳一下。
 */
export function atRest(radius: number): FlightKeyframe {
	return { transform: "none", clipPath: `inset(0px 0px 0px 0px round ${px(radius)})` };
}

/**
 * 图片在它的元素里实际画进去的那个矩形，给会留边的几种 fit。
 *
 * `cover` 和 `fill` 铺满整个盒子，盒子就是答案。`contain` 和 `scale-down` 会留黑边，从留了边的盒子起飞，
 * 图片一开始就比屏幕上任何东西都宽或都高。
 */
export function paintedBox(box: Box, natural: { width: number; height: number }, fit: string): Box {
	if ((fit !== "contain" && fit !== "scale-down") || natural.width <= 0 || natural.height <= 0) return box;
	let scale = Math.min(box.width / natural.width, box.height / natural.height);
	if (fit === "scale-down") scale = Math.min(scale, 1);
	const width = natural.width * scale;
	const height = natural.height * scale;
	return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}
