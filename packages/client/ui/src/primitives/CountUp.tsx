/**
 * 变化时会走过去、刚出现时直接出现的数。
 *
 * 这个区别就是它做成组件、而不是在调用处直接用 `useCountUp` 的全部理由。hook 必须在调用方的提前
 * return 之前调用，于是真实的数还在读的时候它拿到的是 0——等数落地，再从 0 动画上去。打开一个面板，
 * 计数在半秒里从 0 数到 200，好像你看着的时候有两百个文件被改了。
 *
 * 在值已知的地方挂载，「第一个值」就是第一个*真实*的值。调用方有东西可显示时才渲染它，所以它的初始
 * 状态就是真实的数，没有起点可走。之后的每次读数都是真的变化，动起来正是为了这个。曲线和为什么不往下
 * 走，见 `useCountUp`。
 */

import { useCountUp } from "./useCountUp.ts";

/** 声明在外面，这样它是同一个函数，而不是每次渲染新建一个。 */
const plain = (shown: number): string => String(Math.round(shown));

export function CountUp({
	value,
	className,
	/** 走动中的数怎么写。默认是四舍五入的整数。 */
	format = plain,
	...rest
}: {
	value: number;
	className?: string;
	format?: (shown: number) => string;
} & Omit<React.ComponentProps<"span">, "className" | "children">) {
	return (
		<span {...rest} className={className}>
			{format(useCountUp(value))}
		</span>
	);
}
