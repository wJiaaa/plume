import { ROLL_VALUE, useI18n } from "@plume/ui";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { droppedFrom, type PickedFile } from "./attachments/picked.ts";
import type { ComboboxState } from "./CompletionPopup.tsx";
import { FIT_LEVELS, FIT_PROBE, settle, tight } from "./fit.ts";
import { MarkdownField } from "./MarkdownField.tsx";

/**
 * 打字的那张卡片：上面是附件托盘和输入框，下面一排控件。
 *
 * `left` 说这一轮在什么上下文里跑，`right` 是提交时发生的事（模型、思考档位、发送）。右边可以缩：模型名是这一排里唯一短一点也不算错的东西；
 * 缩到认不出时，这一排按 `fit.ts` 的顺序让出标了 `data-plume-fit-drop` 的部分（权限签的字、上下文用量）。
 *
 * 给了 `onFiles` 就收拖放：拖到整个对话区（最近的 `[data-screen]`）上都算，盖一层「松开即可添加」。
 */
export function ComposerShell({
	value,
	onChange,
	onSubmit,
	placeholder,
	left,
	right,
	top,
	extensions,
	editorRef,
	onFiles,
	historyPosition,
	combobox,
}: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	placeholder: string;
	left?: ReactNode;
	right?: ReactNode;
	/** 输入框上方的托盘（附件那一排）。 */
	top?: ReactNode;
	extensions?: Extension;
	editorRef?: { current: EditorView | null };
	onFiles?: (picked: PickedFile[]) => void;
	/** 正翻到输入历史的第几条；不在翻时不给。 */
	historyPosition?: { current: number; total: number } | null;
	/** 输入框上方开着的补全菜单，见 `MarkdownField`。 */
	combobox?: ComboboxState;
}) {
	const { t } = useI18n();
	const shell = useRef<HTMLDivElement>(null);
	const receive = useRef(onFiles);
	receive.current = onFiles;
	/*
	 * 这一排为了放下里面的东西已经让出了多少。
	 *
	 * 在真实的 DOM 上一次同步走完，而不是每次渲染走一级：这里变的通常是宽度，宽度变了不会触发渲染——观察者把级别设回 0，React 看见 0 本来就是 0
	 * 就跳过渲染，量的那个 effect 再也不跑，这一排第一次排版之后就不再适应。所以 `settle` 自己把这一排摆成每一级（CSS 按这个属性藏东西，
	 * 设完立刻读 `scrollWidth` 会逼排版跟上），只把答案交给 React；属性量完放回原样，真正设它的是下面的状态。
	 */
	const bar = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState<number>(FIT_LEVELS.all);
	const remeasure = useCallback(() => {
		const row = bar.current;
		// 量里面那一层：省略号打在 `RollingText` 里面的值上，外层的宽度被它自己卡住，`scrollWidth` 永远不超过 `clientWidth`。
		const handle = row?.querySelector(`.${FIT_PROBE}`) ?? null;
		const probe = handle?.querySelector(`.${ROLL_VALUE}`) ?? handle;
		if (!row || !probe) return;
		const was = row.getAttribute("data-plume-fit");
		const level = settle((at) => {
			row.setAttribute("data-plume-fit", String(at));
			return tight(probe);
		});
		if (was !== null) row.setAttribute("data-plume-fit", was);
		setFit(level);
	}, []);
	useEffect(() => {
		const row = bar.current;
		if (!row) return;
		const observer = new ResizeObserver(remeasure);
		observer.observe(row);
		return () => observer.disconnect();
	}, [remeasure]);
	/*
	 * 每次渲染后也量：这一排不变宽也会装不下自己，选一个名字更长的模型就是。只在这一排的标记变了时量——盒子变了归上面的观察者，
	 * 同样的标记排出来同样宽；读 `scrollWidth` 会排整页，而输入框每敲一个字都重画。
	 */
	const measuredFor = useRef<string | null>(null);
	useLayoutEffect(() => {
		const key = bar.current ? bar.current.innerHTML : null;
		if (key === measuredFor.current) return;
		measuredFor.current = key;
		remeasure();
	});
	/** 拖着文件悬在对话区上时，那一块在屏幕上的位置和圆角：蒙版照着它盖。 */
	const [dragOver, setDragOver] = useState<{ rect: DOMRect; radius: string } | null>(null);
	const accepting = Boolean(onFiles);
	useEffect(() => {
		const root = shell.current;
		if (!accepting || !root) return;
		const zone = root.closest<HTMLElement>("[data-screen]") ?? root;
		const wide = zone !== root;
		/*
		 * 进出要数着：`dragenter`/`dragleave` 在每个子元素上都会成对地来一遍，只看最后一个事件的话蒙版会闪。
		 */
		let depth = 0;
		// 只认文件：拖一段字进来仍然是浏览器自己的事。
		const carries = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files"));
		/*
		 * 兜底：拖动还在这一块上时，浏览器每隔几百毫秒补一次 `dragover`。一秒没等到，就是拖放已经在别处结束了——
		 * 取消一次拖动不保证有成对的 `dragleave`，蒙版不能因此一直盖着。
		 */
		let quiet: ReturnType<typeof setTimeout> | undefined;
		const reset = () => {
			clearTimeout(quiet);
			depth = 0;
			setDragOver(null);
		};
		const alive = () => {
			clearTimeout(quiet);
			quiet = setTimeout(reset, 1000);
		};
		const enter = (event: DragEvent) => {
			if (!carries(event)) return;
			event.preventDefault();
			depth += 1;
			if (wide && depth === 1) setDragOver({ rect: zone.getBoundingClientRect(), radius: getComputedStyle(zone).borderRadius });
			if (wide) alive();
		};
		const over = (event: DragEvent) => {
			if (!carries(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
			if (wide) alive();
		};
		const leave = (event: DragEvent) => {
			if (!carries(event)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDragOver(null);
		};
		const drop = (event: DragEvent) => {
			if (!carries(event) || !event.dataTransfer) return;
			event.preventDefault();
			reset();
			// 同步取路径和目录：事件返回之后 DataTransfer 就空了，见 `droppedFrom`。
			void droppedFrom(event.dataTransfer).then((dropped) => {
				if (dropped.length > 0) receive.current?.(dropped);
			});
		};
		zone.addEventListener("dragenter", enter);
		zone.addEventListener("dragover", over);
		zone.addEventListener("dragleave", leave);
		zone.addEventListener("drop", drop);
		// 拖到别处放下、或者按 Esc 取消，这一块收不到成对的 `dragleave`。
		window.addEventListener("dragend", reset);
		window.addEventListener("drop", reset);
		return () => {
			clearTimeout(quiet);
			zone.removeEventListener("dragenter", enter);
			zone.removeEventListener("dragover", over);
			zone.removeEventListener("dragleave", leave);
			zone.removeEventListener("drop", drop);
			window.removeEventListener("dragend", reset);
			window.removeEventListener("drop", reset);
		};
	}, [accepting]);

	return (
		<div ref={shell} className="plume-composer rounded-2xl border bg-float transition-[border-color]">
			{dragOver &&
				createPortal(
					<div
						data-plume-drop-overlay=""
						aria-hidden
						className="plume-drop-overlay"
						style={{
							left: dragOver.rect.left,
							top: dragOver.rect.top,
							width: dragOver.rect.width,
							height: dragOver.rect.height,
							borderRadius: dragOver.radius,
						}}
					>
						<span className="plume-drop-overlay-label">{t("composer.dropToAdd")}</span>
					</div>,
					document.body,
				)}
			{historyPosition && (
				<div data-history="" className="plume-composer-hint text-caption text-ink-faint">
					{t("composer.history", { current: historyPosition.current, total: historyPosition.total })}
				</div>
			)}
			{top}
			<MarkdownField
				value={value}
				onChange={onChange}
				onSubmit={onSubmit}
				placeholder={placeholder}
				label={t("composer.message")}
				{...(extensions ? { extensions } : {})}
				{...(editorRef ? { editorRef } : {})}
				{...(combobox ? { combobox } : {})}
			/>
			{/* `data-plume-fit` 是这一排让出了多少；styles 里的规则藏掉自己标了可让的部分，见 `composer/fit.ts`。 */}
			<div ref={bar} data-plume-fit={fit} className="plume-composer-bar flex items-center justify-between gap-1">
				<div className="flex shrink-0 items-center gap-1">{left}</div>
				<div className="flex min-w-0 shrink items-center gap-1">{right}</div>
			</div>
		</div>
	);
}

/**
 * 发送和停止是同一枚按钮：一轮开始、结束时图标和底色在原地换，不是一枚消失另一枚出现。
 */
export function ComposerSend({
	running,
	disabled,
	tip,
	onSend,
	onStop,
}: {
	running: boolean;
	disabled?: boolean;
	tip?: string;
	onSend: () => void;
	onStop: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const { t } = useI18n();
	const mode = running ? "stop" : "send";
	const label = running ? t("composer.stop") : (tip ?? t("composer.send"));
	return (
		<button
			type="button"
			data-composer-send={mode}
			data-plume-tip={label}
			aria-label={label}
			disabled={!running && disabled}
			onClick={running ? onStop : onSend}
			className={`plume-composer-control plume-composer-icon relative flex shrink-0 items-center justify-center rounded-lg transition-colors ${running ? "bg-elevated text-ink hover:bg-card-hover" : "bg-ink text-shell enabled:hover:bg-ink/80 disabled:opacity-50"}`}
		>
			<span className="plume-send-icon" data-active={mode === "stop"}>
				<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
					<rect width="11" height="11" rx="1.5" fill="currentColor" />
				</svg>
			</span>
			<span className="plume-send-icon" data-active={mode === "send"}>
				<svg
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden
				>
					<path d="M12 19V5M5 12l7-7 7 7" />
				</svg>
			</span>
		</button>
	);
}
