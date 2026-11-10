import { cancelTick, motionReduced, requestTick } from "@plume/ui";
import { useEffect, useRef } from "react";
import { MODE_FRAMES, paintFrame, resolvePreset } from "thinking-orbs/engine";
import type { Mood } from "./thinking-words.ts";

/** 深浅色跟系统走（theme.css 的 `prefers-color-scheme`），每拍读一次，跑着的时候切了也跟得上。 */
const dark = matchMedia("(prefers-color-scheme: dark)");

/**
 * 运行行上那颗点阵球，按拍子画（`ticker.ts`），不按帧。
 *
 * 画法全用 `thinking-orbs` 的引擎，只换掉它自带组件的那个循环：那个循环每一帧都画，120Hz 屏上一颗 20px 的球每秒重画、
 * 重新上传 120 次，正文没在长的时候页面也每帧都脏，它也没有限帧的选项。现在和放字、跟随滚动同一拍，每秒 30 次。
 * 自带组件为了跟主题在整个文档上挂了 `subtree` 的 MutationObserver，页面上任何一处换 class 都要回调一次；这里每拍问一次媒体查询。
 */
export function ThinkingOrb({ state, size, className }: { state: Mood; size: 20; className?: string }) {
	const canvas = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const element = canvas.current;
		const context = element?.getContext("2d");
		if (!element || !context) return;
		const ratio = Math.min(2, window.devicePixelRatio || 1);
		element.width = Math.round(size * ratio);
		element.height = Math.round(size * ratio);
		const { mode, speed, opts } = resolvePreset(state, size);
		const frameOf = MODE_FRAMES[mode];
		const draw = (seconds: number) => {
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, size, size);
			paintFrame(context, frameOf(size, seconds, opts), dark.matches);
		};
		/*
		 * 不动的时候停在 0.6 秒那一帧，那一帧的样子是调过的。每拍现问一次而不是挂上时问：跑着的时候关掉动效，球要当场停住。
		 * 停住以后不再重画，拍子还在，好在打开动效时接着走。
		 */
		let still = motionReduced();
		let tick = 0;
		const loop = (now: number) => {
			const reduced = motionReduced();
			if (!reduced) draw((now / 1000) * speed);
			else if (!still) draw(0.6);
			still = reduced;
			tick = requestTick(loop);
		};
		draw(still ? 0.6 : (performance.now() / 1000) * speed);
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
	}, [state, size]);

	return <canvas ref={canvas} aria-hidden className={className} style={{ width: size, height: size, display: "block" }} />;
}
