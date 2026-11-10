/**
 * 文件面板里的图片，大小由你定。
 *
 * 只按面板大小缩放的 `<img>` 看不清 12 像素的图标，也看不清截图的一角，而仓库里提交的图片大多就是这两种。
 * 所以：滚轮以指针为中心缩放，拖动平移，双击在「适应面板」和「实际大小」之间切换——看图软件都是这几下。
 */

import { IconButton, Text, translate } from "@plume/ui";
import { Maximize2, Minus, Plus, RotateCcw } from "@plume/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";

/** 放大到能看一个像素，缩小到能看全一张海报。 */
const MIN_SCALE = 0.05;
const MAX_SCALE = 32;

const ICON = { size: 12, strokeWidth: 1.9 } as const;

const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

export function ImagePane({ src, name }: { src: string; name: string }) {
	const viewport = useRef<HTMLDivElement>(null);
	/** null 是「适应面板」，和任何一个具体倍数都不是一回事。 */
	const [scale, setScale] = useState<number | null>(null);
	const [offset, setOffset] = useState({ x: 0, y: 0 });
	const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
	const [fitted, setFitted] = useState(1);
	/**
	 * 倍数变化要不要滑过去。有人缩放过才滑。
	 *
	 * 第一次适应不是缩放：图到之前没有尺寸可适应，它停在 100%，一张 1200×1800 的截图按原大画出来，再用给滚轮的
	 * 那段过渡缩进面板——每打开一个文件都闪一下。
	 */
	const [gliding, setGliding] = useState(false);
	const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
	const [dragging, setDragging] = useState(false);

	// 换了一张图从头来，不接着上一张的缩放。
	useEffect(() => {
		setScale(null);
		setOffset({ x: 0, y: 0 });
		setNatural(null);
		setGliding(false);
	}, [src]);

	/** 这么大的图在现在的面板里「适应」是多少倍。 */
	const fitFor = useCallback((size: { width: number; height: number }) => {
		const box = viewport.current?.getBoundingClientRect();
		// 适应只缩不放：16px 的图标撑满面板不是适应的意思。
		return box ? Math.min(1, (box.width - 24) / size.width, (box.height - 24) / size.height) : 1;
	}, []);

	// 面板能拖宽拖窄，「适应」跟着变。
	useEffect(() => {
		const element = viewport.current;
		if (!element || !natural) return;
		const observer = new ResizeObserver(() => setFitted(fitFor(natural)));
		observer.observe(element);
		return () => observer.disconnect();
	}, [natural, fitFor]);

	const effective = scale ?? fitted;

	/** 以指针为中心缩放：以中心缩放的话，凑近看的那一处正好滑走。 */
	const zoomAt = useCallback(
		(factor: number, clientX?: number, clientY?: number) => {
			const box = viewport.current?.getBoundingClientRect();
			const from = scale ?? fitted;
			const to = clamp(from * factor);
			if (to === from) return;
			if (box && clientX !== undefined && clientY !== undefined) {
				// 指针相对面板中心的位置，缩放前后保持不动。
				const dx = clientX - (box.left + box.width / 2);
				const dy = clientY - (box.top + box.height / 2);
				const ratio = to / from;
				setOffset((current) => ({ x: dx - (dx - current.x) * ratio, y: dy - (dy - current.y) * ratio }));
			}
			setScale(to);
			setGliding(true);
		},
		[scale, fitted],
	);

	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			// 触控板捏合是带 ctrl 的滚轮；普通滚轮在这里也是缩放，面板里没有别的可滚。
			event.preventDefault();
			zoomAt(Math.exp(-event.deltaY / 320), event.clientX, event.clientY);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [zoomAt]);

	const reset = () => {
		setScale(null);
		setOffset({ x: 0, y: 0 });
		setGliding(true);
	};

	return (
		<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
			<div
				ref={viewport}
				className="file-image-checker relative min-h-0 flex-1 overflow-hidden"
				style={{ cursor: dragging ? "grabbing" : effective > fitted ? "grab" : "default" }}
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
					setDragging(true);
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					const from = drag.current;
					if (!from) return;
					setOffset({ x: from.ox + (event.clientX - from.x), y: from.oy + (event.clientY - from.y) });
				}}
				onPointerUp={(event) => {
					drag.current = null;
					setDragging(false);
					event.currentTarget.releasePointerCapture(event.pointerId);
				}}
				onDoubleClick={(event) => {
					// 实际大小，或者回到适应：要的就是这两种大小。
					if (scale === null) zoomAt(1 / Math.max(fitted, MIN_SCALE), event.clientX, event.clientY);
					else reset();
				}}
			>
				<img
					src={src}
					alt={name}
					draggable={false}
					data-gliding={gliding && !dragging ? "" : undefined}
					onLoad={(event) => {
						const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
						// 和露出来放在同一次更新里：第一帧就已经是适应后的大小。
						setFitted(fitFor(size));
						setNatural(size);
					}}
					className="file-image absolute top-1/2 left-1/2 max-w-none origin-center select-none"
					style={{
						transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${effective})`,
						// 放大过 3 倍改用最近邻：这时要分清的是哪个像素是哪个，平滑反而碍事。
						imageRendering: effective >= 3 ? "pixelated" : "auto",
						visibility: natural ? "visible" : "hidden",
					}}
				/>
			</div>

			{/* 几个按钮，和两个值得知道的数：图多大，你放成了多大。 */}
			<div className="flex shrink-0 items-center gap-1 border-t border-line-soft px-2 py-1.5">
				<IconButton size="xs" icon={<Minus {...ICON} />} label={translate("common.zoomOut")} onClick={() => zoomAt(1 / 1.4)} />
				<IconButton size="xs" icon={<Plus {...ICON} />} label={translate("common.zoomIn")} onClick={() => zoomAt(1.4)} />
				<IconButton
					size="xs"
					icon={<Maximize2 {...ICON} />}
					label={translate("common.actualSize")}
					onClick={() => {
						setScale(1);
						setGliding(true);
					}}
				/>
				<IconButton size="xs" icon={<RotateCcw {...ICON} />} label={translate("common.fitWindow")} onClick={reset} />
				<span className="ml-1">
					<Text size="caption" tone="faint" numeric>
						{Math.round(effective * 100)}%
					</Text>
				</span>
				{natural && (
					<span className="ml-auto">
						<Text size="caption" tone="faint" numeric>
							{natural.width} × {natural.height}
						</Text>
					</span>
				)}
			</div>
		</div>
	);
}
