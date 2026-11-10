/**
 * 截屏浮层窗口和钉图窗口里的那一页。
 *
 * 两种窗口都由主进程开（main/screenshot/），加载的是和主窗口同一份页面，地址后面带 `#screen-overlay` / `#pinned-shot`。
 * 页面照常连 agent、装插件的界面入口（插件的组件可能要经 `ui.remote()` 调自己的逻辑入口），然后只画插件经
 * `ui.screenOverlay` / `ui.pinnedShot` 注册的那一个组件；宿主在这里做的只是把主进程的消息接成组件的 props。
 *
 * 浮层窗口建一次、一直留着（每次截屏都新建窗口太慢，见 main/screenshot/），每次截屏主进程推来一个新 session，
 * 组件按 session id 重新挂上；浮层收起后主进程说一声 hidden，这里丢掉快照，那是几十 MB 的像素。
 */

import type { PinnedShotProps, ScreenCaptureSession, ScreenOverlayProps } from "@plume/contract/ui";
import { useEffect, useMemo, useState } from "react";
import { pinnedShotComponent, screenOverlayComponent } from "./plugins.tsx";

const HASHES = { "#screen-overlay": "overlay", "#pinned-shot": "pin" } as const;

/** 这一页是不是截屏的窗口；是的话页面底色换成透明（见 styles.css 的 data-screen-window）。 */
export function screenWindow(): "overlay" | "pin" | undefined {
	const kind = HASHES[location.hash as keyof typeof HASHES];
	if (kind) document.documentElement.dataset.screenWindow = kind;
	return kind;
}

const escapeListeners = new Set<() => void>();

export function ScreenOverlayHost() {
	const [session, setSession] = useState<ScreenCaptureSession>();
	useEffect(() => {
		window.plume.screen.onSession((next) => {
			// 结构化克隆送来的是 Uint8Array，换成同一块内存上的 Uint8ClampedArray，ImageData 认这个。
			const { pixels } = next.snapshot as { pixels: Uint8Array | Uint8ClampedArray };
			setSession({ ...next, snapshot: { ...next.snapshot, pixels: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength) } });
		});
		window.plume.screen.onEscape(() => {
			for (const listener of escapeListeners) listener();
		});
		window.plume.screen.onHidden(() => setSession(undefined));
	}, []);
	const props = useMemo<Omit<ScreenOverlayProps, "session">>(
		() => ({
			ready: () => {
				if (session) window.plume.screen.ready(session.id);
			},
			finish: (png) => window.plume.screen.finish(png),
			cancel: () => window.plume.screen.cancel(),
			pin: (png, at) => window.plume.screen.pin(png, at),
			copy: (png) => window.plume.screen.copy(png),
			passThrough: (on) => window.plume.screen.passThrough(on),
			onEscape: (listener) => {
				escapeListeners.add(listener);
				return () => escapeListeners.delete(listener);
			},
		}),
		[session],
	);
	const Overlay = screenOverlayComponent();
	useEffect(() => {
		// 浮层组件跟着插件停用没了：这一次截不成，收起来，不留一块盖住屏幕的透明窗口。
		if (session && !Overlay) window.plume.screen.cancel();
	}, [session, Overlay]);
	if (!session || !Overlay) return null;
	// 组件是插件登记的那一个，每次取到的是同一个引用，不是在渲染里新建的。
	// oxlint-disable-next-line react/static-components
	return <Overlay key={session.id} session={session} {...props} />;
}

export function PinnedShotHost() {
	const [image, setImage] = useState<PinnedShotProps["image"] | null>();
	useEffect(() => {
		void window.plume.pin.request().then(setImage);
	}, []);
	const Pinned = pinnedShotComponent();
	useEffect(() => {
		if (image === null || (image && !Pinned)) window.plume.pin.close();
	}, [image, Pinned]);
	if (!image || !Pinned) return null;
	return (
		// 同上：插件登记的组件，引用不变。
		// oxlint-disable-next-line react/static-components
		<Pinned
			image={image}
			ready={() => window.plume.pin.ready()}
			close={() => window.plume.pin.close()}
			dragStart={() => window.plume.pin.dragStart()}
			dragMove={(dx, dy) => window.plume.pin.dragMove(dx, dy)}
		/>
	);
}
