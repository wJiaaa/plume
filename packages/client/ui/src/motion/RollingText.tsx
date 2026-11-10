import { useState } from "react";

/**
 * 装着值的那个框——滚动的是它，溢出的也是它。
 *
 * 导出是因为要截断的父元素得找得到它：外层的宽度受它的父元素约束，所以外层永远不溢出，任何要量「这个是不是
 * 被截了」的东西都得去问里面这个框。
 */
export const ROLL_VALUE = "plume-roll-value";

/**
 * 一个值替换另一个值，不管发生在哪里。
 *
 * 原地变化的字——输入框里的推理强度、刚选的模型、权限模式、「展开显示」变成「收起」——不滚的话，眼睛除了
 * 字形不同以外收不到任何「发生了什么」的信号：在正拖着的控件上读起来像渲染瑕疵，在刚点过的控件上读起来像
 * 那一下点了没用。
 *
 * 动作是 `ui/motion.css` 里的 `.plume-roll`——总是往下，一连串的变化读起来是一个东西在被拨动，而不是字在闪。
 * 有了这个组件，用上它就是选对元素的事，而不必记住一个两步的写法（`key={value}` 加 `plume-roll`）。
 *
 * 给标签用，不给读数用。会跳的数——token 数、计时器、百分比——是在连续变化而不是被替换，每跳一下滚一次，
 * 一块安静的仪表就成了整轮里一直在余光里动的东西。那些用 `tabular-nums` 定住。
 */
export function RollingText({
	children,
	className = "",
	rollKey,
}: {
	children: string | number;
	/** 落在外层元素上，它默认是 `inline`——需要的地方给它 `block`。 */
	className?: string;
	/** 改写什么算「换了一个值」，给带着一段总在变的部分的文字用。 */
	rollKey?: string | number;
}) {
	const value = rollKey ?? children;
	const rolls = useRolled(value);

	return (
		<span className={className}>
			{/*
			 * `inline-block`，因为 `transform` 对行内框不起作用——滚动会只剩一个淡入。`max-w-full` 让它待在
			 * 会截断的父元素里面，而不是顶出去。
			 *
			 * `plume-roll-value` 是要截断的父元素需要的抓手。待在父元素里面不等于被它省略：行内块是原子框，
			 * `text-overflow` 管不到它，`overflow: hidden` 直接把它切掉——太长的模型名在输入框里就这样断在半个
			 * 字形上，没有省略号。见 `ui/motion.css` 里那条规则。
			 */}
			<span key={value} className={`${ROLL_VALUE} inline-block max-w-full ${rolls ? "plume-roll" : ""}`}>
				{children}
			</span>
		</span>
	);
}

/**
 * 这个值是否被替换过——首次绘制时是 false，从第一次变化起是 true。
 *
 * 有两件事靠它做对，而它们往相反的方向拉。
 *
 * 首次绘制不能动。挂上就滚的话，菜单一打开每个标签都落进位，叠在菜单自己的进场上——两个不同方向的动作，
 * 读起来像面板在你面前被拼起来。
 *
 * 可类也不能来来去去，这一点更隐蔽：给元素加上 `animation` 就会**开始**那个动画。一个在下一次无关渲染时
 * 退回 false 的标记，会在再下一次渲染时把类加回来，于是输入框里任何一个标签一变，所有标签都滚一遍。所以它
 * 是锁存的：一旦为 true 就一直是 true，此后动画完全由 `key` 变化引起的重新挂载来驱动。
 *
 * 在渲染期间调整状态，是从一个变了的 prop 推导状态的官方做法——React 丢掉这一遍、立刻重跑组件，于是类和新
 * key 落在同一次提交里，元素挂上时就已经在动。
 */
export function useRolled(value: string | number): boolean {
	const [seen, setSeen] = useState(value);
	const [rolls, setRolls] = useState(false);

	if (seen !== value) {
		setSeen(value);
		setRolls(true);
	}

	return rolls;
}
