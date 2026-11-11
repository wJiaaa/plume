import { useRef, type ComponentPropsWithoutRef } from "react";

import { OverlayScrollbar } from "../scroll/OverlayScrollbar.tsx";
import { Textarea } from "./NativeField.tsx";
import { useFieldFade } from "./useFieldFade.ts";

/**
 * 写很多字的地方，一种写法。
 *
 * 各处的多行输入框各写各的类名串，会长出好几种圆角、内衬和底色——而它们要人做的是同一件事。
 * 样子由 `.plume-textarea-shell` / `.plume-textarea` 出（见 `@plume/styles` 的 `ui/controls.css`），
 * 调用方只说高度和位置。
 *
 * 三样东西是一起来的，缺一件那个框就回到从前：
 *
 * - **边界在外壳上**。虚化收的是元素画出的一切，描边和字同在一个元素上，滚到顶时框的上下边会跟
 *   着字一起淡掉，像破了个口子。
 * - **滑块是自己画的**。原生滚动条在全局被关掉了（见 `OverlayScrollbar` 的开头），不补一个，一
 *   篇长草稿滚起来没有任何东西说它有多长。
 * - **两头化开**。硬切的半行字读起来像渲染坏了，见 `useFieldFade`。
 *
 * 主输入框、消息编辑框这类框里还站着别的东西（工具栏、附件条、那排按钮）的不走这里，外壳是各自的。
 * 共享的是同一个 `useFieldFade` 和同一条遮罩。
 */
export function TextArea({
	value,
	onChange,
	shell = "",
	className = "",
	resizable = false,
	...rest
}: {
	value: string;
	onChange: (value: string) => void;
	/** 外壳上的额外类。高度、外边距、宽度——和这个框在页面上待在哪儿有关的事，调用方说了算。 */
	shell?: string;
	/** 字那一层的额外类：等宽、字号、`h-[180px]` 这类只跟可写区域有关的。 */
	className?: string;
	/** 能不能用鼠标拉高。只给写长文的地方，比如一份系统提示词。 */
	resizable?: boolean;
} & Omit<ComponentPropsWithoutRef<"textarea">, "value" | "onChange" | "className" | "ref">) {
	const field = useRef<HTMLTextAreaElement>(null);
	const host = useRef<HTMLDivElement>(null);
	useFieldFade(field, host);

	return (
		<div className={`plume-textarea-shell ${shell}`}>
			{/*
			 * `h-full` 在两种外壳里都对：外壳给了高度（`h-[180px]`）就铺满它，没给就解析成 auto，
			 * `rows` 说了算。所以调用方只需要说一次高度，说在外壳上——边框跟着高度走，描边才不会
			 * 比它框住的东西矮一截。
			 */}
			<div ref={host} className="plume-scroll-host relative h-full">
				<Textarea
					{...rest}
					ref={field}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					/*
					 * 属性，不是 `resize-y`。`.plume-textarea` 的 `resize: none` 是手写 CSS，而
					 * `ui.css` 下一律没有分层——未分层的规则压过 `@layer utilities` 里的工具类，
					 * 跟谁写在后面无关。那条工具类会安安静静地不生效。
					 */
					data-resizable={resizable ? "" : undefined}
					className={`plume-textarea plume-field-fade h-full ${className}`}
				/>
				<OverlayScrollbar viewport={field} orientation="vertical" />
			</div>
		</div>
	);
}
