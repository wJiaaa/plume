import { useTickedAnimations } from "@plume/ui";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { localImageUrl } from "../files/open-file.ts";
import { useFileScope } from "../files/scope.ts";
import { openViewer } from "../image/index.ts";
import { resolveAsset } from "./assets.ts";

export const ImageDocument = createContext<{
	baseDir?: string;
	sessionId?: string;
	localImages: boolean;
	remoteImages: boolean;
	streaming: boolean;
}>({ localImages: false, remoteImages: false, streaming: false });

/** 图写在链接里（`[![徽章](a.svg)](https://…)`）：点它是去链接，不是看图，按钮也不能套在链接里。 */
export const ImageInLink = createContext(false);

/**
 * 点开一张正文图片：同一条回复（`data-reply-images`，没有时是这一段 Markdown）里显示出来的图连成一组，可以左右翻。
 * 从 DOM 上收：一条回复的话分成好几段 Markdown 各自渲染，彼此不知道对方有哪些图，加载失败退成链接的也自然不在里面。
 */
function openImage(img: HTMLImageElement) {
	const scope = img.closest("[data-reply-images]") ?? img.closest(".markdown");
	const shown = scope ? Array.from(scope.querySelectorAll<HTMLImageElement>(".md-image-open > img.md-image:not([data-waiting])")) : [img];
	const index = Math.max(0, shown.indexOf(img));
	openViewer(
		shown.map((item) => ({ src: item.src, alt: item.alt })),
		index,
		img.getBoundingClientRect(),
		img,
	);
}

/** 占位上的两层点阵动的是 `mask-position`，只能逐帧重绘：按拍走，和正文共用一拍（见 `@plume/ui` 的 `motion/ticked.ts`）。 */
const PENDING: ReadonlySet<string> = new Set(["md-image-sweep", "md-image-drift"]);

function Pending() {
	const box = useRef<HTMLSpanElement>(null);
	useTickedAnimations(box, PENDING);
	return <span ref={box} className="md-image-pending" aria-hidden="true" />;
}

/** 图片是正文的一部分；读取仍受会话目录和文档远程加载策略约束。 */
export function MarkdownImage({
	src,
	alt,
	width,
	height,
	fallback,
}: {
	src: string | null;
	alt: string;
	width?: number;
	height?: number;
	fallback: ReactNode;
}) {
	const doc = useContext(ImageDocument);
	const inLink = useContext(ImageInLink);
	const scope = useFileScope();
	const sessionId = doc.sessionId ?? scope?.sessionId;
	const base = doc.baseDir ?? (doc.localImages ? scope?.cwd : undefined);
	const path = src === null ? null : resolveAsset(base, src);
	const local = Boolean(sessionId && path);
	const remote = doc.remoteImages && src?.startsWith("https://") ? src : null;
	const direct = src?.startsWith("data:") || src?.startsWith("blob:") ? src : null;
	// 历史里的图直接显示，只有看着生成的那一次显影。
	const [reveal] = useState(doc.streaming);
	const [loaded, setLoaded] = useState<string | null>(null);
	const [broken, setBroken] = useState<string | null>(null);
	const [small, setSmall] = useState(false);
	const [read, setRead] = useState<{ source: string; sessionId: string | undefined; path: string | null; value: string | null } | null>(null);
	useEffect(() => {
		if (!src || direct || (!remote && !local)) return;
		let alive = true;
		void (remote ? window.plume.files.remoteImage(remote) : localImageUrl(sessionId!, path!))
			.catch(() => null)
			.then((value) => alive && setRead({ source: src, sessionId, path, value }));
		return () => {
			alive = false;
		};
	}, [src, direct, remote, local, sessionId, path]);
	if (src === null) return <Pending />;
	const fetched = (remote || local) && read?.source === src && read.sessionId === sessionId && read.path === path ? read.value : undefined;
	const resolved = direct ?? fetched;
	const checked = local && doc.localImages && !doc.baseDir;
	if (resolved && resolved !== broken) {
		const settling = reveal && checked;
		const waiting = settling && loaded !== resolved;
		const image = (
			<img
				src={resolved}
				alt={alt}
				loading={waiting ? "eager" : "lazy"}
				onError={() => setBroken(resolved)}
				onLoad={(event) => {
					setLoaded(resolved);
					const img = event.currentTarget;
					const line = Number.parseFloat(getComputedStyle(img).lineHeight) || 24;
					setSmall(Math.min(img.naturalHeight, height ?? Infinity) <= line * 2);
				}}
				style={{ maxWidth: width ? `min(100%, ${width}px)` : undefined, maxHeight: height ? `${height}px` : undefined }}
				className="md-image"
				data-block={checked && !small ? "" : undefined}
				data-waiting={waiting ? "" : undefined}
				data-reveal={settling && !waiting ? "" : undefined}
			/>
		);
		return (
			<>
				{waiting && <Pending />}
				{inLink ? (
					image
				) : (
					// `display: contents`：按钮不占版面，图片照旧按自己的行内、块级规则排。
					<button type="button" className="md-image-open" disabled={waiting} onClick={(event) => openImage(event.currentTarget.querySelector("img")!)}>
						{image}
					</button>
				)}
			</>
		);
	}
	if ((remote || local) && fetched === undefined) return reveal && checked ? <Pending /> : null;
	return <>{fallback}</>;
}
