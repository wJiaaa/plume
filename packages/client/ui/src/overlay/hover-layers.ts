/**
 * 「自己冒出来的东西，现在该不该冒出来」只有一个答案。
 *
 * 有些面不是谁要求才出现的，而是指针停在某处就出来了：悬停提示，以及列表行旁边的悬停卡片。
 * 有人主动打开了什么，它们都得让开——菜单上方淡入一个气泡是噪音，而一张悬停卡片是一大块噪音，
 * 还画在它盖住的那个菜单上面。
 *
 * 如果各问各的：提示靠弹层设的一个模块级标志，再在每次 `pointerover` 时用选择器去找菜单的类名；
 * 标志只认得弹层，选择器只认得弹层碰巧带着的那串类名，悬停卡片则谁也不问——右键一行，指针移开
 * 再移回来，420ms 后卡片又回来了，压在还开着的菜单上面。所以集中在这里问一次。
 *
 * 两种请求，因为两类调用方要的不一样：
 *
 * `claimHoverSuppression` 是菜单在说「我在的时候别来」。弹层只盖住一小块，窗口其余部分照样能悬停，
 * 没有一个持续的声明，指针随便溜到旁边一行就又把卡片叫出来了。
 *
 * `dismissHoverLayers` 是模态框在说「把屏幕清干净」。它的遮罩盖住一切，底下不可能再引出新的气泡或
 * 卡片，持续的声明什么也买不到——代价却是真的：对话框里有自己的提示，在模态框开着的整段时间里压住，
 * 等于把它们全关了。所以这只拿走打开那一刻屏幕上已有的东西，那才是真正的问题——从键盘打开的
 * 对话框，没有按下这个动作替它清掉，卡片就挂在它上面。
 */

let claims = 0;
const listeners = new Set<() => void>();

/** 现在是否有菜单或别的局部遮盖的面在压着它们。 */
export function hoverLayersSuppressed(): boolean {
	return claims > 0;
}

/**
 * 调用方在屏幕上的这段时间里一直压着它们，并清掉现在显示着的。
 *
 * 返回释放函数，调用两次也安全：组件在 React 严格模式的双重调用里卸载，否则会把计数减到零以下，
 * 之后每个声明都差一截。
 *
 * 用计数而不是布尔值。菜单会嵌套，对话框会弹出菜单，子菜单关掉不能撤销父菜单还压着的声明——
 * 用布尔值的话，里层的清理会清掉外层的，最后一次释放碰巧赢。
 */
export function claimHoverSuppression(): () => void {
	claims++;
	if (claims === 1) dismissHoverLayers();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		claims--;
	};
}

/** 拿走屏幕上现有的，不对接下来可能出现的东西下声明。 */
export function dismissHoverLayers(): void {
	/*
	 * 特意遍历集合的副本。
	 *
	 * 被叫停的监听者会拿走自己的面，一行在这个过程中卸载就会取消订阅。`Set` 在遍历中会跳过迭代器
	 * 还没走到就被删掉的成员——它后面那个监听者就永远收不到通知，卡片就留在菜单上。集合里只有
	 * 两三项，这份保险很便宜。
	 */
	// oxlint-disable-next-line unicorn/no-useless-spread -- 遍历不能看到删除，见上
	for (const listener of [...listeners]) listener();
}

/**
 * 听通知，而不是轮询。
 *
 * 对话框打开时屏幕上已有的卡片得拿走，而那一刻卡片自己的 props 什么也没变。
 */
export function onHoverLayersDismissed(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
