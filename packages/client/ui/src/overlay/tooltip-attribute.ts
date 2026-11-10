/**
 * 整个窗口只有一个悬停提示，由属性驱动。
 *
 * React 的 `<Tooltip>` 包装只够得着 React 渲染的元素。第三方库自己建的 DOM（比如编辑器的搜索面板）
 * 里的按钮只能用原生 `title`——形状不同、延迟不同，颜色和应用其余部分也对不上。
 *
 * 属性在什么上都管用：`data-plume-tip="下一个"` 挂在 React 节点上，和挂在第三方库刚建的 DOM 节点上
 * 表现完全一样，因为显示气泡的是文档上的一个监听器，而不是每个目标一个组件。
 */

import { shortcutLabel } from "../keyboard.ts";
import { hoverLayersSuppressed, onHoverLayersDismissed } from "./hover-layers.ts";

const DELAY_MS = 420;
/** 长到看得见它离开，短到不拖在指针后面。和 `plume-tip-out` 一致。 */
const EXIT_MS = 110;
const GAP = 6;
const MARGIN = 6;
/**
 * 高于悬停卡片（210），那是指针唯一能叫出来的另一种东西。
 *
 * 两者会在列表行上相遇：停在行尾的图标上，两个都会出现，而气泡居中在离面板边缘几像素的图标下面，
 * 卡片从边缘往外 8px 开始——提示文字正好伸出行外一截，滑到卡片底下。200 时它输了，而直接说出指针
 * 底下那颗按钮叫什么的标签，是两者中更具体的那个。
 *
 * 也高于通知（1000）：提示条上的按钮也带提示，多行的卡片里按钮贴着第一行，气泡落在卡片里面，低于通知就被卡片盖住。
 * 气泡只在指针停在某个控件上时出现，指针够得着的最高一层就是它该在的地方。编辑器的行号栏在 200，这里直接高过它，
 * 而不是打平之后靠文档顺序赢。
 */
const TIP_Z = 1010;

let host: HTMLElement | null = null;
let timer = 0;
let leaving = 0;
let current: HTMLElement | null = null;

/*
 * 菜单和对话框只在 `hover-layers` 里问一次，不在这里自己去找。
 *
 * 自己维护标志（只有 `Popover` 会设）*再*对弹层碰巧带着的类名跑选择器，两者都对不上 `Overlay` 的
 * 对话框，于是不经点击打开的模态框上会挂着一个气泡——而对话框自己的提示（它有很多）照常工作：
 * 模态框只清一次屏，而不是在它存在期间一直压着。
 */
onHoverLayersDismissed(hideTooltipImmediate);

function ensureHost(): HTMLElement {
	if (host) return host;
	host = document.createElement("div");
	host.className = "plume-tooltip";
	host.setAttribute("role", "tooltip");
	host.style.position = "fixed";
	host.style.zIndex = String(TIP_Z);
	host.style.pointerEvents = "none";
	host.hidden = true;
	document.body.appendChild(host);
	return host;
}

/**
 * 「只有真被截断时才说」。
 *
 * 一列 `truncate` 的文字里，大多数是完整的——给每一个都挂一个气泡，等于把「这里还有没读到的
 * 字」这个信号稀释成背景噪音，而那恰恰是唯一值得提示的时候。
 *
 * 现场量，不预先算：一个格子截不截断取决于窗口宽度、字体和当下的内容，任何一个变了上次的结论
 * 就过期了。`pointerover` 时量一次是准的，而且只量指针底下那一个。
 */
function truncated(el: HTMLElement): boolean {
	// 四舍五入：分数像素下 scrollWidth 会比 clientWidth 大零点几，那不是截断。
	return Math.round(el.scrollWidth) > Math.round(el.clientWidth);
}

/** 最近的带提示的祖先，所以按钮里的图标也算作按钮。 */
function targetOf(node: EventTarget | null): HTMLElement | null {
	if (!(node instanceof Element)) return null;
	const el = node.closest<HTMLElement>("[data-plume-tip]");
	if (!el || !el.dataset.plumeTip) return null;
	// `data-plume-tip-when="truncated"`：这句话屏幕上已经写着了，只在写不下的时候才重复一遍。
	return el.dataset.plumeTipWhen === "truncated" && !truncated(el) ? null : el;
}

interface Box {
	top: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
}

/**
 * 气泡放在哪：对着目标居中，放在要求的那一侧，除非那一侧出了屏幕，并且永远不越过任何一条边。
 *
 * 导出并且不碰 DOM，因为翻转是容易写反的部分，而写反了是看不出来的，直到有人指向靠边的那一个控件。
 * 它确实写反过——每个 `side="top"` 的提示都画在目标下面——又因为另一个 bug 让提示根本不出现，
 * 一直没人发现。
 */
export function tipPlacement(
	target: Box,
	tip: { width: number; height: number },
	side: "top" | "bottom" | "right",
	viewport: { width: number; height: number },
): { left: number; top: number } {
	/*
	 * 一列按钮用旁边而不是下面：竖排图标栏里一颗按钮下面的提示落在下一颗按钮上，而那正是指针
	 * 接下来要去的地方。
	 */
	if (side === "right") {
		const right = target.left + target.width + GAP;
		const left = right + tip.width < viewport.width - MARGIN ? right : Math.max(MARGIN, target.left - tip.width - GAP);
		const middle = target.top + target.height / 2 - tip.height / 2;
		return { left, top: Math.max(MARGIN, Math.min(middle, viewport.height - tip.height - MARGIN)) };
	}
	const below = target.bottom + GAP;
	const above = target.top - tip.height - GAP;
	const fits = side === "bottom" ? below + tip.height < viewport.height - MARGIN : above > MARGIN;
	// 放得下就放在要求的一侧，放不下就放另一侧。
	const preferred = fits === (side === "bottom") ? below : above;
	const top = Math.max(MARGIN, Math.min(preferred, viewport.height - tip.height - MARGIN));

	const centred = target.left + target.width / 2 - tip.width / 2;
	const left = Math.max(MARGIN, Math.min(centred, viewport.width - tip.width - MARGIN));
	return { left, top };
}

/**
 * 长标签在浏览器已经允许的之外，还能在哪里断行。
 *
 * 对断行器来说，一条路径或一个文件名是一个不断开的词——`_`、`.`、`/` 都不是断行点——所以一个写着
 * `REQUIREMENTS_POLICY_PORTAL_v2_final_review_notes.md` 的提示会撑满宽度上限，`overflow-wrap` 在上限
 * 落下的地方硬切，第二行只剩一个「d」。在长串 ASCII 里（16 个字符以上：路径、文件名、URL、标识符——
 * 不是句子里的 "85.3%" 或 "v1.2"），一行现在可以在 `/ \ _ - . : ? & = # + @` 任一个后面结束。
 *
 * 返回这些位置之间的片段；调用方用 `<wbr>` 连起来，它是一个断行机会，不给文字加任何东西。
 */
export function softBreaks(text: string): string[] {
	const pieces: string[] = [];
	let from = 0;
	for (const run of text.matchAll(/[!-~]{16,}/g)) {
		for (const mark of run[0].matchAll(/[/\\_.:?&=#+@-](?=[!-~])/g)) {
			const at = run.index + mark.index + 1;
			pieces.push(text.slice(from, at));
			from = at;
		}
	}
	pieces.push(text.slice(from));
	return pieces;
}

/**
 * 提示仍不比最宽时更高的最窄宽度。
 *
 * `max-content` 被 `max-width` 封顶时，第一行填满到上限，剩下的留给下一行——上面那个文件名排成了一行
 * 343px 和一行 7px。把气泡收窄到再窄一像素就要多一行为止，文字就均匀地铺在它本来就需要的那几行上，
 * 不管浏览器在哪断，包括 `overflow-wrap` 在词中间断的。这也是为什么不用 `text-wrap: balance`：它把行
 * 排匀了，但盒子仍然停在上限，短行旁边的空白还留在气泡里。
 *
 * `heightAt` 按一个宽度排版提示并报告它的高度。由外面传进来，这样不用排版引擎也能测试这个搜索。
 */
export function balancedWidth(widest: number, heightAt: (width: number) => number): number {
	const height = heightAt(widest);
	let lo = 0;
	let hi = Math.ceil(widest);
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (heightAt(mid) <= height) hi = mid;
		else lo = mid;
	}
	return hi;
}

/** 标签，在 `softBreaks` 允许断行的每个地方插一个 `<wbr>`。 */
function fill(tip: HTMLElement, text: string) {
	const nodes: Node[] = [];
	for (const [index, piece] of softBreaks(text).entries()) {
		if (index > 0) nodes.push(document.createElement("wbr"));
		nodes.push(document.createTextNode(piece));
	}
	tip.replaceChildren(...nodes);
}

/**
 * 标签确实换了行时，把气泡收窄到平衡宽度。
 *
 * 只在这时：一行放得下的标签已经是最窄的了，再去搜它的宽度是白做十几次排版。调用方用 `\n` 断开的
 * 行不算换行——`natural` 是带着它们量的。
 */
function fit(tip: HTMLElement) {
	tip.style.width = "";
	const widest = tip.offsetWidth;
	tip.style.maxWidth = "none";
	const natural = tip.offsetWidth;
	tip.style.maxWidth = "";
	if (natural <= widest) return;
	const width = balancedWidth(widest, (candidate) => {
		tip.style.width = `${candidate}px`;
		return tip.offsetHeight;
	});
	tip.style.width = `${width}px`;
}

function place(el: HTMLElement) {
	const tip = ensureHost();
	// 取消进行中的离开，否则气泡会在到达途中消失。
	window.clearTimeout(leaving);
	delete tip.dataset.leaving;
	fill(tip, shortcutLabel(el.dataset.plumeTip ?? ""));
	tip.hidden = false;
	// 在为定位而量之前：平衡宽度就是气泡定位时用的宽度。
	fit(tip);

	const a = el.getBoundingClientRect();
	// 入场的变换不能缩小用来让气泡留在屏幕内的尺寸。
	const b = { width: tip.offsetWidth, height: tip.offsetHeight };
	const side = el.dataset.plumeTipSide;
	const at = tipPlacement(a, b, side === "top" || side === "right" ? side : "bottom", {
		width: window.innerWidth,
		height: window.innerHeight,
	});
	tip.style.left = `${Math.round(at.left)}px`;
	tip.style.top = `${Math.round(at.top)}px`;
}

/**
 * 淡出，而不是消失。
 *
 * 在指针离开的那一帧就被移除的气泡读起来像故障——刚才还在，然后就没了，中间什么也没有。它也让
 * 沿着一排按钮移动时闪烁，因为每个提示都在下一个淡入之前被立刻拆掉。
 *
 * 元素在退场期间留在文档里，之后才隐藏，所以中途回来的指针会发现它还在，只是取消离开。
 */
function hide() {
	window.clearTimeout(timer);
	current = null;
	if (!host || host.hidden || host.dataset.leaving !== undefined) return;
	host.dataset.leaving = "";
	window.clearTimeout(leaving);
	leaving = window.setTimeout(() => {
		if (!host) return;
		host.hidden = true;
		delete host.dataset.leaving;
	}, EXIT_MS);
}

/** 立刻隐藏提示，不播退场动画。 */
function hideTooltipImmediate() {
	window.clearTimeout(timer);
	current = null;
	if (host) {
		window.clearTimeout(leaving);
		host.hidden = true;
		delete host.dataset.leaving;
	}
}

/**
 * 特意不在获得焦点时显示。
 *
 * 键盘用户从标签拿到无障碍名，Tab 穿过工具栏时冒出来的气泡是噪音而不是帮助。
 */
export function installTooltips() {
	document.addEventListener(
		"pointerover",
		(event) => {
			if (hoverLayersSuppressed()) return;
			const el = targetOf(event.target);
			if (el === current) return;
			hide();
			if (!el) return;
			current = el;
			timer = window.setTimeout(() => {
				// 延迟到了的时候，仍在指针底下，也仍在文档里。
				if (!hoverLayersSuppressed() && current === el && el.isConnected) place(el);
			}, DELAY_MS);
		},
		true,
	);

	// 这些中的任何一个都意味着目标没了，或者不再是被指着的东西。
	document.addEventListener(
		"pointerout",
		(event) => {
			// 从按钮的文字移到它的图标上，仍然是悬停在同一个目标上。
			if (targetOf(event.target) !== targetOf(event.relatedTarget)) hide();
		},
		true,
	);
	for (const type of ["pointerdown", "wheel", "keydown", "contextmenu"] as const) {
		document.addEventListener(type, hideTooltipImmediate, true);
	}
	window.addEventListener("blur", hide);
	window.addEventListener("scroll", hide, true);
}
