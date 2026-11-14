import type { HTMLAttributes, ReactNode, Ref } from "react";

/**
 * 自己画顶行的页面（`ui.page` 给了 `topRow: true`）每一栏最上面那一行：坐在窗口顶行的高度上，和侧栏顶上那一行齐平。
 * 整行拖得动窗口、双击能缩放，行里能点的控件（按钮、链接、输入框）自动不拖动，不用一个个标。贴着页面左边的那一栏给
 * `start`（两栏页面的右栏在窄窗口里换成整页时也给），给侧栏收起时浮在这里的红绿灯和前进、后退让出宽度。
 * 高度、内边距之外的排法（间距、两端对齐）由 `className` 补；行里不折行，放不下的东西自己截断。
 *
 * 不给整行 no-drag：那样这一栏宽的一段就既拖不动窗口、也双击不了。Windows、Linux 上窗口顶上另有一条拖窗口的带子，宿主在根元素上
 * 标 `data-plume-window-header`，这一行跟着改成不拖动（`app-region` 不认 `var()`，只能按选择器切）：在卡片里拖窗口会带上系统标题栏的行为（右键系统菜单、拖到屏幕边贴边）。
 *
 * `start` 让出的宽度由宿主经 `--plume-top-row-inset` 给，侧栏开着时是 0。
 */
export function PageTopRow({
	start = false,
	className = "",
	children,
	...rest
}: { start?: boolean; className?: string; children?: ReactNode; ref?: Ref<HTMLElement> } & HTMLAttributes<HTMLElement>) {
	return (
		<header
			{...rest}
			className={`plume-top-row flex h-[var(--plume-top-row-height,44px)] min-w-0 shrink-0 flex-nowrap items-center gap-2 pr-3 [app-region:drag] [:root[data-plume-window-header]_&]:[app-region:no-drag] ${start ? "pl-[max(12px,var(--plume-top-row-inset,0px))]" : "pl-3"} ${className}`.trim()}
		>
			{children}
		</header>
	);
}
