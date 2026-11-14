/**
 * 菜单由这些零件组成：行、分隔线、小标题、搜索框、带内衬的正文。
 *
 * 和 `Popover` 分开，弹层只是一个定好位的面。弹层里可以放任何东西——取色器、表单——菜单也可以放在
 * 不是弹层的地方。把两者分开，「行长什么样」和「面落在哪」才不会被顺手一起改掉。
 */

import { translate } from "../i18n/translate.ts";
import { Input } from "../inputs/NativeField.tsx";
import { Search, X } from "../icons/index.ts";
import { createContext, useContext } from "react";

import { ScrollText } from "../scroll/ScrollText.tsx";
import { shortcutLabel } from "../keyboard.ts";

/**
 * 这个菜单的行是否都留着图标那一列，连没有图标的行也留。
 *
 * 由正文设，而不是每行自己设，因为这是关于菜单的事实：一个列出七个应用、只找到三个应用图标的下拉，
 * 每行各自收起这一列的话，文字从两个不同的 x 位置开始，整个列表读起来像两个列表。一行看不见它的邻居，
 * 正文看得见。
 */
const InsetIcons = createContext(false);

/**
 * 每个菜单的内容所在的盒子。
 *
 * 行四周的留白在滚动区上（`--plume-menu-inset`），不在这里。这里再加一层内衬会叠在那圈外边距上，
 * 上下就成了左右的两倍。
 */
export function MenuBody({
	children,
	insetIcons = false,
	className = "",
}: {
	children: React.ReactNode;
	/** 每行都留出图标列，给只有部分行有图标的菜单用。 */
	insetIcons?: boolean;
	className?: string;
}) {
	return (
		<InsetIcons.Provider value={insetIcons}>
			{/*
			 * 这里不加内衬。滚动区上的 `--plume-menu-inset` 是唯一的留白，悬停底色离卡片每条边一样近。
			 * 这里再加内衬会叠在那圈外边距上，上下成了左右的两倍。
			 */}
			<div className={className}>{children}</div>
		</InsetIcons.Provider>
	);
}

/**
 * 菜单分隔线下面的行：比如列表下面的「新建」。
 *
 * 弹层的 footer 槽位没有自己的留白，因为放在那里的不都是行——也可能是一条通栏，或者一张小表单。
 * 行需要列表的留白和列表的圆角（`.plume-menu-foot`），否则悬停底色从边铺到边，位置也比上面的行偏左
 * 一截；各菜单各自补一圈留白，又会补出不一样的宽度。
 */
export function MenuFooter({ children }: { children: React.ReactNode }) {
	return <MenuBody className="plume-menu-foot">{children}</MenuBody>;
}

/**
 * 菜单里的一行。
 *
 * 每个菜单各自长一份的话——高度不同、圆角不同、有的干脆没有圆角——同一个手势在不同菜单里看着不一样。
 * 视觉状态放在 `.plume-item` 里，需要别的形状的行（比如两行的选项）也能用上它们。
 */
export function MenuItem({
	icon,
	children,
	detail,
	hint,
	trailing,
	checked,
	selected,
	danger,
	disabled,
	title,
	className = "",
	onClick,
}: {
	icon?: React.ReactNode;
	children: React.ReactNode;
	/**
	 * 解释这个选项的第二行。
	 *
	 * 在这里处理，而不是每个菜单自己排两行的行：自己排的话会长出自己的高度、内边距和悬停效果，同一个
	 * 手势在不同菜单里看着不一样。
	 */
	detail?: React.ReactNode;
	/** 右对齐的注记：数量、快捷键数字、上下文大小。 */
	hint?: React.ReactNode;
	/** 右对齐的元素，放勾或箭头。 */
	trailing?: React.ReactNode;
	/**
	 * 让这一行成为开关设置：行尾一个小开关，`menuitemcheckbox` 语义。
	 *
	 * 文字仍是设置的名字——「自动更新」——状态由开关说。两样都用字写的话，「自动更新：开（点击关闭）」
	 * 是一句要解析的话，而本该扫一眼就够，还会跑出菜单的右边。
	 */
	checked?: boolean;
	selected?: boolean;
	danger?: boolean;
	disabled?: boolean;
	title?: string;
	/**
	 * 加在行本身上的类，给用别的方式标记行的菜单。
	 *
	 * 比如右边那一列已经被占了、所以选中行用填充而不是打勾的菜单。选了这种方式的行得能说出来——在这里
	 * 说，高度、圆角和按下状态仍是共用的，而这正是行只住在一个地方的意义。
	 */
	className?: string;
	onClick?: () => void;
}) {
	const inset = useContext(InsetIcons);

	return (
		<button
			type="button"
			role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
			aria-checked={checked}
			disabled={disabled}
			data-plume-tip={title}
			data-selected={selected ? "true" : undefined}
			data-danger={danger ? "true" : undefined}
			onClick={onClick}
			className={`plume-scroll plume-item flex w-full gap-2 px-2 text-left text-label ${
				detail ? "items-start py-2" : "h-[var(--plume-menu-row)] items-center"
			} ${className}`}
		>
			{/*
			 * 固定宽的一列，不管里面是什么。
			 *
			 * 菜单里 lucide 图标和 18px 的应用图标混着用，按各自宽度占位的话，旁边的文字会差几像素
			 * 对不齐——没人说得出来，但人人都看得见。在一列够放最大那个的宽度里居中，文字就总从同一处开始。
			 * lucide 图标的大小、线宽和颜色由 `.plume-menu-icon` 统一，调用处给多大都一样。
			 */}
			{(icon || inset) && <span className={`plume-menu-icon flex w-[18px] shrink-0 items-center justify-center ${detail ? "mt-[3px]" : ""}`}>{icon}</span>}
			<span className="min-w-0 flex-1">
				{typeof children === "string" ? <ScrollText text={children} /> : children}
				{/* 一行。换行的说明会让这一行比邻居高，一列参差的行比偶尔截短一条路径的菜单更难扫读。 */}
				{detail && <span className="mt-0.5 block truncate text-caption leading-snug opacity-65">{detail}</span>}
			</span>
			{hint !== undefined && (
				<span className={`shrink-0 text-caption text-ink-faint tabular-nums ${detail ? "mt-[3px]" : ""}`}>
					{typeof hint === "string" ? shortcutLabel(hint) : hint}
				</span>
			)}
			{/* 包一层只为让 `.plume-menu-trailing` 认出行尾的勾：选中的勾统一画成强调色。不占布局。 */}
			{trailing !== undefined && <span className="plume-menu-trailing contents">{trailing}</span>}
			{checked !== undefined && (
				<span
					aria-hidden
					className={`relative h-[16px] w-[28px] shrink-0 rounded-full transition-colors duration-[var(--plume-t-base)] ${checked ? "bg-accent" : "bg-line"}`}
				>
					<span
						className="plume-knob absolute top-[2px] left-[2px] h-3 w-3 rounded-full border transition-transform duration-[var(--plume-t-base)] ease-out"
						style={{ transform: checked ? "translateX(12px)" : "none" }}
					/>
				</span>
			)}
		</button>
	);
}

/** 分开菜单里的几组行。 */
export function MenuSeparator() {
	/*
	 * `line-float` 而不是 `line-soft`：菜单是一个独立的面，soft 那条线是按后面的页面算的——画在这里
	 * 比它所分隔的菜单还暗。再淡一档、两头缩到和行里的内容对齐：分隔线只是提示分组，通栏的实线会把一张
	 * 小菜单切成几块。
	 */
	return <div className="mx-2 my-1.25 h-px bg-line-float/60" />;
}

/** 一组行上面的小标题。 */
export function MenuLabel({ children }: { children: React.ReactNode }) {
	/* 比行小一档：和行一样大的话，读起来像一行点不了的选项。左边和行的内容对齐。 */
	return <div className="px-2 pt-1.5 pb-0.75 text-caption leading-4 font-medium text-ink-faint">{children}</div>;
}

/**
 * 列出超过一屏的菜单顶上的筛选框，放进 `Popover` 的 `header` 槽位，列表滚动时它不动。Escape 先清空再关闭。
 *
 * 每个菜单各写一份的话，同样的高度、同样的放大镜、同样的占位文案，每多一份就多一次走样的机会。
 * 它下面那条线属于 `header` 槽位，不在这里画。Escape 和 `SearchField` 一样：第一次按撤销输入，
 * 只有没东西可撤销时按才关掉菜单。
 */
export function MenuSearch({
	value,
	onChange,
	placeholder,
	autoFocus = true,
	onKeyDown,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	autoFocus?: boolean;
	/** 给焦点留在输入框里、由它来移动高亮（方向键和 Enter）的菜单用。 */
	onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
	return (
		<div className="flex h-[34px] items-center gap-2 px-3">
			<Search size={13} strokeWidth={1.9} className="shrink-0 text-ink-faint" />
			<Input
				autoFocus={autoFocus}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					onKeyDown?.(event);
					if (event.key !== "Escape" || !value) return;
					event.stopPropagation();
					onChange("");
				}}
				placeholder={placeholder}
				className="h-full min-w-0 flex-1 bg-transparent text-label text-ink placeholder:text-ink-faint"
			/>
			{value && (
				<button
					type="button"
					aria-label={translate("common.clearSearch")}
					onClick={() => onChange("")}
					className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
				>
					<X size={10.5} strokeWidth={2.2} />
				</button>
			)}
		</div>
	);
}
