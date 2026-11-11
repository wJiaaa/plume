/**
 * 一页的 `<webview>`，加上 agent 的光标。
 *
 * 节点和 `src` 一直不换：换 `src` 就是换一页，节点卸掉页面就没了。之后的跳转都经逻辑入口（`ctx.pages.load`），
 * `src` 只是第一次挂上时去的那一页。
 */

import { useEffect, useRef, useState } from "react";
import type { Remote } from "@plume/contract/ui";
import type { BrowserApi, BrowserPage } from "./api.ts";

export function PageView({ api, page }: { api: Remote<BrowserApi>; page: BrowserPage }) {
	const ref = useRef<HTMLWebViewElement | null>(null);
	const [initialUrl] = useState(page.url);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const id = page.id;

	useEffect(() => {
		const view = ref.current;
		if (!view) return;
		let live = true;
		let retry: number | undefined;
		let tries = 0;
		/*
		 * 挂上就报到，不等 `dom-ready`：那要等网站回第一个响应，站点迟迟不回时开页就会报「面板没有就绪」。
		 * `did-attach` 时 guest 的 id 有时还读不到（`getWebContentsId` 会抛），隔 50ms 再读，读满 2 秒交给 `dom-ready`。
		 * 同一页重复报到，宿主认得是同一个。
		 */
		const attach = () => {
			window.clearTimeout(retry);
			if (!live) return;
			let contentsId: number;
			try {
				contentsId = view.getWebContentsId();
			} catch {
				if (++tries < 40) retry = window.setTimeout(attach, 50);
				return;
			}
			void api.attach(id, contentsId).catch((error: unknown) => console.error("[plume.browser] 页面没能挂上：", error));
		};
		view.addEventListener("did-attach", attach);
		view.addEventListener("dom-ready", attach);
		const observer = new ResizeObserver(([entry]) => {
			if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
			setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
			void api.resize(id, entry.contentRect.width, entry.contentRect.height).catch(() => {});
		});
		observer.observe(view);
		return () => {
			live = false;
			window.clearTimeout(retry);
			observer.disconnect();
			view.removeEventListener("did-attach", attach);
			view.removeEventListener("dom-ready", attach);
		};
	}, [api, id]);

	const pointer = page.pointer;
	const scale = page.viewport ? Math.min(1, size.width / page.viewport.width, size.height / page.viewport.height) : 1;
	const x = Math.max(0, Math.min(size.width - 1, (pointer?.x ?? 0) * page.zoom * scale));
	const y = Math.max(0, Math.min(size.height - 1, (pointer?.y ?? 0) * page.zoom * scale));
	const ripple = pointer && (pointer.action === "click" || pointer.action === "type");
	/*
	 * 自己不设 `visibility`、`pointer-events`：这两样会继承，在这里写死就越过了把它们关掉的祖先——别的会话的标签藏着时
	 * 照样画在上面，拖动面板分隔线时页面（另一个进程）会吞掉那次拖动。
	 */
	return (
		<div className="plume-browser-page">
			<webview ref={ref} src={initialUrl} data-browser-page={id} className="plume-browser-webview" />
			{pointer && (
				<>
					{/* 同一处再点也重播一次：按序号换一个节点，动画从头来。 */}
					{ripple && (
						<div key={pointer.sequence} aria-hidden="true" className="plume-browser-ring" style={{ transform: `translate(${x}px, ${y}px)` }}>
							<svg width="24" height="24" viewBox="0 0 24 24">
								<circle cx="12" cy="12" r="11.5" />
							</svg>
						</div>
					)}
					<div
						aria-hidden="true"
						data-browser-cursor={id}
						data-action={pointer.action}
						className="plume-browser-cursor"
						style={{ transform: `translate(${x}px, ${y}px)` }}
					>
						{/* 贴着右边、下边时翻过来，光标不伸出页面。 */}
						<svg
							width="24"
							height="24"
							viewBox="0 0 32 32"
							fill="none"
							style={{ transform: `scale(${x > size.width - 24 ? -1 : 1}, ${y > size.height - 24 ? -1 : 1})` }}
						>
							<path
								d="M6.2 3.9C4.7 3.4 3.4 4.7 3.9 6.2L11.1 26.2C11.7 27.9 14.1 27.8 14.6 26L17.2 17.2L26 14.6C27.8 14.1 27.9 11.7 26.2 11.1Z"
								strokeWidth="2.5"
								strokeLinejoin="round"
							/>
						</svg>
					</div>
				</>
			)}
		</div>
	);
}
