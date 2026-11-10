import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 一个元素是不是窄到放不下两栏，按元素自己量。
 *
 * 面板里的内容没法问窗口自己有多宽——同一个组件既跑在 368px 的面板里，也跑在整列宽的正文里。
 * 这里看的是它实际拿到的那个盒子。
 *
 * 第一次测量在节点一到就做，而不是留给 observer 的首次回调。那次回调在绘制之后才到，一个从 `false`
 * 起步的组件会先画一帧错的布局——更糟的是，挂在这次翻转上的东西（比如列表/详情的重置）会在用户已经
 * 动手之后晚一拍才触发，把刚做的操作撤掉。
 *
 * 用回调 ref，不用 ref 对象。这不是风格问题：`useRef` + `useLayoutEffect` 只在 effect 第一次运行时
 * 挂 observer，一个先渲染了*别的*东西的组件——比如项目加载时的空状态——要么根本没挂上，要么挂到一个
 * 随后被换掉的节点上。两种情况下 observer 都在看一个不存在的东西，标记停在碰巧的那个值上，一个开到
 * 全屏的面板在一千像素宽时还在画堆叠布局。React 每次节点变化都会调用回调 ref，而节点变化正是要紧的那件事。
 */
export function useNarrow(threshold: number): [boolean, (node: HTMLDivElement | null) => void] {
	const [narrow, setNarrow] = useState(false);
	const watching = useRef<ResizeObserver | null>(null);

	const attach = useCallback(
		(node: HTMLDivElement | null) => {
			watching.current?.disconnect();
			watching.current = null;
			if (!node) return;

			setNarrow(node.clientWidth > 0 && node.clientWidth < threshold);
			const observer = new ResizeObserver(([entry]) => {
				// 宽度为零是被藏起来了，不是窄；否则后台的标签页会自己改布局。
				if (entry && entry.contentRect.width > 0) setNarrow(entry.contentRect.width < threshold);
			});
			observer.observe(node);
			watching.current = observer;
		},
		[threshold],
	);

	// observer 不能比要它的组件活得长。
	useEffect(() => () => watching.current?.disconnect(), []);

	return [narrow, attach];
}
