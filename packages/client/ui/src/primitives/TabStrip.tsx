/**
 * 一排标签，一个滑块滑到选中的那个。
 *
 * card / elevated 那一对放在浅色主题下读起来是反的（见 `controls.css` 里 `.plume-tabs` 上面那段）。
 * 这是通用的那个：任意多个标签，每个和自己的文字一样宽，有计数时计数跟在文字旁边。
 *
 * 切换如果是两块底色在一帧里换位，新旧两个标签之间什么都没走，眼睛得去找变化而不是跟着它。滑块会走，
 * 走这一下说明这些是同一条上的几个位置，而不是几个分开的按钮。
 *
 * 滑块是量出来的，不是算出来的——文字宽度各不相同，计数从 9 变 10 会让其中一个变宽。在 layout effect
 * 里量，第一帧画出来时它已经在位；条或某个标签尺寸变了（字体到了、计数变了）再量。第一次放置不做动画：
 * `data-ready` 把过渡压住，直到滑块已经在某个位置上过，这样它不会从角落飞进来。
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface TabStripItem<T extends string> {
	id: T;
	label: string;
	/** 跟在文字后面，比文字淡。不传或 `undefined` 什么都不画。 */
	count?: number;
	icon?: ReactNode;
}

export function TabStrip<T extends string>({
	items,
	value,
	onChange,
	label,
	className = "",
}: {
	items: readonly TabStripItem<T>[];
	value: T;
	onChange: (value: T) => void;
	/** 标签列表的无障碍名。 */
	label: string;
	className?: string;
}) {
	const strip = useRef<HTMLDivElement>(null);
	const [knob, setKnob] = useState<{ left: number; width: number } | null>(null);
	const [ready, setReady] = useState(false);
	// 滑块位置依赖的东西，拼成一个字符串：每次渲染传进来一个新数组、标签却没变时，
	// 不能把 observer 拆了重建。
	const shape = items.map((item) => `${item.id}\u0000${item.label}\u0000${item.count ?? ""}`).join("\u0001");

	useLayoutEffect(() => {
		const root = strip.current;
		if (!root) return;
		const place = () => {
			const chosen = Array.from(root.querySelectorAll<HTMLElement>("[data-tab]")).find((node) => node.dataset.tab === value);
			if (!chosen) return setKnob(null);
			const next = { left: chosen.offsetLeft, width: chosen.offsetWidth };
			setKnob((was) => (was && was.left === next.left && was.width === next.width ? was : next));
		};
		place();
		const observer = new ResizeObserver(place);
		observer.observe(root);
		for (const node of root.querySelectorAll("[data-tab]")) observer.observe(node);
		return () => observer.disconnect();
	}, [value, shape]);

	// 滑块第一次落位之后过一帧，再让它动。
	useEffect(() => {
		if (!knob || ready) return;
		const frame = requestAnimationFrame(() => setReady(true));
		return () => cancelAnimationFrame(frame);
	}, [knob, ready]);

	/** 方向键在条上走，标签列表本该这样；Home 和 End 跳到两头。 */
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = items.findIndex((item) => item.id === value);
		const target =
			event.key === "ArrowRight"
				? (index + 1) % items.length
				: event.key === "ArrowLeft"
					? (index - 1 + items.length) % items.length
					: event.key === "Home"
						? 0
						: event.key === "End"
							? items.length - 1
							: null;
		if (target === null || !items[target]) return;
		event.preventDefault();
		onChange(items[target].id);
		strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(items[target].id)}"]`)?.focus();
	};

	return (
		<div
			ref={strip}
			role="tablist"
			aria-label={label}
			// 自己不是 Tab 停靠点——焦点落在选中的标签上——但方向键会冒泡到这里。
			tabIndex={-1}
			onKeyDown={onKeyDown}
			className={`plume-tabs relative flex max-w-full items-center overflow-x-auto rounded-lg p-[3px] [scrollbar-width:none] ${className}`}
		>
			{knob && (
				<span
					aria-hidden
					data-ready={ready || undefined}
					className="plume-tabs-knob pointer-events-none absolute inset-y-[3px] left-0 rounded-md data-[ready]:transition-[transform,width] data-[ready]:duration-[var(--plume-t-base)] data-[ready]:ease-out"
					style={{ width: knob.width, transform: `translateX(${knob.left}px)` }}
				/>
			)}
			{items.map((item) => {
				const current = item.id === value;
				return (
					<button
						key={item.id}
						type="button"
						role="tab"
						data-tab={item.id}
						aria-selected={current}
						tabIndex={current ? 0 : -1}
						onClick={() => onChange(item.id)}
						className={`relative z-10 flex h-[28px] shrink-0 items-center gap-1.5 rounded-md px-3.5 text-label whitespace-nowrap transition-[color] duration-[var(--plume-t-quick)] ${
							current ? "font-medium text-ink" : "text-ink-muted hover:text-ink"
						}`}
					>
						{item.icon}
						{item.label}
						{item.count !== undefined && (
							<span className={`text-detail tabular-nums transition-colors duration-[var(--plume-t-quick)] ${current ? "text-ink-muted" : "text-ink-faint"}`}>
								{item.count}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
