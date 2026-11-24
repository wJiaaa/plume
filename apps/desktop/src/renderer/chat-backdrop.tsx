/**
 * 会话背后那张图。
 *
 * 一张图、一种效果、一种深浅，只算一次：结果是一个 blob URL，对话区和设置页的预览共用它。换了图就把旧图的 URL
 * 全部收回；只换效果时旧的留着，新的算好之前画面不会先空一下。皮肤自己的内嵌背景只覆盖显示，不改人的全局背景引用。
 *
 * 逐像素重绘在主线程做：一张缩到 2048 边长的图主线程最长阻塞几十毫秒，只在换图、换效果、换深浅时各发生一次，
 * 不值得为它起一个 Worker。
 */

import { type CSSProperties, useEffect, useState } from "react";
import type { ChatBackgroundEffect, ChatBackgroundFit } from "../shared/appearance.ts";
import { CHAT_BACKGROUND_DEFAULTS } from "../shared/appearance.ts";
import { useAppearance, useDark, useManagedSkin } from "./appearance-settings.ts";
import { BACKDROP_MAX_EDGE, type BackdropSource, lumaOf, redraw, redrawn, themed } from "./chat-backdrop-effects.ts";
import { effectiveChatBackdrop } from "./chat-backdrop-settings.ts";

interface ImageSource {
	key: string;
	direct?: string;
	original(): Promise<Blob | null>;
}

interface HeldImage {
	consumers: number;
	original: Promise<Blob | null>;
	decoded?: Promise<BackdropSource>;
	urls: Map<string, Promise<string | null>>;
}

const held = new Map<string, HeldImage>();

function imageOf(source: ImageSource): HeldImage {
	let image = held.get(source.key);
	if (!image) {
		image = { consumers: 0, original: source.original(), urls: new Map() };
		held.set(source.key, image);
	}
	return image;
}

function retain(source: ImageSource): void {
	imageOf(source).consumers++;
}

function release(key: string): void {
	const image = held.get(key);
	if (!image || --image.consumers > 0) return;
	held.delete(key);
	for (const url of image.urls.values())
		void url.then((value) => {
			if (value?.startsWith("blob:")) URL.revokeObjectURL(value);
		});
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

function backdropUrl(source: ImageSource, effect: ChatBackgroundEffect, light: boolean): Promise<string | null> {
	const image = imageOf(source);
	const key = redrawn(effect) ? `${effect}:${themed(effect) && light}` : "original";
	let url = image.urls.get(key);
	if (!url) {
		url =
			!redrawn(effect) && source.direct
				? Promise.resolve(source.direct)
				: image.original.then(async (blob) => {
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
		image.urls.set(key, url);
	}
	return url;
}

function useBackdropUrl(source: ImageSource | null, effect: ChatBackgroundEffect, light: boolean): string | null {
	const key = source?.key ?? null;
	const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
	useEffect(() => {
		if (!source) {
			setShown(null);
			return;
		}
		retain(source);
		return () => release(source.key);
		// source 的工厂函数每次渲染都会重建，真正决定图片身份的是稳定的 key。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	useEffect(() => {
		if (!source) return;
		let live = true;
		void backdropUrl(source, effect, light).then((url) => {
			if (live && url) setShown({ key: source.key, url });
		});
		return () => {
			live = false;
		};
		// source 的工厂函数每次渲染都会重建，真正决定图片身份的是稳定的 key。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, effect, light]);
	return key && shown?.key === key ? shown.url : null;
}

function globalSource(name: string | undefined): ImageSource | null {
	return name
		? {
				key: `global:${name}`,
				original: () => window.plume.chatBackground.read(name).then((bytes) => (bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null)),
			}
		: null;
}

function skinSource(image: string): ImageSource {
	return {
		key: `skin:${image}`,
		direct: image,
		original: () =>
			fetch(image)
				.then((response) => response.blob())
				.catch(() => null),
	};
}

/** 全局背景设置页预览的图片；即使皮肤有独立背景，这里仍编辑和预览人的全局背景。 */
export function useChatBackdropImage(): string | null {
	const appearance = useAppearance();
	const effect = appearance.chatBackgroundEffect ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundEffect;
	return useBackdropUrl(globalSource(appearance.chatBackground), effect, !useDark());
}

function useEffectiveBackdrop() {
	const selected = effectiveChatBackdrop(useAppearance(), useManagedSkin());
	const source = selected.source.kind === "skin" ? skinSource(selected.source.image) : globalSource(selected.source.name ?? undefined);
	return { ...selected, url: useBackdropUrl(source, selected.effect, !useDark()) };
}

/**
 * 铺在对话区底下的那一层。新对话里是原样；有了消息以后整张图压淡一半，见 styles.css 的 .chat-backdrop。
 * 皮肤独立背景优先；撤下皮肤后重新使用人的全局图片和显示位置，不改写那份偏好。
 *
 * 两种之间当场切换，不过渡：正文是同一帧画出来的，图慢慢淡下去就是原样的图在字底下多留三百多毫秒，
 * 从新对话进到会话看着像整页闪了一下。
 *
 * 父元素要 `relative isolate`：这一层是 `z-index: -1`，隔离之后它压在父元素自己的底色之上、内容之下。
 */
export function ChatBackdrop({ empty, headerHeight = 0 }: { empty: boolean; headerHeight?: number }) {
	const appearance = useAppearance();
	const backdrop = useEffectiveBackdrop();
	const enabled = empty ? backdrop.onNewChat : backdrop.inChat;
	return (
		<>
			{enabled && backdrop.url && (
				<BackdropLayer url={backdrop.url} effect={backdrop.effect} opacity={backdrop.opacity} reading={!empty} fit={backdrop.fit} headerHeight={headerHeight} />
			)}
			{/* 磨砂是整个窗口的质感，不看背景图的显示位置。 */}
			{appearance.grain && <GrainLayer headerHeight={headerHeight} />}
		</>
	);
}

/** 对话区的磨砂：排在图后面，叠在图上；不跟图的浓度走。颗粒本身是 styles.css 的 `--grain-layer`，和外圈同一块。 */
export function GrainLayer({ headerHeight = 0 }: { headerHeight?: number }) {
	return <div aria-hidden className="surface-grain" style={{ "--plume-pane-header": `${headerHeight}px` } as CSSProperties} />;
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
			{effect === "grid" && <span className="chat-backdrop-grid" />}
			{reading && <span className="chat-backdrop-veil" />}
		</div>
	);
}
