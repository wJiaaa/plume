/**
 * 带了哪几张图，画成一排：输入框上方和已发出的气泡外面共用这一个。
 *
 * 文件不上这一排：它的全部信息就是名字，而名字已经写在句子里那枚标记上了。图片留着，缩略图答的是「是哪一张」。
 * 解不出来的图退回成一份文件的样子（门类图标加名字）。
 *
 * 齐的是中线，不是高度：图片是方块、退回来的文件是横条，靠 `align-items: center` 排在同一排。
 */

import { SidewaysArrow, translate, useContextMenu, useI18n, useSideways } from "@plume/ui";
import { X } from "@plume/ui/icons";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { attachmentActions } from "./actions.ts";
import { AttachmentMenu } from "./AttachmentMenu.tsx";
import { displayName, isPlaceholderName, nameParts } from "./display.ts";
import { KIND_LABEL, type FileKind } from "./file-kind.ts";
import { FileKindIcon } from "./FileKindIcon.tsx";

export interface StripFile {
	key: string;
	name: string;
	kind: FileKind;
	/** 看得见的那种才有。有它就画缩略图。 */
	src?: string;
	/** 磁盘上的位置，附件真的来自一个文件时才有。 */
	path?: string;
	/** 悬停时多说的那一行，通常是「文件名 + 门类」。 */
	tip?: string;
	/** 界面上叫什么，调用方已经算好的话；不传就按同一套规则算（`displayName`）。 */
	label?: string;
}

/**
 * 取下那一个的按钮：浮在格子右上角，一半探到外面——这类缩略图通行的位置。纵向行距给到 12（横向 8），探出去的
 * 8px 不会压到上一行。
 */
function Remove({ name, onClick }: { name: string; onClick: () => void }) {
	const label = translate("composer.removeAttachment", { name });
	return (
		<button
			type="button"
			data-plume-tip={label}
			aria-label={label}
			onClick={onClick}
			className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
		>
			<X size={11} strokeWidth={2.2} />
		</button>
	);
}

export function AttachmentStrip({
	files,
	align = "start",
	thumbnail = 64,
	layout = "wrap",
	onOpen,
	onRemove,
	eager,
	className = "",
}: {
	files: StripFile[];
	align?: "start" | "end";
	/** 格子的高度，也是图片的边长。 */
	thumbnail?: number;
	/**
	 * 输入框上方是 `row`：独占一行，多了横着滚——那块地方是拿来打字的，换到第三行被挤出屏幕的是输入框自己。
	 * 气泡外面是 `wrap`：发出去的那条带了九张图就该看见九张，横滚会藏东西。
	 */
	layout?: "wrap" | "row";
	/** 点开第 n 张图；序号在有地址的那些里数，不在全部附件里数。 */
	onOpen?: (imageIndex: number, event: MouseEvent<HTMLElement>) => void;
	onRemove?: (file: StripFile) => void;
	/** 输入框里刚放进来的已经在手上，立刻画；气泡外那一排等进了视口再取像素。 */
	eager?: boolean;
	className?: string;
}) {
	const { t } = useI18n();
	const menu = useContextMenu<string>();
	const track = useRef<HTMLDivElement>(null);
	// 横向溢出时：Shift + 滚轮滚得动，两端按剩余内容渐隐，再配一对方向键。
	const edges = useSideways(track);
	/** 每一格的主按钮：菜单里的「预览」替人点它一下，看图器从这一格的位置长出来。 */
	const bodies = useRef(new Map<string, HTMLButtonElement | null>());
	const count = files.length;
	const loadNow = eager ?? Boolean(onRemove);
	/** 解不出来的图（文件挪走了、根本不是图）按地址记下，那一格改画成文件。 */
	const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
	const markBroken = useCallback((src: string) => {
		setBroken((previous) => (previous.has(src) ? previous : new Set(previous).add(src)));
	}, []);

	const regionShot = t("composer.regionShot");
	const tiles = useMemo(() => {
		const kindSeen = new Map<FileKind, number>();
		let imageAt = -1;
		return files.map((file) => {
			const kindIndex = (kindSeen.get(file.kind) ?? 0) + 1;
			kindSeen.set(file.kind, kindIndex);
			// 坏掉的也占一位：调用方点开看图器时用的是它自己那份有地址的清单。
			if (file.src) imageAt += 1;
			const pixels = file.src && !broken.has(file.src) ? file.src : undefined;
			// 格子上是全名；`label` 只在文件本来就没有像样名字时顶上。
			const label = isPlaceholderName(file.name, regionShot)
				? (file.label ?? displayName({ name: file.name, kindLabel: t(KIND_LABEL[file.kind]), kindIndex }, regionShot))
				: file.name;
			const onDisk = attachmentActions.onDisk(file.path);
			return {
				file,
				pixels,
				label,
				parts: nameParts(label),
				imageIndex: imageAt,
				canPreview: pixels ? Boolean(onOpen) : false,
				canOpenExternal: onDisk,
			};
		});
	}, [files, t, regionShot, onOpen, broken]);

	/** 两头化不化开是量出来的：没溢出就不该有任何渐隐。 */
	const measure = useCallback(() => {
		const el = track.current;
		if (!el) return;
		const room = el.scrollWidth - el.clientWidth;
		el.toggleAttribute("data-fade-start", el.scrollLeft > 1);
		el.toggleAttribute("data-fade-end", room > 1 && el.scrollLeft < room - 1);
	}, []);

	useLayoutEffect(measure, [measure, count, layout, thumbnail]);

	useEffect(() => {
		const el = track.current;
		if (!el || layout !== "row") return;

		const observer = new ResizeObserver(measure);
		observer.observe(el);
		el.addEventListener("scroll", measure, { passive: true });

		/*
		 * 竖着的滚轮也拨得动这一排：普通鼠标只有一个竖轮子。只在真的横向溢出、且这一下确实是竖向意图时才接管。
		 * 自己挂监听：React 的 wheel 是被动的，`preventDefault` 不起作用。
		 */
		const wheel = (event: WheelEvent) => {
			if (el.scrollWidth <= el.clientWidth) return;
			if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
			el.scrollLeft += event.deltaY;
			event.preventDefault();
		};
		el.addEventListener("wheel", wheel, { passive: false });

		return () => {
			observer.disconnect();
			el.removeEventListener("scroll", measure);
			el.removeEventListener("wheel", wheel);
		};
	}, [measure, layout]);

	// 刚放进来的那一个排在最右，往往在可视范围外：滚过去让它被看见。
	const known = useRef(count);
	useEffect(() => {
		const el = track.current;
		if (el && layout === "row" && count > known.current) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
		known.current = count;
	}, [count, layout]);

	if (tiles.length === 0) return null;

	const picked = tiles.find((tile) => tile.file.key === menu.target);

	return (
		<div
			data-plume-attachments=""
			data-plume-layout={layout}
			className={`plume-attachments ${layout === "row" ? "relative" : ""} ${align === "end" ? "items-end" : "items-start"} ${className}`}
		>
			<div
				ref={track}
				className={`plume-attachments-track ${layout === "row" ? "plume-attachments-row plume-fade-tail" : "flex-wrap"} ${align === "end" ? "justify-end" : "justify-start"}`}
			>
				{tiles.map(({ file, pixels, label, parts, imageIndex, canPreview, canOpenExternal }) => (
					<div
						key={file.key}
						data-plume-attachment={file.key}
						data-plume-shape={pixels ? "image" : "file"}
						className="plume-attachment"
						onContextMenu={(event) => menu.show(event, file.key)}
					>
						<button
							type="button"
							ref={(node) => {
								bodies.current.set(file.key, node);
							}}
							data-plume-tip={[file.tip, !canPreview && canOpenExternal ? t("attachment.openHint") : null].filter(Boolean).join("\n")}
							aria-label={label}
							/*
							 * 能预览的只挂单击，不能预览的只挂双击（交给系统打开）：两个都挂，一次双击会先预览再启动一个应用。
							 */
							disabled={!canPreview && !canOpenExternal}
							onClick={canPreview && onOpen ? (event) => onOpen(imageIndex, event) : undefined}
							onDoubleClick={
								!canPreview && canOpenExternal ? () => attachmentActions.openExternal({ name: label, ...(file.path ? { path: file.path } : {}) }) : undefined
							}
							className="plume-attachment-body"
							{...(pixels ? { style: { width: thumbnail, height: thumbnail } } : {})}
						>
							{pixels ? (
								// `cover`：一排等大的方块读起来是一组东西。
								<img
									src={pixels}
									alt={label}
									loading={loadNow ? "eager" : "lazy"}
									decoding="async"
									className="h-full w-full object-cover"
									onError={() => markBroken(pixels)}
								/>
							) : (
								<span className="flex h-full items-center gap-1.5">
									<FileKindIcon kind={file.kind} size={14} />
									{/* 名字截中间，扩展名不参与；两段之间不留空隙，它们是同一个名字。 */}
									<span className="flex min-w-0 items-baseline">
										<span className="plume-attachment-name">{parts.stem}</span>
										{parts.ext && <span className="shrink-0 text-ink-muted">.{parts.ext}</span>}
									</span>
								</span>
							)}
						</button>

						{onRemove && (
							// 鼠标挪上来才现身：常驻的话，一排缩略图上最显眼的东西成了「删掉我」。
							<div data-plume-hover-reveal className="plume-attachment-control absolute -top-2 -right-2 rounded-full border border-line bg-float">
								<Remove name={label} onClick={() => onRemove(file)} />
							</div>
						)}
					</div>
				))}
			</div>
			{layout === "row" && (
				<>
					<SidewaysArrow side="left" shown={edges.canLeft} track={track} />
					<SidewaysArrow side="right" shown={edges.canRight} track={track} />
				</>
			)}

			<AttachmentMenu
				anchor={menu.anchor}
				file={
					picked
						? {
								name: picked.label,
								...(picked.file.path ? { path: picked.file.path } : {}),
								// 缩略图都没解出来的那一格没有像素可复制，按文件给菜单。
								...(picked.pixels ? { src: picked.pixels } : {}),
								...(picked.canPreview ? { onPreview: () => bodies.current.get(picked.file.key)?.click() } : {}),
							}
						: null
				}
				onClose={menu.close}
				{...(onRemove && picked ? { onRemove: () => onRemove(picked.file) } : {})}
			/>
		</div>
	);
}
