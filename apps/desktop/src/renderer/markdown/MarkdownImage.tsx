import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { localImageUrl } from "../files/open-file.ts";
import { useFileScope } from "../files/scope.ts";
import { resolveAsset } from "./assets.ts";

export const ImageDocument = createContext<{
	baseDir?: string;
	sessionId?: string;
	localImages: boolean;
	remoteImages: boolean;
	streaming: boolean;
}>({ localImages: false, remoteImages: false, streaming: false });

function Pending() {
	return <span className="md-image-pending" aria-hidden="true" />;
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
		return (
			<>
				{waiting && <Pending />}
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
			</>
		);
	}
	if ((remote || local) && fetched === undefined) return reveal && checked ? <Pending /> : null;
	return <>{fallback}</>;
}
