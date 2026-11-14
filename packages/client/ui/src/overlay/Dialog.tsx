/**
 * 居中对话框的里面：标题、可选的状态、两端渐隐的正文、按钮。
 *
 * 卡片归 Overlay 管——圆角、遮罩、Escape。各功能自己重搭一遍的话，会发明第二种圆角，在标题和按钮之间
 * 画一道细线，两者读起来就不再是一家。这里只有内边距和几个槽位，不画分隔线。这里的边界是留白。
 */

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { Overlay, type Dismiss } from "./Overlay.tsx";
import { Scroller } from "../scroll/Scroller.tsx";

/**
 * 对话框底下的那一颗按钮。上面写着它会做的那件事：写字，不画图标。
 *
 * 这些按钮曾经有好几处只放一个 ✕ 和一个 ✓，名字挂在 tooltip 上。工具栏
 * 里的图标按钮可以这么省——周围一排东西替它说明它属于哪一类；对话框底下这两颗没有这个周围，
 * 它们是这次操作的结论本身，一个要说清按下去会发生什么，另一个要说清不按会怎样。一个勾在
 * 「删除会话」「卸载插件」「导入 33 个模型」上长得一模一样，而读出区别的唯一办法是把鼠标停
 * 上去等一个 tooltip——这正是一个「停下一切来问」的界面最不该要求的动作。
 *
 * `label` 留着，但只当 tooltip 用：可见的字已经是它的名字了。
 */
export function DialogAction({
	children,
	onClick,
	tone = "secondary",
	disabled,
	autoFocus,
	label,
	className = "",
	...rest
}: {
	children: ReactNode;
	onClick?: () => void;
	tone?: "secondary" | "primary" | "danger";
	disabled?: boolean;
	autoFocus?: boolean;
	/** 只当悬停提示。可见的字已经是按钮的名字。 */
	label?: string;
	className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick" | "type">) {
	const paint = tone === "danger" ? "plume-dialog-action-danger" : tone === "primary" ? "plume-dialog-action-primary" : "plume-dialog-action-secondary";
	return (
		<button
			type="button"
			disabled={disabled}
			autoFocus={autoFocus}
			onClick={onClick}
			data-plume-tip={label}
			className={`plume-dialog-action ${paint} disabled:opacity-40 ${className}`}
			{...rest}
		>
			{children}
		</button>
	);
}

export function DialogFrame({
	title,
	icon,
	detail,
	status,
	children,
	actions,
	height,
	bodyClassName,
	className = "",
	...rest
}: {
	title: ReactNode;
	icon?: ReactNode;
	detail?: ReactNode;
	/** 放在正文里、滚动区上方——进度、警告，任何不能被滚走的东西。 */
	status?: ReactNode;
	children?: ReactNode;
	actions: ReactNode;
	height?: number;
	/**
	 * 滚动的正文最高能长到多高。只给是表单而不是问题的对话框用——默认值按一段话加一个列表定的，
	 * 设置表单放在它下面一次只能滚出三个字段。
	 */
	bodyClassName?: string;
	className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "title" | "children">) {
	const locked = height !== undefined;
	return (
		<div data-plume-dialog style={locked ? { height } : undefined} className={`flex min-h-0 flex-col ${className}`} {...rest}>
			<div className="shrink-0 px-5 pt-5">
				<h2 className="flex items-center gap-2.5 text-label font-medium text-ink" data-dialog-title>
					{icon}
					{title}
				</h2>
				{detail ? <div className="mt-3 text-label leading-relaxed text-ink-muted">{detail}</div> : null}
			</div>
			{status || children ? (
				<div className={`flex min-h-0 flex-col px-5 pt-4 ${locked ? "flex-1" : ""}`}>
					{status}
					{children ? (
						/*
						 * 滚动面伸进两侧的边距，视口再用同样的内衬收回来。
						 *
						 * 滑块是叠在内容上的（见 `Scroller`），而这里内容的右缘原来就是滚动面的右缘——于是右
						 * 对齐的那一列正好落在滑块底下：列表里每行末尾右对齐的数字被盖掉半个字。
						 *
						 * 不学菜单那样给视口加右内衬（`.plume-menu-scroll`）：那会让列表比上面的状态行窄一截，
						 * 右对齐的列和「全选」就错开了。这样伸出去再收回来，内容的位置和宽度一点不变，有没有
						 * 滚动条都不重排，滑块落在右边距里。两侧对称，是因为行和控件比字宽出去的底色、聚焦环
						 * 以前被滚动面按内容区裁掉了，现在两边都画得出来。
						 *
						 * 伸出去的正好是整条边距（20）：滑块离卡片边缘 2px；行底色宽出去的 10px 和滑块之间还剩 2px。
						 */
						<Scroller
							top="fade"
							bottom="fade"
							className={`-mx-5 ${locked ? "min-h-0 flex-1" : (bodyClassName ?? "max-h-[min(420px,50dvh)]")}`}
							contentClassName={`px-5 ${status ? "pt-3 pb-1" : "pb-1"}`}
						>
							{children}
						</Scroller>
					) : null}
				</div>
			) : null}
			<div className="flex shrink-0 items-center gap-2 px-5 pt-5 pb-5" data-plume-dialog-actions>
				{actions}
			</div>
		</div>
	);
}

/**
 * 里面放着 `DialogFrame` 的 `Overlay`。`actions` 和 `children` 可以是 `dismiss` 的函数，关对话框的按钮
 * 应该用它：`dismiss()` 播完退场再运行 `onClose`，`dismiss(after)` 改为运行 `after`。
 *
 * 按钮直接调用 `onClose` 会在那一帧卸掉对话框——那样只有 Escape 和点遮罩是怎么来的就怎么走。
 */
export function Dialog({
	onClose,
	width = 480,
	label,
	returnFocus,
	actions,
	children,
	...frame
}: {
	onClose: () => void;
	width?: number;
	label?: string;
	returnFocus?: HTMLElement;
	actions: ReactNode | ((dismiss: Dismiss) => ReactNode);
	children?: ReactNode | ((dismiss: Dismiss) => ReactNode);
} & Omit<Parameters<typeof DialogFrame>[0], "actions" | "children">) {
	return (
		<Overlay onClose={onClose} width={width} label={label} returnFocus={returnFocus}>
			{(dismiss) => (
				<DialogFrame {...frame} actions={typeof actions === "function" ? actions(dismiss) : actions}>
					{typeof children === "function" ? children(dismiss) : children}
				</DialogFrame>
			)}
		</Overlay>
	);
}
