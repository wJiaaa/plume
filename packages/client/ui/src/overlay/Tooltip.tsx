import { cloneElement } from "react";

/**
 * 应用的悬停提示，写成 JSX 包装，比属性读起来顺。
 *
 * 它只给子元素打标记——气泡本身由 `tooltip.ts` 里那一个文档级监听器画。所以两种写法表现完全一样，
 * 这很重要，因为第三方库自己建的按钮只能靠属性够到。
 *
 * 取代浏览器的 `title`：那个改不了样式，要等一秒半左右，不跟应用的字体和主题，在 macOS 上画成一个
 * 系统面板，看着像属于另一个程序。
 */
export function Tooltip({ label, children, side = "bottom" }: { label: string; children: React.ReactElement; side?: "top" | "bottom" }) {
	return cloneElement(children, { "data-plume-tip": label, "data-plume-tip-side": side } as Record<string, string>);
}
