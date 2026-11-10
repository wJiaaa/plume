/**
 * 窗口顶行左端的按钮：后退、前进、侧栏开关。macOS 上从红绿灯后面开始放，Windows、Linux 上放进顶上那条带子（`WindowHeader`），
 * 起点见 titlebar.ts；位置和 no-drag 由调用方管，这里只有按钮和那条带子。
 */

import { macKeyboard, shortcutLabel } from "@plume/ui";
import { ArrowLeft, ArrowRight } from "@plume/ui/icons";
import { type MouseEvent, type ReactNode, useLayoutEffect, useRef } from "react";
import { NATIVE_HEADER_HEIGHT, TOOLBAR_BUTTON } from "../shared/window-chrome.ts";
import type { TitlebarInsets } from "./titlebar.ts";
import { useWindowOverlay } from "./window-overlay.ts";

/** 侧栏开关后面到标题之间的空当。 */
const TOOLBAR_GAP = 10;

/** 侧栏收起时，窗口左上角有多宽归顶行按钮：后退、前进之间 `gap-1.5`，开关前 `gap-0.5`，再留一段空当。 */
export function toolbarReserved(start: number): number {
	return start + TOOLBAR_BUTTON * 3 + 6 + 2 + TOOLBAR_GAP;
}

/** 后退、前进：在这个窗口去过的界面和会话之间来回，规则见 nav-history.ts。 */
export function NavButtons({
	labels,
	canBack,
	canForward,
	onBack,
	onForward,
}: {
	labels: { back: string; forward: string };
	canBack: boolean;
	canForward: boolean;
	onBack: () => void;
	onForward: () => void;
}) {
	const mac = macKeyboard();
	return (
		// 比一排的 `gap-0.5` 宽一点：两个箭头挨太近会读成一个符号。
		<span className="flex items-center gap-1.5">
			<ToolbarButton label={`${labels.back} ${mac ? "⌘[" : "Alt+←"}`} onClick={onBack} disabled={!canBack}>
				<ArrowLeft size={15} strokeWidth={1.9} />
			</ToolbarButton>
			<ToolbarButton label={`${labels.forward} ${mac ? "⌘]" : "Alt+→"}`} onClick={onForward} disabled={!canForward}>
				<ArrowRight size={15} strokeWidth={1.9} />
			</ToolbarButton>
		</span>
	);
}

/**
 * 顶行的图标按钮，比 `IconButton` 的 md 大一档，和红绿灯一样高的一行里要这么大才压得住。
 * 没得退时淡下去、按不动，悬停也不亮。
 */
export function ToolbarButton({
	children,
	label,
	onClick,
	active,
	disabled,
	menu,
}: {
	children: ReactNode;
	label: string;
	onClick: (event: MouseEvent<HTMLButtonElement>) => void;
	/** 窄窗口里抽屉开着时，侧栏开关是按下的样子。 */
	active?: boolean;
	disabled?: boolean;
	/** 会打开菜单；值表示当前展开状态。 */
	menu?: boolean;
}) {
	return (
		<button
			type="button"
			data-plume-tip={shortcutLabel(label)}
			aria-label={shortcutLabel(label)}
			aria-pressed={active}
			aria-haspopup={menu === undefined ? undefined : "menu"}
			aria-expanded={menu}
			disabled={disabled}
			onClick={onClick}
			className={`flex size-7 items-center justify-center rounded-lg transition duration-[var(--plume-t-quick)] ${
				active ? "bg-card-hover text-ink" : "text-ink-faint enabled:hover:bg-card-hover enabled:hover:text-ink disabled:opacity-40"
			}`}
		>
			{children}
		</button>
	);
}

/**
 * Windows、Linux 窗口顶上那条横贯的带子（见 window-chrome.ts 的 `hasHeaderBar`）：整条拖窗口，左端从 `insets.start`
 * 放调用方给的东西，右端空出 `insets.end` 给系统的最小化、最大化、关闭。里面能按的东西由调用方标 no-drag。
 * 底色和窗口外壳同一档，系统按钮的颜色跟着这条带子此刻画出来的颜色走（`useWindowOverlay`）。
 */
export function WindowHeader({ fill, insets, children }: { fill: "bg-sidebar" | "bg-root"; insets: TitlebarInsets; children?: ReactNode }) {
	const band = useRef<HTMLDivElement>(null);
	const symbol = useRef<HTMLSpanElement>(null);
	useWindowOverlay(band, symbol);
	/*
	 * 带子归窗口：浮层（弹层、悬停卡）停在它下面，不铺到系统按钮和拖窗口的那一条上（@plume/ui 的 `chromeTop`）；
	 * 页面自己画的顶行（`PageTopRow`）不再拖窗口。弹层在 portal 里，量不到布局，所以写在根元素上。
	 */
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.style.setProperty("--plume-chrome-top", `${NATIVE_HEADER_HEIGHT}px`);
		root.dataset.plumeWindowHeader = "";
		return () => {
			root.style.removeProperty("--plume-chrome-top");
			delete root.dataset.plumeWindowHeader;
		};
	}, []);
	return (
		<div
			ref={band}
			data-plume-window-header=""
			className={`relative z-40 flex shrink-0 items-center [app-region:drag] ${fill}`}
			// 和交给系统画按钮的高度是同一个常量，带子和按钮不会错开。
			style={{ height: NATIVE_HEADER_HEIGHT, paddingLeft: insets.start, paddingRight: insets.end }}
		>
			{children}
			{/* 只为量出符号色：藏着，但计算样式照样有。 */}
			<span ref={symbol} hidden className="text-ink-muted" />
		</div>
	);
}

/** 侧栏开着时图标左边那一格填上，状态看图标就知道，图标本身不动。 */
export function SidebarIcon({ open }: { open: boolean }) {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<line x1="9.5" y1="4" x2="9.5" y2="20" />
			<rect
				x="3"
				y="4"
				width="6.5"
				height="16"
				rx="2.5"
				fill="currentColor"
				stroke="none"
				className="transition-opacity duration-[var(--plume-t-base)]"
				opacity={open ? 0.5 : 0}
			/>
		</svg>
	);
}
