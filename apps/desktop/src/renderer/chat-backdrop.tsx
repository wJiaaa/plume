/**
 * 会话背后那张图。
 *
 * 一张图、一种效果、一种深浅，只算一次：结果是一个 blob URL，对话区和设置页的预览共用它。换了图就把旧图的 URL
 * 全部收回；只换效果时旧的留着，新的算好之前画面不会先空一下。
 *
 * 逐像素重绘在主线程做：一张缩到 2048 边长的图主线程最长阻塞几十毫秒，只在换图、换效果、换深浅时各发生一次，
 * 不值得为它起一个 Worker。
 */

import { type CSSProperties, useEffect, useState } from "react";
import type { ChatBackgroundEffect, ChatBackgroundFit } from "../shared/appearance.ts";
import { CHAT_BACKGROUND_DEFAULTS } from "../shared/appearance.ts";
import { useAppearance, useDark } from "./appearance-settings.ts";
import { BACKDROP_MAX_EDGE, type BackdropSource, lumaOf, redraw, redrawn, themed } from "./chat-backdrop-effects.ts";

let held: { name: string; original: Promise<Blob | null>; decoded?: Promise<BackdropSource> } | null = null;
const urls = new Map<string, Promise<string | null>>();

function imageOf(name: string) {
	if (held?.name !== name) {
		for (const url of urls.values()) void url.then((value) => value && URL.revokeObjectURL(value));
		urls.clear();
		held = { name, original: window.plume.chatBackground.read(name).then((bytes) => (bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null)) };
	}
	return held;
}

async function decode(blob: Blob): Promise<BackdropSource> {
	const bitmap = await createImageBitmap(blob);
	const scale = Math.min(1, BACKDROP_MAX_EDGE / bitmap.width, BACKDROP_MAX_EDGE / bitmap.height);
	const width = Math.max(1, Math.round(bitmap.width * scale));
	const height = Math.max(1, Math.round(bitmap.height * scale));
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("no 2d context");
	context.drawImage(bitmap, 0, 0, width, height);
	bitmap.close();
	const pixels = context.getImageData(0, 0, width, height).data;
	return { width, height, pixels, luma: lumaOf(pixels) };
}

async function render(source: BackdropSource, effect: "dither" | "ascii" | "halftone" | "scanlines", light: boolean): Promise<Blob> {
	const canvas = new OffscreenCanvas(source.width, source.height);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("no 2d context");
	context.putImageData(new ImageData(redraw(source, effect, light) as Uint8ClampedArray<ArrayBuffer>, source.width, source.height), 0, 0);
	return canvas.convertToBlob({ type: "image/png" });
}

function backdropUrl(name: string, effect: ChatBackgroundEffect, light: boolean): Promise<string | null> {
	const image = imageOf(name);
	const key = redrawn(effect) ? `${effect}:${themed(effect) && light}` : "original";
	let url = urls.get(key);
	if (!url) {
		url = image.original.then(async (blob) => {
			if (!blob) return null;
			if (!redrawn(effect)) return URL.createObjectURL(blob);
			try {
				image.decoded ??= decode(blob);
				return URL.createObjectURL(await render(await image.decoded, effect, light));
			} catch {
				// 解不开或画不出来时退回原图：背景少一层效果，好过整块消失。
				return URL.createObjectURL(blob);
			}
		});
		urls.set(key, url);
	}
	return url;
}

/** 此刻该画的那张图；没设背景、或图还没读出来时为 null。 */
export function useChatBackdropImage(): string | null {
	const appearance = useAppearance();
	const name = appearance.chatBackground ?? null;
	const effect = appearance.chatBackgroundEffect ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundEffect;
	const light = !useDark();
	const [shown, setShown] = useState<{ name: string; url: string } | null>(null);
	useEffect(() => {
		if (!name) return;
		let live = true;
		void backdropUrl(name, effect, light).then((url) => {
			if (live && url) setShown({ name, url });
		});
		return () => {
			live = false;
		};
	}, [name, effect, light]);
	// 换了图之后，上一张的 URL 已经收回，不能再拿来画。
	return name && shown?.name === name ? shown.url : null;
}

/**
 * 铺在对话区底下的那一层。新对话里是原样；有了消息以后整张图压淡一半，见 styles.css 的 .chat-backdrop。
 * 两处各有一个开关，只开一处时另一处不画。
 *
 * 两种之间当场切换，不过渡：正文是同一帧画出来的，图慢慢淡下去就是原样的图在字底下多留三百多毫秒，
 * 从新对话进到会话看着像整页闪了一下。
 *
 * 父元素要 `relative isolate`：这一层是 `z-index: -1`，隔离之后它压在父元素自己的底色之上、内容之下。
 */
export function ChatBackdrop({ empty, headerHeight = 0 }: { empty: boolean; headerHeight?: number }) {
	const appearance = useAppearance();
	const url = useChatBackdropImage();
	const enabled = empty
		? (appearance.chatBackgroundOnNewChat ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundOnNewChat)
		: (appearance.chatBackgroundInChat ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundInChat);
	return (
		<>
			{enabled && appearance.chatBackground && url && (
				<BackdropLayer
					url={url}
					effect={appearance.chatBackgroundEffect ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundEffect}
					opacity={appearance.chatBackgroundOpacity ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundOpacity}
					reading={!empty}
					fit={appearance.chatBackgroundFit ?? "cover"}
					headerHeight={headerHeight}
				/>
			)}
			{/* 磨砂是整个窗口的质感，不看背景图的显示位置。 */}
			{appearance.grain && <GrainLayer headerHeight={headerHeight} />}
		</>
	);
}

/** 对话区的磨砂：排在图后面，叠在图上；不跟图的浓度走。颗粒本身是 styles.css 的 `--grain-layer`，和外圈同一块。 */
export function GrainLayer({ headerHeight = 0 }: { headerHeight?: number }) {
	return <div aria-hidden className="chat-grain" style={{ "--plume-pane-header": `${headerHeight}px` } as CSSProperties} />;
}

/** 那一层本身。设置页的预览也画它，所以效果和遮罩只写一处。 */
export function BackdropLayer({
	url,
	effect,
	opacity,
	reading = false,
	fit = "cover",
	headerHeight = 0,
}: {
	url: string;
	effect: ChatBackgroundEffect;
	opacity: number;
	reading?: boolean;
	fit?: ChatBackgroundFit;
	headerHeight?: number;
}) {
	return (
		<div
			aria-hidden
			data-backdrop={effect}
			data-fit={fit}
			className="chat-backdrop"
			style={{ "--chat-backdrop-image": `url("${url}")`, "--plume-pane-header": `${headerHeight}px`, opacity } as CSSProperties}
		>
			{effect === "haze" && (
				<>
					<span className="chat-backdrop-haze-soft" />
					<span className="chat-backdrop-haze-strong" />
				</>
			)}
			{reading && <span className="chat-backdrop-veil" />}
		</div>
	);
}
