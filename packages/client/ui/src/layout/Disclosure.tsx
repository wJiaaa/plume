/**
 * 一段能折起来的内容，以及它长什么样的唯一定义处。
 *
 * 同一件事可以有好几种写法：`▾` 字符换成 `▸`、一个时有时无的箭头、一块直接渲染或不渲染的内容。三种读起来
 * 都像不同的机制，而不是同一个意思；字符那种最糟——字形按字体自己高兴的粗细画，还不能旋转，于是展开是一次
 * 替换而不是一个动作。
 *
 * 浏览器自己的 `<details>` 也不行：它按平台的大小和粗细画一枚系统三角，没有过渡地一下弹开，点击区域只在
 * 标记那十一个像素上。和页面上其他东西放在一起，它像是从另一个应用里贴过来的。
 *
 * 这里定下来的：
 *
 *   - 箭头旋转而不是被替换，状态是同一个东西的两个位置；
 *   - 内容展开到它自己的高度（`plume-reveal`），收起和展开是同一个手势，而不是一刀切；
 *   - 标题是一个盖住整行的真按钮，点击区域是这一行，而不是箭头那十一个像素；
 *   - 计数跟在标题旁边而不是写进标题里，因为「活动 3」是一个标题加一个数量，不是一个五个字的标题。
 */

import { ChevronRight } from "../icons/index.ts";
import { type ReactNode, useState } from "react";

/**
 * 同一种折叠的三种摆法。
 *
 * `section` 是上面带一条线的标题，给详情视图里的各个部分；`compact` 是行内的一句，没有自己的外框；`framed`
 * 是正文流里的一个框——README 里 `<details>` 的样子，也是表单底部「高级」那一块。
 */
const LOOK = {
	section: {
		root: "border-t border-line-soft first:border-t-0",
		head: "",
		button: "py-2.5",
		title: "text-label font-medium",
		body: "pb-3",
	},
	compact: {
		root: "",
		head: "",
		button: "py-1",
		title: "text-detail",
		body: "pl-3.5",
	},
	framed: {
		root: "overflow-hidden rounded-lg border border-line-soft",
		head: "pr-3",
		button: "py-2 pl-3",
		/*
		 * 没有自己的字号。framed 的折叠坐在页面已经定好字号的正文里——README 按 label 字号、消息按 body
		 * 字号——标题和周围的字差一档，读起来就像贴进来的第二份文档。
		 */
		title: "",
		body: "px-3 pb-3",
	},
} as const;

/*
 * 要么调用方持有状态，要么谁都不需要持有。
 *
 * 崩溃后面的「组件栈」、表单底部的「高级」：页面上没有别的东西在乎它们开没开，让每个这样的调用方为此都持有
 * 一个 `useState`，它们就会转而去用 `<details>`。给了 `open`，由调用方决定；都不给，折叠自己记着。各给一半
 * 是类型错误。
 */
type Control = { open: boolean; onToggle: () => void; defaultOpen?: never } | { open?: never; onToggle?: never; defaultOpen?: boolean };

export function Disclosure({
	title,
	count,
	trailing,
	children,
	variant = "section",
	...control
}: {
	title: ReactNode;
	/** 显示在标题后面。零值得说；undefined 不说。 */
	count?: number;
	/** 属于这一段而不是它的内容的控件——一个编辑按钮、一个链接。 */
	trailing?: ReactNode;
	children: ReactNode;
	variant?: keyof typeof LOOK;
} & Control) {
	const [selfOpen, setSelfOpen] = useState(control.defaultOpen ?? false);
	const open = control.open ?? selfOpen;
	const toggle = control.onToggle ?? (() => setSelfOpen((was) => !was));
	const look = LOOK[variant];

	return (
		<section className={look.root}>
			<div className={`flex items-center gap-1 ${look.head}`}>
				{/*
				 * 悬停不铺底色。
				 *
				 * `plume-item` 是列表行的做法——一块颜色说「这一整条是一个可以选的东西」。段落标题不是那样：它坐在
				 * 它所标注的内容里，指针经过时一条灰带扫过页面，读起来像有东西被选中，而不是标题注意到了你。
				 *
				 * 可点的提示是箭头和标题变深，标题要说自己能按，这就够了。
				 */}
				<button
					type="button"
					onClick={toggle}
					aria-expanded={open}
					className={`group/disclosure flex min-w-0 flex-1 items-center gap-1.5 pr-1.5 text-left ${look.button}`}
				>
					{/*
					 * 一枚箭头，转过去。收起时朝右，展开时朝下——展开三角一向是这样转的，所以不用文字也读得懂。
					 */}
					<ChevronRight
						size={13}
						strokeWidth={2.2}
						className="shrink-0 text-ink-faint transition-[transform,color] duration-[var(--plume-t-base)] ease-out group-hover/disclosure:text-ink-muted"
						style={{ transform: open ? "rotate(90deg)" : undefined }}
					/>
					<span className={`${look.title} text-ink-muted transition-colors duration-[var(--plume-t-quick)] group-hover/disclosure:text-ink`}>{title}</span>
					{count !== undefined && <span className="text-detail text-ink-faint tabular-nums">{count}</span>}
				</button>

				{trailing}
			</div>

			<div className="plume-reveal" data-open={open} aria-hidden={!open} inert={!open}>
				<div>
					<div className={look.body}>{children}</div>
				</div>
			</div>
		</section>
	);
}
