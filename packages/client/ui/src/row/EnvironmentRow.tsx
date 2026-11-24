/**
 * 环境卡片里的一行（`ui.environmentSection` 的 `background`、`output`、`foot` 几块都用它）：前置图标、一句话、行尾一小段事实，
 * 悬停时行尾换成一颗动作按钮。卡片里的行出自好几个插件，长得一样才读得出是同一张卡片。
 *
 * 只有一套说法：「还在跑」是图标右下角一个绿点；「还剩多少」是行底一根细线（`progress`），快到点了（`urgent`）换成强调色；
 * 行尾一律是浅色小字。图标一律浅灰，不按种类上色。
 */

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ChevronDown } from "../icons/index.ts";
import { ScrollText } from "../scroll/ScrollText.tsx";

export function EnvironmentRow({
	icon,
	title,
	detail,
	fact,
	running = false,
	progress,
	urgent = false,
	tip,
	onClick,
	action,
	...rest
}: {
	/** 前置图标，14px，说这一行是什么（命令、检查、子智能体）。 */
	icon: ReactNode;
	/** 这一行的那句话：人写的、或者命令的说明。装不下时悬停读出来。 */
	title: string;
	/** 标题正下方的第二行淡色说明：日期时间这类较长的事实放这里，不和标题挤在一行里。 */
	detail?: ReactNode;
	/** 行尾的事实：端口、几点、`2/5`、「已完成」。短；要说清的长话放 `detail` 或 `tip`。 */
	fact?: ReactNode;
	/** 还在跑：图标右下角挂绿点。 */
	running?: boolean;
	/** 0–1，行底那根细线画多长：检查是剩下的时间，进度是走完的那段。不给就没有线。 */
	progress?: number | undefined;
	/** 快到点了：细线、图标和行尾换成强调色（检查的最后一分钟）。 */
	urgent?: boolean;
	/** 悬停提示，挂在整行上：完整的命令、种类和时间。 */
	tip?: string | undefined;
	/** 点了去哪；不给时这一行只是一条记录，不能点。 */
	onClick?: (() => void) | undefined;
	/** 悬停、键盘焦点进来时盖住行尾的那颗按钮：停下、取消。`label` 是按钮上的字。 */
	action?: ({ label: string; onClick: () => void; disabled?: boolean } & Record<`data-${string}`, string | undefined>) | undefined;
} & Record<`data-${string}`, string | undefined>) {
	const rowRef = useRef<HTMLDivElement>(null);
	const actionRef = useRef<HTMLButtonElement>(null);
	const stacked = detail !== undefined;
	const hasAction = action !== undefined;
	const { label, onClick: act, disabled, ...actionData } = action ?? { label: "", onClick: () => {} };

	// 动作按钮浮在行右端、不占常规列宽，平时标题撑满整行；悬停时按按钮与标题的实际重叠量给 `ScrollText` 让位。
	useLayoutEffect(() => {
		const row = rowRef.current;
		const button = actionRef.current;
		if (!hasAction || !row || !button) return;
		const sync = () => {
			const overlay = button.getBoundingClientRect();
			if (overlay.width < 1) return;
			const titleEl = row.querySelector(".plume-fade-tail");
			const titleRight = titleEl?.getBoundingClientRect().right ?? overlay.right;
			const clear = `${Math.max(0, Math.round(titleRight - (overlay.left - 6)))}px`;
			if (row.style.getPropertyValue("--plume-row-controls") === clear) return;
			row.style.setProperty("--plume-row-controls", clear);
			row.dispatchEvent(new Event("plume-row-controls"));
		};
		sync();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(sync);
		observer.observe(button);
		observer.observe(row);
		const titleEl = row.querySelector(".plume-fade-tail");
		if (titleEl) observer.observe(titleEl);
		return () => observer.disconnect();
	}, [hasAction, label, stacked]);

	const titleClass = hasAction ? "plume-fade-tail" : undefined;
	const body = (
		<>
			<span className="plume-env-row-icon" data-running={running ? "" : undefined}>
				{icon}
			</span>
			{stacked ? (
				<span className="plume-env-row-text">
					<span className="plume-env-row-title">
						<ScrollText text={title} className={titleClass} />
					</span>
					<span className="plume-env-row-fact plume-env-row-detail">{detail}</span>
				</span>
			) : (
				<span className="plume-env-row-title">
					<ScrollText text={title} className={titleClass} />
				</span>
			)}
		</>
	);
	return (
		<div
			ref={rowRef}
			className="plume-env-row plume-scroll"
			data-environment-item=""
			data-plume-hover-row={hasAction ? "" : undefined}
			data-stacked={stacked ? "" : undefined}
			data-has-progress={progress !== undefined ? "" : undefined}
			data-urgent={urgent ? "" : undefined}
			data-has-action={hasAction ? "" : undefined}
			style={hasAction ? ({ "--plume-row-controls": "52px" } as CSSProperties) : undefined}
			{...rest}
		>
			{onClick ? (
				<button type="button" className="plume-env-row-main" data-plume-tip={tip} onClick={onClick}>
					{body}
				</button>
			) : (
				<div className="plume-env-row-main" data-plume-tip={tip}>
					{body}
				</div>
			)}
			{fact !== undefined && <span className="plume-env-row-fact">{fact}</span>}
			{action && (
				<button ref={actionRef} type="button" className="plume-env-row-action" disabled={disabled} onClick={act} {...actionData}>
					{label}
				</button>
			)}
			{progress !== undefined && (
				<span className="plume-env-row-progress" aria-hidden>
					<i style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress))})` }} />
				</span>
			)}
		</div>
	);
}

/**
 * 环境卡片顶部与版本控制里的分体操作行或整行下拉（打开方式、项目脚本、分支切换、Git 快捷操作共用）。
 *
 * - 传 `onClick` 时是分体行：左半触发主动作，右半 32px 箭头触发菜单，悬停或展开时浮出中间竖线；
 * - 省略 `onClick` 只传 `onMenuClick` 时是整行下拉：整行作为菜单触发按钮，右侧保留 32px 箭头与悬停竖线。
 */
export function EnvironmentSplitRow({
	icon,
	title,
	tip,
	ariaLabel,
	disabled = false,
	busy = false,
	working = false,
	feedback = false,
	open = false,
	onClick,
	onMenuClick,
	menuLabel,
	menuTip,
	menuDisabled = false,
	hideMenu = false,
	onPointerEnter,
	...rest
}: {
	/** 前置图标（16px 图标列），与 `EnvironmentRow` 对齐。 */
	icon: ReactNode;
	/** 这一行的标题文字；装不下时悬停滚动读出。 */
	title: string;
	/** 主动作区域的悬停提示。 */
	tip?: string | undefined;
	/** 整行或按钮组的无障碍名称。 */
	ariaLabel?: string | undefined;
	/** 主动作禁用态（变淡、不可点击，但仍保留悬停提示）。 */
	disabled?: boolean;
	/** 正在切换时的忙碌标记（`aria-busy`）。 */
	busy?: boolean;
	/** 正在执行耗时操作：高亮行底色、文字保持可读，常与 `hideMenu` 配合。 */
	working?: boolean;
	/** 刚完成后的短暂行内反馈：不可点击但保持清晰可读。 */
	feedback?: boolean;
	/** 下拉菜单当前是否展开。 */
	open?: boolean;
	/** 左半主动作点击处理；省略时整行作为下拉触发按钮调用 `onMenuClick`。 */
	onClick?: (() => void) | undefined;
	/** 右侧菜单按钮（或整行下拉）点击处理，参数为整行容器元素，便于菜单与整行等宽对齐。 */
	onMenuClick?: ((anchor: HTMLElement) => void) | undefined;
	/** 右侧菜单按钮的无障碍名称。 */
	menuLabel?: string | undefined;
	/** 右侧菜单按钮的悬停提示；省略时回退为 `menuLabel`。 */
	menuTip?: string | undefined;
	/** 禁用右侧菜单按钮。 */
	menuDisabled?: boolean;
	/** 隐藏右侧分隔线与下拉箭头（例如行内显示执行进度时）。 */
	hideMenu?: boolean;
	/** 指针进入整行时的回调（用于按需刷新状态）。 */
	onPointerEnter?: (() => void) | undefined;
} & Record<`data-${string}`, string | undefined>) {
	const groupRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	if (!onClick && onMenuClick) {
		return (
			<button
				ref={buttonRef}
				type="button"
				className="plume-env-split plume-env-select plume-scroll"
				data-open={open || undefined}
				aria-label={ariaLabel ?? title}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-busy={busy || undefined}
				disabled={disabled || menuDisabled}
				data-plume-tip={tip}
				onPointerEnter={onPointerEnter}
				onClick={() => {
					if (buttonRef.current) onMenuClick(buttonRef.current);
				}}
				{...rest}
			>
				<span className="plume-env-split-main">
					<span className="plume-env-row-icon" aria-hidden>
						{icon}
					</span>
					<span className="plume-env-split-title">
						<ScrollText text={title} />
					</span>
				</span>
				{!hideMenu && (
					<>
						<span aria-hidden className="plume-env-split-sep" />
						<span className="plume-env-split-caret" aria-hidden>
							<ChevronDown size={15} strokeWidth={1.8} />
						</span>
					</>
				)}
			</button>
		);
	}

	const mainLocked = working || feedback;
	return (
		<div
			ref={groupRef}
			role="group"
			aria-label={ariaLabel}
			className="plume-env-split plume-scroll"
			data-open={open || undefined}
			data-working={working ? "" : undefined}
			onPointerEnter={onPointerEnter}
			{...rest}
		>
			<button
				type="button"
				className="plume-env-split-main"
				aria-label={ariaLabel && !onMenuClick ? ariaLabel : undefined}
				disabled={mainLocked}
				aria-disabled={!mainLocked && disabled ? true : undefined}
				data-feedback={feedback ? "" : undefined}
				data-plume-tip={tip}
				onClick={() => {
					if (mainLocked || disabled) return;
					onClick?.();
				}}
			>
				<span className="plume-env-row-icon" aria-hidden>
					{icon}
				</span>
				<span className="plume-env-split-title">
					<ScrollText text={title} />
				</span>
			</button>
			{!hideMenu && onMenuClick && (
				<>
					<span aria-hidden className="plume-env-split-sep" />
					<button
						type="button"
						className="plume-env-split-caret"
						aria-label={menuLabel}
						aria-haspopup="menu"
						aria-expanded={open}
						data-plume-tip={menuTip ?? menuLabel}
						disabled={menuDisabled}
						onClick={() => {
							if (groupRef.current) onMenuClick(groupRef.current);
						}}
					>
						<ChevronDown size={15} strokeWidth={1.8} />
					</button>
				</>
			)}
		</div>
	);
}
