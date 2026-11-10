import { useLayoutEffect, useState, type ReactNode } from "react";
import { motionReduced } from "../motion/reduced.ts";

/** 收起时的内容留到尺寸过渡走完，再放掉开销大的子树。 */
export function Collapse({
	open,
	children,
	bodyClassName,
	className = "",
	keepMounted = false,
}: {
	open: boolean;
	children: ReactNode;
	bodyClassName?: string;
	className?: string;
	keepMounted?: boolean;
}) {
	const [retained, setRetained] = useState(open);
	useLayoutEffect(() => {
		if (open) setRetained(true);
		else if (!keepMounted && motionReduced()) setRetained(false);
	}, [open, keepMounted]);
	useLayoutEffect(
		() => () => {
			// Activity 藏起一页时会取消 CSS 过渡，transitionend 来不及放掉正在收起的内容。
			// 展开的内容照样经 `open` 渲染，effect 恢复时会重新留住。
			if (!keepMounted) setRetained(false);
		},
		[keepMounted],
	);
	const settled = () => {
		if (!open && !keepMounted) setRetained(false);
	};
	return (
		<div
			className={`plume-reveal plume-freeze ${className}`.trim()}
			data-open={open}
			inert={!open}
			aria-hidden={!open}
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "grid-template-rows") settled();
			}}
		>
			<div>
				<div className={bodyClassName}>{(open || retained) && children}</div>
			</div>
		</div>
	);
}
