/**
 * 所有浮起来的东西挂在哪。
 *
 * 好几个组件要 portal 到 `document.body`——对话框、弹层、悬停卡片、通知、看图器。它们不是同一个
 * 组件，也不该是：对话框困住焦点，弹层跟着锚点，通知会堆叠。它们共有的只是一个决定，不该每处写一遍。
 *
 * 这个决定是 `document.body` 而不是应用里的某个容器，理由很具体：`backdrop-filter` 采样的是最近的
 * backdrop root，而*任何* `mask` 都会建一个。每个边缘渐隐的 `Scroller` 都带 mask，所以渲染在里面的
 * 菜单模糊的是滚动区自己透明的底，而不是页面——毛玻璃看着是坏的，透明度怎么调都没用。portal 到
 * body，模糊的才是真正在后面的东西。
 *
 * 是共用的函数而不是共用的组件，这样每个调用方保留自己的行为，又都不用重新推一遍这件事。
 */

import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * 把 `children` 渲染到文档的最上层。
 *
 * 没有文档时返回 `null`——在没有 DOM 的服务端或测试里渲染的组件什么也拿不到而不是崩溃，对纯视觉的
 * 东西来说这是对的形状。
 */
export function portal(children: ReactNode): ReactNode {
	if (typeof document === "undefined") return null;
	return createPortal(children, document.body);
}
