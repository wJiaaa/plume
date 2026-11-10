/**
 * 一轮对话的过程行：思考、一段工具活、收起的过程，共用的那个骨架。
 *
 * 模型先想，然后动手，最后才说话。这几种行是同一件事的几个阶段，读者是连着看的，所以必须长得像同一种东西：
 * 三个行高、三个间距、三种「正在跑」的说法连着排下来，每隔几行眼睛就要重新认一次这是什么。
 *
 * 只管骨架：一个前置图标、一段装不下就化开的摘要、一个可选的尾部，最后是展开箭头。展开与否、里面画什么是各自的事。
 * 图标和箭头分居两端：图标说「这一行是什么」，箭头说「点开还是收起」。
 *
 * 「正在跑」只有一种说法：摘要上扫过一道光（`.plume-glide`）。不再有第二个转圈的东西陪着它。
 */

import { ChevronRight } from "../icons/index.ts";
import { GLIDE, useTickedAnimations } from "../motion/ticked.ts";
import { motionReduced } from "../motion/reduced.ts";
import { ScrollText } from "../scroll/ScrollText.tsx";
import { type ReactNode, useLayoutEffect, useRef } from "react";

export function FlowRow({
	icon,
	title,
	summary,
	trailing,
	trailFrom,
	running,
	open,
	onToggle,
	label,
	danger = false,
	...rest
}: {
	/** 前置图标，常驻。它说的是这一行是什么，不参与展开、收起。 */
	icon: ReactNode;
	/** 这一行是什么（「自动压缩」）。不参与化开：装不下时先让出地方的永远该是摘要。 */
	title?: ReactNode;
	/** 这一行做了什么。长了两头化开、鼠标放上去自己读出来；运行中它是唯一带动效的东西。 */
	summary?: ReactNode;
	/** 靠右的附注，比如改动行数。 */
	trailing?: ReactNode;
	/** 挂上时附注从这个宽度缓过来，见 `FlowTrail`。 */
	trailFrom?: number | undefined;
	running?: boolean;
	/** 省略即为不可展开：不可展开的行没有箭头，也没有指针手势。 */
	open?: boolean | undefined;
	onToggle?: (() => void) | undefined;
	label?: string;
	/** 整行红字：这一行说的是一次失败（压缩失败）。 */
	danger?: boolean;
} & Record<`data-${string}`, string | undefined>) {
	const expandable = onToggle !== undefined;
	const summaryBox = useRef<HTMLSpanElement>(null);
	useTickedAnimations(summaryBox, GLIDE, Boolean(running));
	const body = (
		<>
			<span className="plume-flow-lead">{icon}</span>
			{title && <span className="shrink-0 font-medium text-ink-faint">{title}</span>}
			{title && summary ? <span className="plume-flow-dot" aria-hidden /> : null}
			{/*
			 * 扫光挂在装字的那一层（`ScrollText` 的 `textClassName`），不挂在外层：悬停一滚，滚动的那层被单独合成，
			 * 外层的 `background-clip: text` 裁不到它的字，整句就没了。
			 */}
			{summary !== undefined && summary !== null && summary !== "" && (
				<span ref={summaryBox} className="plume-flow-summary">
					<ScrollText text={summary} textClassName={running ? "plume-glide" : ""} />
				</span>
			)}
			<FlowTrail from={trailFrom}>{trailing}</FlowTrail>
			{expandable && open !== undefined && <ChevronRight size={12} strokeWidth={2} className="plume-flow-chevron" aria-hidden />}
		</>
	);

	// `plume-scroll` 是摘要悬停自读的钩子：动画挂在文字上，触发它的 `:hover` 属于整行。
	const tone = danger ? "text-danger" : "text-ink-faint hover:text-ink-muted";
	const shell = `plume-flow-row plume-scroll text-label transition-colors ${tone}`;
	if (!expandable) {
		return (
			<div className={shell} role="status" {...rest}>
				{body}
			</div>
		);
	}
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={open}
			aria-label={label}
			data-open={open ? "" : undefined}
			className={`${shell} cursor-pointer text-left`}
			{...rest}
		>
			{body}
		</button>
	);
}

/**
 * 行尾那一小块（+N -M、失败记号、正在思考），宽度变的时候缓过去。
 *
 * 它后面还跟着展开箭头：一次改动跑完，「+1 -1」当帧冒出来，箭头一帧里往右跳一截。量的是里面那层的宽度，动的是外面那层：
 * 外面那层在过渡，里面那层只在内容变了时才变，观察它就不会把过渡的每一帧当成又一次变化。没有尾巴时外层宽 0、里层不留空，
 * 所以它可以一直挂着——从无到有也是缓过去的。
 */
function FlowTrail({ children, from }: { children?: ReactNode; from?: number | undefined }) {
	const outer = useRef<HTMLSpanElement>(null);
	const inner = useRef<HTMLSpanElement>(null);
	// 只在头一次挂上时用一次：之后变了也不该重新起步。
	const start = useRef(from);
	useLayoutEffect(() => {
		const box = outer.current;
		const content = inner.current;
		if (!box || !content || typeof ResizeObserver === "undefined") return;
		let last: number | null = null;
		// 接替原地另一行时从它的行尾宽度起步（见 `WorkStep`），这里就钉上：等观察者第一次回调就晚了一帧。
		const pinned = start.current;
		start.current = undefined;
		if (pinned !== undefined && !motionReduced()) {
			last = content.offsetWidth;
			if (last !== pinned) {
				box.style.width = `${pinned}px`;
				void box.offsetWidth;
				box.style.width = `${last}px`;
			}
		} else box.style.width = "";
		const observer = new ResizeObserver(([entry]) => {
			const width = entry?.borderBoxSize?.[0]?.inlineSize ?? content.offsetWidth;
			if (last === null || last === width || motionReduced()) {
				last = width;
				return;
			}
			// 上一次还没缓完就又变了：从此刻画着的宽度接着走，不跳回上一个终点。
			const current = box.style.width ? box.getBoundingClientRect().width : last;
			last = width;
			box.style.width = `${current}px`;
			void box.offsetWidth;
			box.style.width = `${width}px`;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, []);
	const has = children !== undefined && children !== null && children !== false && children !== "";
	return (
		<span
			ref={outer}
			className="plume-flow-trail"
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "width") event.currentTarget.style.width = "";
			}}
		>
			<span ref={inner} className={has ? "plume-flow-trail-in" : undefined}>
				{has ? children : null}
			</span>
		</span>
	);
}
