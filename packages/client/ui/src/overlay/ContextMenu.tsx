/**
 * 在右键的位置打开的菜单。
 *
 * Electron 没有默认的右键菜单，没有这个的话，在应用里任何地方右键都什么也不发生——文件上、编辑器里、
 * 输入框里都是。`Popover` 已经会把面挂在一个点上而不是元素上；缺的是围绕它的一点约定：菜单是关于
 * 哪个目标的，以及选中任何一行都会关掉它。在这里写一次，文件树、编辑器和普通输入框就不会各走各的。
 */

import { useCallback, useState } from "react";

import { MenuBody, Popover, type PopoverWidth } from "./Popover.tsx";

/** 菜单挂在哪，以及它是关于什么的。 */
interface ContextTarget<T> {
	point: { x: number; y: number };
	target: T;
}

/**
 * 记下一次右键：发生的位置，和发生在什么东西上。
 *
 * 目标跟着一起记，因为右键菜单几乎总是关于某一行的，而之后再从事件里读出「哪一行」是不可能的——
 * 菜单渲染时指针早就移走了。带类型，菜单就不会为错误种类的东西搭起来。
 */
export function useContextMenu<T = void>() {
	const [state, setState] = useState<ContextTarget<T> | null>(null);

	const show = useCallback((event: React.MouseEvent, target: T) => {
		// 否则开发时会出现浏览器自己的菜单，父元素的处理也会触发——在树里就是行的菜单和背景的菜单
		// 同时想打开。
		event.preventDefault();
		event.stopPropagation();
		setState({ point: { x: event.clientX, y: event.clientY }, target });
	}, []);

	return {
		anchor: state?.point ?? null,
		/** 右键之前是 null；渲染菜单前先用它收窄类型。 */
		target: state ? state.target : null,
		open: state !== null,
		show,
		close: useCallback(() => setState(null), []),
	};
}

/**
 * 面本身。
 *
 * 每一行都会关掉它，在这里处理而不是每一项各自记得：右键菜单里没有不是动作的行，点完还开着的那个会是
 * 应用里唯一这样的菜单。监听在冒泡阶段，所以行自己的处理已经先运行了。
 */
export function ContextMenu({
	anchor,
	onClose,
	width = "default",
	children,
}: {
	anchor: { x: number; y: number } | null;
	onClose: () => void;
	width?: PopoverWidth;
	children: React.ReactNode;
}) {
	if (!anchor) return null;
	return (
		<Popover
			anchor={anchor}
			onClose={onClose}
			// 在指针的右下方，每个系统都放在那里。
			placement="bottom"
			align="start"
			width={width}
			/*
			 * 没有自己的上限——只有窗口给的那一个。
			 *
			 * `MENU_MAX_HEIGHT` 适合*列东西*的菜单，四十行本来就该滚。这一种列的是动作，最底下的动作是
			 * 「删除」和「永久删除」：封顶 340px 时菜单在列表中间就断了，最该被找到的两项正好在折叠线以下。
			 * `Popover` 仍会限制在它被放进的那段空隙里，另一侧更宽时会翻过去。
			 */
			role="menu"
		>
			<MenuBody insetIcons>
				{/* 不需要配键盘事件：行本身是按钮，这里只是在它们之后关掉菜单。 */}
				<div onClick={onClose}>{children}</div>
			</MenuBody>
		</Popover>
	);
}
