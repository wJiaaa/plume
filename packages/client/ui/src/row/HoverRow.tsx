/**
 * 列表行的统一外壳：标题撑满整行，图标浮在上面，悬停时渐隐给图标让位。
 *
 * 会话、项目、git 的行都用它。预留一格 `pr-14` 就是一道空槽；76px 的浮层列是同一个洞换了个名字。
 * 悬停只认 `group/row` 和 `[data-plume-hover-row]` 这两个钥匙；每种行各起一个 `group/session`
 * 之类的名字，正是置顶、归档图标不再亮起来的原因。
 */

import { useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from "react";

/**
 * 控件条量好之前先写进 `--plume-row-controls` 的兜底值。
 *
 * 每个点击区约 21px（`p-1` 加 12.5 的图标）。左边 6px 对应右边的 `pr-1.5`，第一个图标的内距和
 * 最后一个一样。两个按钮的槽给 58px 时比置顶图标多出 17px——那就是多让出去的一段。
 */
export function hoverSlot(actions: 1 | 2 | 3): string {
	if (actions >= 3) return "68px";
	if (actions === 2) return "48px";
	return "28px";
}

export function HoverRow({
	controls,
	className = "",
	style,
	children,
	...rest
}: ComponentPropsWithoutRef<"div"> & {
	controls: string;
}) {
	return (
		<div
			{...rest}
			data-plume-hover-row
			className={`plume-scroll group/row relative ${className}`}
			style={{ ...style, "--plume-row-controls": controls } as CSSProperties}
		>
			{children}
		</div>
	);
}

/** 行首的图标列：每一行 git 都是同一个 12px 的框，工作树不额外缩进。 */
export function HoverRowMark({ className = "", children }: { className?: string; children: ReactNode }) {
	return (
		<span data-plume-row-mark className={`flex h-3 w-3 shrink-0 items-center justify-center ${className}`}>
			{children}
		</span>
	);
}

/** 按内容收缩的浮层。绝不做成定宽的一列：那样会把空着的框也画出来。 */
export function HoverRowReveal({ className = "", children }: { className?: string; children: ReactNode }) {
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		const row = el?.closest("[data-plume-hover-row]") as HTMLElement | null;
		if (!el || !row) return;
		const sync = () => {
			const overlay = el.getBoundingClientRect();
			if (overlay.width < 1) return;
			const title = row.querySelector(".plume-fade-tail");
			const titleRight = title?.getBoundingClientRect().right ?? overlay.right;
			/*
			 * 没有重叠写成 0，而不是跳过不写。
			 *
			 * `controls` 兜底值估的是标题撑满整行、按钮压在它尾巴上的情形。标题没伸到控件条那里时，
			 * 量出来是负数；跳过不写，兜底值就永远留着：悬停时遮罩白白从标题末尾清掉一段，`ScrollText`
			 * 又把这一段算成读不到，于是一个装得下的名字一悬停就开始滚。项目行就是这样。
			 */
			const clear = `${Math.max(0, Math.round(titleRight - overlay.left))}px`;
			if (row.style.getPropertyValue("--plume-row-controls") === clear) return;
			row.style.setProperty("--plume-row-controls", clear);
			/*
			 * 通知这一行里的 `ScrollText` 重新量。它悬停时的判断取决于这个值，但它自己的观察器只看尺寸，
			 * 而且比这个先触发：项目折叠时计数挤进来、标题变窄，它拿旧的重叠量重新判断，然后这里才写入新的。
			 */
			row.dispatchEvent(new Event("plume-row-controls"));
		};
		sync();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(sync);
		observer.observe(el);
		observer.observe(row);
		// 标题也要看：折叠项目会把计数挤进来、标题变窄，而行和控件条的尺寸都不变。
		const title = row.querySelector(".plume-fade-tail");
		if (title) observer.observe(title);
		return () => observer.disconnect();
	}, []);
	return (
		<span
			ref={ref}
			data-plume-hover-reveal
			className={`pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-md px-1.5 opacity-0 transition-opacity duration-[var(--plume-t-quick)] group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 ${className}`}
		>
			{children}
		</span>
	);
}
