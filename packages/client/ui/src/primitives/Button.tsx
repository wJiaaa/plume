/**
 * 按钮，只有界面真正用到的五种样子。
 *
 * 各处手写 `<button>` 的话，高度会长出七八种——26、28、30、32、44——没有一种是有意的。一排基线对不齐的
 * 控件读起来像两条工具栏硬拼在一起。
 *
 * 这里收的是按钮一路自己长出来的那几种状态：一档给密集行的尺寸，还有一个忙碌态——每个异步操作原本都
 * 在用 disabled 加旁边一个转圈各自实现它。
 *
 * 不是通用的按钮库。五种外观、三档尺寸，没有 `style`——要的就是调用方发明不出第九种高度。
 * 类名组合在 `@plume/styles` 的 `button`。
 */

import { button } from "@plume/styles";
import type { ReactNode, MouseEvent } from "react";

/**
 * 原样透传到 `<button>` 上的 `data-*`。
 *
 * 测试按这些找控件，而不是按文字，所以改个措辞不会弄坏一套测试。别的都不透传：没有 style，也没有
 * 一整类事件——见文件开头。
 */
export type DataAttributes = { [key: `data-${string}`]: string | boolean | undefined };

export type ButtonVariant = "primary" | "ghost" | "subtle" | "soft" | "danger";
/**
 * `md` 32px，是默认：对话框的按钮就是这么高。
 *
 * `sm` 26px，给面板里的行，整高的按钮在那儿会喧宾夺主。
 *
 * `xs` 20px，给一句话末尾或一行小字后面的动作：26px 的按钮放在那儿，会让这一行比它所属的文字还高。
 */
export type ButtonSize = "md" | "sm" | "xs";

export function Button({
	children,
	icon,
	onClick,
	variant = "ghost",
	size = "md",
	disabled,
	loading,
	label,
	ariaLabel,
	menu,
	expanded,
	pressed,
	className = "",
	type = "button",
	...data
}: DataAttributes & {
	/**
	 * 只有图标的按钮不传。
	 *
	 * 图标旁边再写一个字是把同一件事说两遍，一排这样的按钮会把工具栏变成一句话。图标说得清意思的地方，
	 * `label` 同时作悬停提示和无障碍名——读屏的人什么都没丢，丢的只是眼睛看到的那几个字。
	 */
	children?: ReactNode;
	icon?: ReactNode;
	onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
	variant?: ButtonVariant;
	size?: ButtonSize;
	disabled?: boolean;
	/**
	 * 忙碌。按钮不能按、变淡，宽度不变。
	 *
	 * 每个异步操作各自做这件事时，做法都略有不同——有的把文字换成转圈，整行跟着跳；有的按钮还能按，
	 * 能被按两次。宽度不变是因为：一个看着它的时候在缩的按钮，回头找的时候可能就找不到了。
	 */
	loading?: boolean;
	/** 悬停提示；没有可见文字时也是无障碍名。 */
	label?: string;
	/** 可见文字本身说不清按钮做什么时的无障碍名——`中文` 是一个值，不是一个动作。 */
	ariaLabel?: string;
	/** 会打开一个菜单；值是它现在开没开。普通按钮不传。 */
	menu?: boolean;
	/** 原地展开或收起一段——`aria-expanded`，但不像 `menu` 那样声明弹出。 */
	expanded?: boolean;
	/** 一排选择里选中的那个——筛选、视图。不是一组里的按钮不传。 */
	pressed?: boolean;
	className?: string;
	type?: "button" | "submit";
}) {
	const bare = children === undefined || children === null || children === false;
	const inert = disabled || loading;

	return (
		<button
			{...data}
			type={type}
			disabled={inert}
			onClick={onClick}
			aria-busy={loading || undefined}
			aria-haspopup={menu === undefined ? undefined : "menu"}
			aria-expanded={menu ?? expanded}
			aria-pressed={pressed}
			data-plume-tip={label}
			aria-label={ariaLabel ?? (bare ? label : undefined)}
			data-variant={variant}
			className={[
				// 按钮圆角全应用两档：约 22px 及以上 8px，20px 及以下的小图标按钮 6px。
				button.base,
				button.size[size],
				bare ? button.square[size] : button.pad[size],
				(pressed && button.pressed[variant]) || button.variant[variant],
				// 和 `disabled:` 分开，忙碌读起来是「在做」，而不是「不能按」。
				loading ? button.loading : "",
				className,
			]
				.filter(Boolean)
				.join(" ")}
		>
			{icon}
			{children}
		</button>
	);
}
