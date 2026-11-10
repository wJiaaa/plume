/**
 * 一个滚动面和它自己底部的关系。
 *
 * 规则在 `follow.ts`，不用浏览器就能测。这里是所有需要 DOM 的部分：读者的意图从哪里听来、位置什么
 * 时候写、回去的那一段怎么动。
 *
 * 每份转录都调用它——对话（侧聊也是一份）和委派的。各自留一份近似的副本会慢慢走样：余量不同、只有
 * 一份在看内容改尺寸、只有一份给回去的路。一处修好了另外两处照样坏着，这才是它存在的真正原因。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
	followsAfterRestore,
	isAway,
	isDegenerate,
	marker as makeMarker,
	nextState,
	targetScrollTop,
	unreadSince,
	visualBottom,
	type Direction,
	type FollowState,
	type Marker,
	type Reading,
} from "./follow.ts";
import { readFollow, writeFollow, type FollowSnapshot } from "./memory.ts";
import { motionReduced } from "../motion/reduced.ts";
import { windowMinimized } from "../motion/ticker.ts";

/** 滑回底部要多久。曲线和这里别的东西一样，对应 `--plume-e-out`。 */
const GLIDE_MS = 420;
/**
 * 一次按下能按住多久的锚。
 *
 * 要盖住展开动画走完（`--plume-t-slow` 那一档）加上图片落位，又不能长到把后面一次无关的长高也
 * 按住。滚一下就作废，所以宁可稍长。
 */
const HOLD_MS = 900;
/**
 * 贴着底部时，内容长高了多少以内算「输出」，计进输出速度（`FLOW_TAU`）。
 *
 * 回复写到底部时，每起一行转录长高一行（二十几像素）。每一次都当场把位置写到底的话，整段
 * 回复会一顿一顿地往上顶，一行一顿。这么小的一截改成追：滑过去而不是跳过去，一行接一行连成一条平稳的
 * 上移，新的那行字也正在淡入，两者合在一起才是一条流。超过一屏的（打开会话、一次倒进来一大篇）
 * 一步到位。
 */
const CHASE_MAX = 200;
/**
 * 追的时候最多落后底部多少；超出的部分在长高的同一帧写掉。
 *
 * 不能没有：整块到的工具卡整段慢慢追时，量到运行行被压到视口下沿以下 129px、21 帧。也不能小：正文
 * 换段、起标题一次就长 35–70px，截在 40px 时每次都是单帧 20–30px 的跳。落后的那一截里是刚放出来、
 * 还在淡入的字。
 */
const LAG_MAX = 120;
/**
 * 追的方式：两个临界阻尼的弹簧串起来，前一个把台阶状的目标抹成斜坡，后一个跟着斜坡走。
 *
 * 版面是一行一行、一段一段长的：每次 24–70px，间隔 20–560ms。只用一个弹簧，刚度够让落后小，两行
 * 之间就追平停住，下一行再从零起步，一行一顿，量到过四成的帧原地不动。串起来以后速度跨着台阶接着
 * 用，原地不动的帧剩一成上下，多在上游停顿里。
 *
 * 刚度随输出速度变（`stiffness`），稳定输出时落后约 `CHASE_LAG`：慢的时候软，快的时候硬，落后不随
 * 速度变长。参数是拿真窗口录下的逐帧版面离线比出来的。
 */
const CHASE_LAG = 36;
/** 刚度的上下限，按时间常数（毫秒）记。上限管写完以后最后一行多久追平：一行约 0.4s。 */
const TAU_MIN = 12;
const TAU_MAX = 60;
/** 落后超出 `CHASE_LAG` 越多弹簧越硬，多出 70px 时时间常数 20ms：整块到的一截靠它很快追完。 */
const BOOST = 1400;
/** 输出速度按多长的时间窗来估。要比一行的间隔长得多，估出来的速度才不随每一行忽高忽低。 */
const FLOW_TAU = 800;
/**
 * `live` 落下以后还算输出的时长。上游写完时屏幕上的字还没放完：出字最多落后上游 700ms，最后一个
 * 字再淡 180ms。这段里长出来的行当成静止时的长高、当帧写到底，收尾那几行就
 * 一行一跳，量到过单帧 49px。
 */
const TAIL_MS = 1000;
/** 转录里会做过渡的高度属性：界面块的 `height`，折叠区（`.plume-reveal`）的 `grid-template-rows`。见 `growing`。 */
const SIZES = new Set(["height", "grid-template-rows"]);

export interface FollowBottom {
	/** 交给 `Scroller` 的 `scrollRef`。 */
	scrollRef: React.RefObject<HTMLDivElement | null>;
	/**
	 * 放在滚动内容的最末尾。
	 *
	 * 「你已经看到最新消息了」指的就是它，而且必须是一个元素，不能是一道算术题：往上滚两屏、读完新到
	 * 的三段、停在那里的读者已经跟上了，任何离底距离的门槛都分不清他和没跟上的人。
	 *
	 * 用回调而不用 ref 对象，这不是风格问题。转录容器按会话作键，所以打开一个会话——或者空白对话在
	 * 第一条消息后拿到 id——会扔掉整棵子树重建。ref 对象会悄悄改指向新的哨兵，观察器却还盯着一个已经
	 * 不在文档里、因此再也不会和任何东西相交的节点：标记已读一次都不会触发，「有新内容」永远亮着。
	 */
	tailRef: (node: HTMLDivElement | null) => void;
	/** 要不要给出回去的路。 */
	away: boolean;
	/** 读者离开期间来了多少条消息。除非真的来了东西，否则是零。 */
	unread: number;
	/** 读者要求回去：按了按钮，或者刚发出了什么。 */
	returnToBottom(instant?: boolean): void;
	/** 明确的导航拥有滚动位置，回复正在输出时也一样。 */
	detach(): void;
	/** 立刻跳过去；从那以后位置归导航。 */
	scrollTo(top: number): void;
	/** 交给 `Scroller` 的 `onScroll`。 */
	onScroll(el: HTMLDivElement): void;
	/** 交给 `Scroller` 的 `onResize`。 */
	onResize(el: HTMLDivElement): void;
	/**
	 * 交给 `Scroller` 的 `onUserScroll`：视口自己听不到的那一种手势。
	 *
	 * 浮动滚动条画在视口旁边而不是里面，靠赋值移动滚动面，所以拖滑块不产生滚轮、触摸或按键——只有
	 * 一个滚动事件，而按 `follow.ts` 的规则它不能让任何东西脱离跟随。`Scroller` 是唯一知道拖动就是拖动
	 * 的地方，所以由它说出来，而不是事后和其他一切挪动转录的东西一起从位置里猜。
	 */
	onUserScroll(direction: Direction): void;
	/**
	 * 交给 `Scroller` 的 `onHold`：读者刚把手指按在了什么上面。
	 *
	 * 展开一段折叠区会让转录长高，而长高本身分不清是「新消息到了」还是「读者点开了手里这一块」。
	 * 这一条就是那个区别：按下时记住按到的元素在视口的哪个高度，接下来这一次长高把它放回原处，
	 * 跟随底部让路。没有它，点开历史里的一个工具组会把读者直接甩到转录末尾。
	 */
	hold(target: EventTarget | null): void;
	/**
	 * 接下来这一阵子的高度变化里，把这个元素留在视口的原位——只在读者没跟着底部时。
	 *
	 * 跟着底部时底部本来就钉着，元素下面没变它就不动；这时按住反而让跟随底部让路 `HOLD_MS`，底下随后
	 * 冒出来的东西没人带进视口。不能拿 `away` 来问：它要离底过了门槛才亮，滚开几十像素时已经不跟了、它还没亮。
	 */
	keep(target: HTMLElement): void;
}

export function useFollowBottom({
	surfaceId,
	count,
	tail,
	namespace,
	ready = true,
	live,
}: {
	/** 这是哪个对话、侧聊或委派。没东西可显示时是 `null`。 */
	surfaceId: string | null;
	/** 转录有多少行。 */
	count: number;
	/** 最后一行变了它就变的东西——见 `Marker`。 */
	tail: string;
	/** 记在哪一类界面名下；见 `memory.ts`。 */
	namespace: string;
	/** 恢复的偏移只有在这个面的内容到了之后才有意义。 */
	ready?: boolean;
	/**
	 * 这份转录此刻是不是正在被写。只有这时——以及之后的 `TAIL_MS`，最后几个字还在放出来——长高才算
	 * 输出，也只有输出才追：静止时长高是一张卡片或一张图片晚到了——交付卡片挂载后才去取文件——为它
	 * 滑动，等于把整段历史从下面往上拖。
	 */
	live: boolean;
}): FollowBottom {
	const scrollRef = useRef<HTMLDivElement>(null);
	/*
	 * 放进 state，这样新的哨兵会让观察器的 effect 重跑。
	 *
	 * 多出来的那次渲染只在元素本身被替换时发生——换会话——而它决定了观察器盯的是屏幕上的东西还是
	 * 一个摘下来的节点。在空依赖的 effect 里从 ref 读出来，看着等价，其实不是。
	 */
	const [tailEl, setTailEl] = useState<HTMLDivElement | null>(null);
	const tailRef = useCallback((node: HTMLDivElement | null) => setTailEl(node), []);

	/*
	 * 状态是一个 ref，不是 React 状态。
	 *
	 * 每收到一个 token 都在布局副作用里读它，滚轮处理里写它；任何一边触发重新渲染，都是整份转录重新
	 * 渲染。要画出来的东西从它推出——下面的 `away` 和 `unread`——而这两个很少变。
	 */
	const state = useRef<FollowState>("following");
	const [away, setAway] = useState(false);
	const [unread, setUnread] = useState(0);

	/** 读者跟上到了哪里。null 表示「全部」，面一开始就是这样。 */
	const seen = useRef<Marker | null>(null);
	/**
	 * 转录此刻的样子，给渲染之外跑的回调用——主要是哨兵的观察器。在布局副作用里更新而不是在渲染时，
	 * 这样被 React 丢弃的渲染不会给一份从未提交的转录留下标记。
	 */
	const current = useRef<Marker>(makeMarker(count, tail));

	/**
	 * 这个 hook 上一次写的位置，好让它引起的滚动事件不被当成读者在动。下一帧清掉——滚动事件在 rAF
	 * 之前派发，到那时还留着这个值，说明它根本没产生过滚动事件。
	 */
	const written = useRef<number | null>(null);
	const lastTop = useRef(0);
	const glide = useRef(0);
	/** 贴底追赶的那一帧，和上一次送到底时内容与视口的高度——分辨「内容长高了一小截」要用。 */
	const chase = useRef(0);
	const size = useRef({ content: 0, view: 0 });
	const flow = useRef<Flow>({ amount: 0, at: 0, since: 0 });
	/**
	 * 滚动区里正在做高度过渡的元素。
	 *
	 * 界面块边写边长、折叠区开合，这种长高本身已经是一帧一小截、平滑的，
	 * 再交给弹簧抹一遍只会落后：量到过界面块的下沿被压到视口外 116px。所以它在 `pin` 里当帧跟着挪。
	 * 过渡事件会冒泡，在滚动区上听就够。
	 */
	const growing = useRef(new Set<EventTarget>());
	const restoredSurface = useRef<string | null | undefined>(undefined);
	const selectedSurface = useRef<string | null | undefined>(undefined);
	const restore = useRef<FollowSnapshot | undefined>(undefined);
	const clearWritten = useRef(0);
	/**
	 * 刚露面（换了会话、从 `Activity` 的隐藏里回来）、第一帧还没画完。
	 *
	 * 回来时第一次提交画的是离开时的旧内容，订阅重挂后紧跟着补进离开期间写下的字。那一截不是此刻在出的
	 * 字，滑过去就是切进来先落后一百来像素、再往上滑一段。所以这段时间里贴底一律一步到位。撑两帧：
	 * 补账那次 `pin` 走的是 `ResizeObserver`，晚于同一帧的 rAF。
	 */
	const arriving = useRef({ on: false, frame: 0 });
	/** 给 `pin` 读，它是记忆化的，不能每个 token 重建一次。`ended`：`live` 上一次落下的时刻。 */
	const writing = useRef({ live, ended: Number.NEGATIVE_INFINITY });
	if (writing.current.live && !live) writing.current.ended = performance.now();
	writing.current.live = live;

	/**
	 * 手指上一次的位置，给 touchmove 定方向用。
	 *
	 * 触摸和滚轮不一样：`wheel` 自带 `deltaY`，`touchmove` 只给坐标，方向得自己算。手指往上抹，
	 * 内容跟着往上走，露出来的是更下面的东西——所以 clientY 变小是 "down"。
	 */
	const touchY = useRef(0);

	/*
	 * 刚被按下的那个东西，和它当时在视口里的高度。
	 *
	 * 展开一段折叠区会让转录长高，而长高会走 `onResize`——那里只问一句「在不在跟随底部」，在就
	 * 滚到底。于是点开一个历史里的折叠区，读者被直接带到转录末尾：量过一次「调用工具 42 个」，
	 * 点中的那个按钮当场飞出视口 1952px；「再显示 1 个文件」则是整段文字平移 36px。人说的「点
	 * 一下就在跳」就是这个。
	 *
	 * 按下时记住它的位置，长高之后把它放回原处——点开的那一段自然向下延展，手指底下的东西一动
	 * 不动。这是「跟随底部」唯一该让路的时候：读者正在看的是手里这一块，不是末尾。
	 */
	const anchor = useRef<{ el: HTMLElement; top: number; until: number } | null>(null);

	/*
	 * 读者眼前那一块（见 `firstInView`）、它离视口顶多远，以及记下时视口有多宽。
	 *
	 * 宽度一变正文就重新断行，上面的内容跟着变高变矮。浏览器的滚动锚定在这里不补：窄窗格里开合
	 * 侧栏，不靠这里时眼前那一段一路被带走 171px；停在离底部 150px 处收起侧栏，画面一帧上跳 123px、
	 * 几乎贴底，展开又跳回来。侧栏、右栏开合，拖分隔线、拖窗口都走这一处。
	 *
	 * 只管宽度变了的那一帧，也只在读者滚开时管：跟着底部的由 `pin` 送到底，按住东西的由 `settle`。
	 * 曾经由侧栏动画接管正文那一栏的宽度来补这件事，它和跟随底部、浏览器的滚动夹位轮流打架。
	 */
	const place = useRef<{ node: Element; top: number; width: number } | null>(null);

	const read = (el: HTMLDivElement): Reading => ({
		scrollTop: el.scrollTop,
		scrollHeight: el.scrollHeight,
		clientHeight: el.clientHeight,
	});

	/** 移动滚动面，并记住是我们动的。 */
	const write = useCallback((el: HTMLDivElement, top: number) => {
		el.scrollTop = top;
		// 读回来而不是相信赋值：浏览器会夹紧，和夹过的值比较，`onScroll` 里的检查在刚变短的转录上才可靠。
		written.current = el.scrollTop;
		lastTop.current = el.scrollTop;
		cancelAnimationFrame(clearWritten.current);
		clearWritten.current = requestAnimationFrame(() => {
			written.current = null;
		});
	}, []);

	/**
	 * 把锚点放回按下时那个高度。返回 true 表示这一次长高由锚点做主，跟随底部不要插手。
	 *
	 * 只碰 `scrollTop`，不碰任何 React 状态——它要能在 `ResizeObserver` 的回调里**同步**跑完。
	 * 那个回调发生在布局之后、绘制之前，是这一帧最后一次还来得及改位置的机会；推到 rAF 里就晚
	 * 了一帧，当帧已经拿旧位置画过一遍，展开动画走完就是肉眼可见的一串小抖（量到 14px）。
	 *
	 * 返回 true 的时机也是要点：不光锚点漂了要挪，**没漂也得拦住**跟随底部。一段在底部附近展开
	 * 的折叠区照样把 `scrollHeight` 撑大，不拦就被原样拉到底。
	 */
	const settle = useCallback(
		(el: HTMLDivElement): boolean => {
			const held = anchor.current;
			if (!held) return false;
			if (performance.now() > held.until || !held.el.isConnected) {
				anchor.current = null;
				return false;
			}
			/*
			 * 自己把它挪回去，不要指望浏览器原生的 scroll anchoring。
			 *
			 * 试过只拦不挪：展开一个大工具组（长高 952px）时原生锚定确实顶住了，一动不动；而展开
			 * 底部那张文件卡（36px）它整整漏掉 36px，按钮被推走多少就是多少。两种一起量才看得出
			 * 来——只测大的那个会得出「原生的就够了」这个错结论。
			 */
			const drift = held.el.getBoundingClientRect().top - held.top;
			if (Math.abs(drift) >= 1) write(el, el.scrollTop + drift);
			return true;
		},
		[write],
	);

	/**
	 * 记下读者眼前那一行；跟着底部的不用记。
	 *
	 * 滚动事件里也要记（读者滚到了别处），但宽度已经变了的那一帧不行：滚动事件派发时，这一帧的
	 * 新宽度和重新断行已经排好了，这时记下的是漂过之后的位置，`keepPlace` 就量不到漂移。量到过：
	 * 补偿写下去的下一帧，它自己的滚动事件把基准换掉，一半的帧白白漂走 24px。那一帧留给 `onResize`。
	 */
	const remember = useCallback((el: HTMLDivElement, scrolled = false) => {
		if (scrolled && place.current && el.clientWidth !== place.current.width) return;
		place.current = null;
		if (state.current !== "detached") return;
		const edge = el.getBoundingClientRect().top;
		const node = firstInView(el, edge);
		if (node) place.current = { node, top: node.getBoundingClientRect().top - edge, width: el.clientWidth };
	}, []);

	/**
	 * 宽度变了，把眼前那一行放回原来的高度。和 `settle` 一样只碰 `scrollTop`，在 `ResizeObserver`
	 * 的回调里同步跑完。按屏幕上的位置量：哪一帧浏览器自己锚定过，这里就量到没漂，不会补两遍。
	 */
	const keepPlace = useCallback(
		(el: HTMLDivElement) => {
			const kept = place.current;
			if (!kept || state.current !== "detached" || el.clientWidth === kept.width || !kept.node.isConnected) return;
			const drift = kept.node.getBoundingClientRect().top - el.getBoundingClientRect().top - kept.top;
			if (Math.abs(drift) >= 0.5) write(el, el.scrollTop + drift);
		},
		[write],
	);

	/** 重画所有从当前位置推出来的东西。 */
	const publish = useCallback((reading: Reading) => {
		if (isDegenerate(reading)) return;
		// 只给停在上面某处的读者回去的路。滑到一半时，按钮提供的就是正在发生的事。
		setAway(state.current === "detached" && isAway(reading));
	}, []);

	/**
	 * 跟随底部时把位置送到底：一屏以内的长高用弹簧追、最多落后 `LAG_MAX`，其余一步到位——见 `CHASE_MAX`。
	 *
	 * 两个入口共用它：内容签名变了（布局 effect）和尺寸变了（`onResize`），流式输出时两者每帧
	 * 都会来，所以「已经在追」本身就是继续追的理由，第二个入口不能把它打断成一步到位。
	 *
	 * 视口变了不追：输入框长高两行时，最后一行要立刻跟着让出来，不然会被输入框挡住一阵。
	 */
	const pin = useCallback(
		(el: HTMLDivElement) => {
			const reading = read(el);
			const grew = reading.scrollHeight - size.current.content;
			const sameView = reading.clientHeight === size.current.view;
			size.current = { content: reading.scrollHeight, view: reading.clientHeight };
			const now = performance.now();
			const kept = flow.current.amount * Math.exp(-(now - flow.current.at) / FLOW_TAU);
			const added = grew > 0 && grew <= CHASE_MAX ? grew : 0;
			flow.current = { amount: kept + added, at: now, since: added > 0 && kept < 1 ? now : flow.current.since };
			const target = targetScrollTop("following", reading);
			if (target === null) return;

			const moving = chase.current !== 0;
			const output = writing.current.live || now - writing.current.ended < TAIL_MS;
			// 窗口最小化时不追，直接贴底：正文那时按 10Hz 长（`ticker.ts`），弹簧却照样每帧写 `scrollTop`，
			// 省下的那点几乎全被它吃掉。没人看的时候，这一段滑不滑没有区别。
			const slide =
				!arriving.current.on &&
				output &&
				sameView &&
				grew >= 0 &&
				grew <= reading.clientHeight &&
				target > reading.scrollTop &&
				(moving || grew > 0) &&
				!motionReduced() &&
				!windowMinimized();
			if (!slide) {
				cancelAnimationFrame(chase.current);
				chase.current = 0;
				write(el, target);
				return;
			}
			// 这里跑在布局之后、绘制之前（布局 effect 或 `ResizeObserver` 回调），下面两次写都当帧生效。
			// 高度过渡里长出来的这一截跟着挪，见 `growing`。
			if (grew > 0 && transitioning(growing.current)) write(el, reading.scrollTop + grew);
			if (target - el.scrollTop > LAG_MAX) write(el, target - LAG_MAX);
			if (moving) return;

			// 位置自己记一份小数：浏览器会把 `scrollTop` 取整到物理像素，每帧挪不到半个像素的那几帧
			// 读回来原地不动，拿读回来的值接着算就永远差那一点。
			const view: Spring = { at: el.scrollTop, speed: 0 };
			// 前一级：抹平了的目标。
			const ramp: Spring = { at: el.scrollTop, speed: 0 };
			let last = 0;
			const step = (now: number) => {
				chase.current = 0;
				// 读者滚开了、按住了东西、或者换了会话：不追了。
				if (state.current !== "following" || anchor.current || !el.isConnected) return;
				const here = read(el);
				if (isDegenerate(here)) return;
				// 别人挪过（浏览器夹住、原生锚定、`LAG_MAX` 那一刀），以实际位置为准；前一级不能落在视口
				// 后面，否则会把视口往回拽。
				if (Math.abs(here.scrollTop - view.at) > 1) view.at = here.scrollTop;
				if (ramp.at < view.at) ramp.at = view.at;
				// 第一帧没有上一帧可比，按一帧算；切到后台回来的那一帧夹住，不一步跳完。
				const dt = last ? Math.min(50, Math.max(0, now - last)) : 16;
				last = now;
				const end = visualBottom(here);
				const omega = stiffness(outputRate(flow.current, now), end - view.at);
				advance(ramp, end, omega, dt);
				advance(view, ramp.at, 2 * omega, dt);
				if (end - view.at < 0.5 && end - ramp.at < 0.5) {
					// 多写一个像素让浏览器夹到真正的底，理由见 `targetScrollTop`。
					write(el, end + 1);
					publish(read(el));
					return;
				}
				write(el, view.at);
				chase.current = requestAnimationFrame(step);
			};
			chase.current = requestAnimationFrame(step);
		},
		[write, publish],
	);

	// ---------------------------------------------------------------------------
	// 读者的意图
	// ---------------------------------------------------------------------------

	/**
	 * 所有能改变状态的东西，集中在一处。
	 *
	 * 从原生监听里调用，而不是 React 的合成事件，因为要紧的就是在手势引起的那一帧**之前**听到它：一格
	 * 滚轮和一个输出的 token 在赛跑，输掉这场赛跑，回复输出时往上滚就像滚轮失灵了。
	 */
	const intend = useCallback(
		(direction: Direction) => {
			const el = scrollRef.current;
			if (!el) return;
			const reading = read(el);
			const before = state.current;
			state.current = nextState(before, { kind: "user-scroll", direction }, reading);
			// 不管因为什么离开了 `returning`，滑动都作罢。
			if (before === "returning" && state.current !== "returning") cancelAnimationFrame(glide.current);
			// 自己滚开了，手里那个锚就不是「正在看的东西」了。
			anchor.current = null;
			publish(reading);
		},
		[publish],
	);

	/*
	 * 三个监听，每一个听到的都是叫得出名字的手势。
	 *
	 * 要紧的是这里**没有**什么。不要在宿主上挂 `pointerdown`、在 window 上挂 `pointermove`/`pointerup`/
	 * `pointercancel`，去喂一个「读者手上按着东西」的标记，让 `onScroll` 把位置变化读成手势。它们都不是
	 * 滚动。window 上的 `pointerup` 在点侧栏、点面板里的按钮、点输入框时都会触发——整个应用——每一次都
	 * 打开一个 300ms 的窗口，输出中下一次重排就会结束跟随。宿主上的 `pointerdown` 也好不到哪去：它在
	 * 视口之上，展开一张工具卡片、在转录里选一行字都经过它。而且那个标记的 `pointerup` 一旦被原生右键
	 * 菜单吞掉、或者因窗口失焦丢掉，就再也回不来，面在下一次重排时脱离跟随，然后一直那样。
	 *
	 * 拖滑块是它们要抓的唯一真正的手势，现在由 `Scroller` 经 `onUserScroll` 报告。所以它们整个不要，
	 * 而不是收窄。
	 */
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;

		/** 手势落在这个面上，而不是嵌在里面的某个面上。 */
		const mine = (event: Event) => !(event.target instanceof Element) || event.target.closest(".plume-scroll-view") === el;

		const onWheel = (event: WheelEvent) => {
			if (event.deltaY === 0) return;
			// 转录里的工具结果或代码块可以自己独立滚动。
			if (!mine(event)) return;
			intend(event.deltaY < 0 ? "up" : "down");
		};
		// 手指按下，还没动就已经是在认领这块面。
		const onTouchStart = (event: TouchEvent) => {
			if (!mine(event)) return;
			touchY.current = event.touches[0]?.clientY ?? 0;
			intend("unknown");
		};
		const onTouchMove = (event: TouchEvent) => {
			if (!mine(event)) return;
			const y = event.touches[0]?.clientY;
			if (y === undefined) return;
			const moved = y - touchY.current;
			touchY.current = y;
			// 手指不动不算方向；别的都算，不管多小。
			if (moved === 0) return;
			intend(moved > 0 ? "up" : "down");
		};
		/*
		 * 按键靠冒泡到这里，不靠焦点。
		 *
		 * 视口没有 `tabIndex`，自己从不持有焦点——但它是转录里所有东西的祖先，所以焦点在工具卡片的展开
		 * 按钮上时按 `PageUp` 会经过这里，那和别的滚动一样。输入框除外，因为在里面同样的键移动的是光标。
		 */
		const onKey = (event: KeyboardEvent) => {
			if (event.target instanceof Element && event.target.closest("textarea, input, [contenteditable=true]")) return;
			if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
			intend(["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey) ? "up" : "down");
		};

		// 被动监听：都不阻止默认行为，说明这一点能让滚轮不卡在主线程的关键路径上。
		el.addEventListener("wheel", onWheel, { passive: true });
		el.addEventListener("touchstart", onTouchStart, { passive: true });
		el.addEventListener("touchmove", onTouchMove, { passive: true });
		el.addEventListener("keydown", onKey);
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("touchstart", onTouchStart);
			el.removeEventListener("touchmove", onTouchMove);
			el.removeEventListener("keydown", onKey);
		};
	}, [intend]);

	// 哪些元素正在做高度过渡，见 `growing`。
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onRun = (event: TransitionEvent) => {
			if (event.target && SIZES.has(event.propertyName)) growing.current.add(event.target);
		};
		const onEnd = (event: TransitionEvent) => {
			if (event.target && SIZES.has(event.propertyName)) growing.current.delete(event.target);
		};
		el.addEventListener("transitionrun", onRun);
		el.addEventListener("transitionend", onEnd);
		el.addEventListener("transitioncancel", onEnd);
		return () => {
			el.removeEventListener("transitionrun", onRun);
			el.removeEventListener("transitionend", onEnd);
			el.removeEventListener("transitioncancel", onEnd);
		};
	}, []);

	// ---------------------------------------------------------------------------
	// 滚动面报上来的
	// ---------------------------------------------------------------------------

	const onScroll = useCallback(
		(el: HTMLDivElement) => {
			if (!ready || restoredSurface.current !== surfaceId) return;
			const reading = read(el);
			lastTop.current = reading.scrollTop;

			if (isDegenerate(reading)) return;

			// 我们自己的写入，以事件的形式到达。它不说明读者想要什么。
			if (written.current !== null && Math.abs(reading.scrollTop - written.current) < 1) {
				written.current = null;
				remember(el, true);
				publish(reading);
				return;
			}

			/*
			 * 其他所有挪动了面的东西，当成一件事——因为在这里它们就是一件事。
			 *
			 * 甩动的尾巴、浏览器夹住一份刚失去最旧一轮的转录、上方展开一段推理时锚定稳住一行：到达这里时
			 * 它们只是一个位置，别的什么都不是。由此能诚实做出的断言只有 `arrived`，它只能把面放回末尾，
			 * 永远不能把它拿开。手势在它发生的地方听，在 `intend` 里。
			 */
			state.current = nextState(state.current, { kind: "arrived" }, reading);
			remember(el, true);
			publish(reading);
		},
		[publish, ready, surfaceId, remember],
	);

	/** 换过来以后头一次量到真尺寸：读者在这儿往上翻过的话，放回上次停的位置。只做一次。 */
	const restoreOnce = useCallback(
		(el: HTMLDivElement) => {
			if (restoredSurface.current === surfaceId) return;
			restoredSurface.current = surfaceId;
			if (state.current === "detached" && restore.current) write(el, restore.current.scrollTop);
		},
		[surfaceId, write],
	);

	/**
	 * 盒子或它的内容改了尺寸。
	 *
	 * 跟随必须在这里**执行**，而不只是重新判断：输入框长高两行会挪动底部而不挪动内容，只重新判断的面
	 * 会得出读者走开了的结论。
	 */
	const onResize = useCallback(
		(el: HTMLDivElement) => {
			// 手里按着东西的时候，跟随底部让路——细节见 `settle`。排在下面的门前面：会话还在读盘时点开
			// 一段折叠区，也要把按到的那一块放回原处。
			const held = settle(el);
			if (!ready || selectedSurface.current !== surfaceId) return;
			const reading = read(el);
			if (isDegenerate(reading)) return;
			restoreOnce(el);
			if (!held) {
				if (state.current === "following") pin(el);
				else keepPlace(el);
			}
			remember(el);
			publish(read(el));
		},
		[publish, ready, surfaceId, settle, restoreOnce, pin, keepPlace, remember],
	);

	/**
	 * 按在转录上的那一下：记住按到的是谁，以及它此刻在视口的哪个高度。
	 *
	 * 挂在捕获阶段，比任何 `onClick` 都早——展开的那一帧要用的是**按下时**的位置，等到点击冒泡
	 * 上来，布局可能已经变了。
	 *
	 * 不挑按钮也不挑元素：不改变高度的点击根本不会走到 `onResize`，锚点在超时后自己过期，什么
	 * 也不会发生。挑，反而要在这里重写一遍「哪些东西点了会变高」，而那份名单一定会漏。
	 */
	const hold = useCallback((target: EventTarget | null) => {
		if (!(target instanceof HTMLElement)) return;
		anchor.current = { el: target, top: target.getBoundingClientRect().top, until: performance.now() + HOLD_MS };
	}, []);

	const keep = useCallback(
		(target: HTMLElement) => {
			if (state.current !== "following") hold(target);
		},
		[hold],
	);

	// ---------------------------------------------------------------------------
	// 回去
	// ---------------------------------------------------------------------------

	const returnToBottom = useCallback(
		(instant = false) => {
			const el = scrollRef.current;
			if (!el) return;
			const reading = read(el);
			if (isDegenerate(reading)) return;

			cancelAnimationFrame(glide.current);
			state.current = nextState(state.current, { kind: "user-return" }, reading);
			/*
			 * 回去比按住的那一下新。转录里的按钮发出一句话，按下时 `hold` 记了它；不在这里放掉，气泡一画进来
			 * `settle` 就把按钮放回原处，刚落到底又被拉回去——量过，离底 113px 停了 850ms，自己的话看不见。
			 */
			anchor.current = null;

			const land = () => {
				const settled = read(el);
				// 越过末尾一个像素，理由见 `targetScrollTop`：整数的底部最多比真正的底部差一个像素，落短了，
				// 滑回去就会留下跟随写入那样的亚像素空隙。
				write(el, visualBottom(settled) + 1);
				state.current = nextState(state.current, { kind: "settle" }, settled);
				seen.current = current.current;
				setUnread(0);
				publish(read(el));
			};

			// 发送消息是一步到位，不是 420ms 的飞行：从收起的窗口滑过去，就是发送时那一弹的后半段。已经在
			// 那里、或者要求不要动来动去，也这样落地。不管哪种，未读标记都照样清掉。
			if (instant || state.current !== "returning" || motionReduced()) {
				land();
				return;
			}

			const from = reading.scrollTop;
			const started = performance.now();
			const step = (now: number) => {
				// 被打断了：`intend` 已经把状态拿走、取消了帧，但已经约好的帧仍可能到来。
				if (state.current !== "returning") return;
				const progress = Math.min(1, (now - started) / GLIDE_MS);
				const eased = 1 - (1 - progress) ** 3;
				// 每帧重读：还在输出的回复会在动画底下把页面撑长，开始时定死的目标，到达时已经不是末尾了。
				const target = visualBottom(read(el));
				write(el, from + (target - from) * eased);
				if (progress < 1) {
					glide.current = requestAnimationFrame(step);
					return;
				}
				land();
			};
			glide.current = requestAnimationFrame(step);
			setAway(false);
		},
		[publish, write],
	);

	// ---------------------------------------------------------------------------
	// 跟上
	// ---------------------------------------------------------------------------

	/*
	 * 看到末尾才算已读——不是在底部。
	 *
	 * 往上滚两屏读新到的东西、停在那里，就是跟上了，任何距离判断都分不清它和没跟上。哨兵是内容里的
	 * 最后一样东西，所以它进入视口就是事实本身，而不是事实的替身。
	 */
	useEffect(() => {
		const root = scrollRef.current;
		if (!root || !tailEl) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				seen.current = current.current;
				setUnread(0);
			},
			{ root },
		);
		observer.observe(tailEl);
		return () => observer.disconnect();
	}, [tailEl]);

	// ---------------------------------------------------------------------------
	// 换掉面上显示的东西
	// ---------------------------------------------------------------------------

	/**
	 * 声明在跟随底部的那个 effect 前面，因为必须先于它运行。
	 *
	 * React 按声明顺序跑布局副作用，顺序反了，记住的位置就没用了：跟随的 effect 先跑，把**离开的**面的
	 * 位置写进**进来的**面的记忆里，恢复时又忠实地读回刚写进去的东西。
	 *
	 * 保存在清理函数里做，而不是在下一次运行的开头。清理函数在 DOM 更新之后、任何布局副作用碰
	 * `scrollTop` 之前运行，所以在那里读到的仍是离开的面的位置——而且和对比记下的上一个 id 不同，组件
	 * 卸载时它也会触发，切到别的视图时整份转录就是这样被卸掉的。
	 */
	useLayoutEffect(() => {
		size.current = { content: 0, view: 0 };
		const arrival = arriving.current;
		arrival.on = true;
		arrival.frame = requestAnimationFrame(() => {
			arrival.frame = requestAnimationFrame(() => {
				arrival.on = false;
			});
		});
		written.current = null;
		touchY.current = 0;
		restoredSurface.current = undefined;
		selectedSurface.current = surfaceId;
		place.current = null;
		current.current = makeMarker(count, tail);
		restore.current = surfaceId ? readFollow(namespace, surfaceId) : undefined;
		// 进来的面自己记住的意图，绝不是离开的那个的。把上一个会话的带过来，你往上翻过的转录就会把它的
		// 位置——连同未读的点——交给你接着打开的随便哪个会话。
		state.current = restore.current?.following === false ? "detached" : "following";
		seen.current = restore.current?.seen ?? null;
		setUnread(0);
		setAway(false);

		return () => {
			// 滑动属于离开的面。它的意图在下面保存，它的帧则必须在进来的面复用同一批状态和元素 ref 之前停掉。
			// 卸载时也跑，所以这是把它们全部停掉的唯一一处。
			cancelAnimationFrame(glide.current);
			cancelAnimationFrame(chase.current);
			chase.current = 0;
			cancelAnimationFrame(clearWritten.current);
			cancelAnimationFrame(arrival.frame);
			/*
			 * 位置取自 `lastTop`，不取自元素。
			 *
			 * 两个原因，第二个不明显。React 在跑父级的布局清理之前先摘掉子级的 ref，所以卸载时这里的
			 * `scrollRef.current` 已经是 null——而窗格切到别的视图时，整份转录正是被卸掉的。另外，窗格只是
			 * 隐藏时拿到的读数是零，存下来的话，下次打开时读者会被放到转录顶部。`lastTop` 由每次滚动和我们的
			 * 每次写入更新，从不来自退化的测量，所以它就是这个面最后真正在的位置。
			 */
			// 加载中的占位绝不能替换真实的阅读位置。
			if (!surfaceId || restoredSurface.current !== surfaceId) return;
			writeFollow(namespace, surfaceId, {
				following: followsAfterRestore(state.current),
				scrollTop: lastTop.current,
				seen: seen.current,
			} satisfies FollowSnapshot);
		};
		// 为了标记读了 `count` 和 `tail`，但有意不依赖它们：这个 effect 管的是面的更换，每个 token 都重跑
		// 会重读记忆，把读者的位置撤销掉。
		// oxlint-disable-next-line exhaustive-deps
	}, [surfaceId, namespace, publish, write]);

	/**
	 * 内容变了：跟上它，或者数它。
	 *
	 * 数是算出来的，不是累加的，用的是描述转录内容而不是它引用的两个数。打开一个会话会把同样的消息
	 * 交给 React 两遍——一遍来自缓存，一遍是磁盘读完落地——按引用判断的未读标记会把第二遍当成新内容。
	 * 那就是只是回来看一眼的会话上冒出来的「有新内容」。
	 */
	useLayoutEffect(() => {
		current.current = makeMarker(count, tail);
		const el = scrollRef.current;
		if (!el || !ready) return;
		const reading = read(el);
		if (isDegenerate(reading)) return;
		restoreOnce(el);

		if (state.current === "following") {
			pin(el);
			seen.current = current.current;
			setUnread(0);
		} else {
			setUnread(unreadSince(seen.current, current.current));
		}
		publish(read(el));
	}, [count, tail, publish, ready, restoreOnce, pin]);

	const detach = useCallback(() => {
		cancelAnimationFrame(glide.current);
		state.current = "detached";
	}, []);
	const scrollTo = useCallback(
		(top: number) => {
			detach();
			const el = scrollRef.current;
			if (!el) return;
			write(el, Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight)));
			publish(read(el));
		},
		[detach, publish, write],
	);
	return { scrollRef, tailRef, away, unread, returnToBottom, onScroll, onResize, onUserScroll: intend, detach, scrollTo, hold, keep };
}

/**
 * 读者眼前的第一块：按文档顺序第一个从 `edge` 或更下面开始的元素。
 *
 * 不取被视口顶边切开的那一块：一段纯文字被切开时，它自己重新断行，锚在它的顶上，露出来的那几行
 * 照样会动（量到过 22px）。一段文字比整个视口还高、里面没有别的开头时就找不到，那次不补。
 */
function firstInView(parent: Element, edge: number): Element | null {
	for (const child of parent.children) {
		const box = child.getBoundingClientRect();
		if (box.bottom <= edge) continue;
		if (box.top >= edge) return child;
		const inner = firstInView(child, edge);
		if (inner) return inner;
	}
	return null;
}

interface Spring {
	at: number;
	speed: number;
}

/** 临界阻尼弹簧朝 `target` 走 `dt` 毫秒的精确解，步长再大也不会冲过头或者发散。 */
function advance(spring: Spring, target: number, omega: number, dt: number): void {
	const offset = spring.at - target;
	const decay = Math.exp(-omega * dt);
	const pull = spring.speed + omega * offset;
	spring.at = target + (offset + pull * dt) * decay;
	spring.speed = (spring.speed - omega * pull * dt) * decay;
}

/**
 * 前一级弹簧的角频率（每毫秒），后一级取它的两倍：稳定输出时两级的落后合起来是 3 × 速度 / ω，
 * 也就是 `CHASE_LAG`。落后超出 `CHASE_LAG` 越多越硬（`BOOST`），夹在 `TAU_MIN`–`TAU_MAX` 之间。
 *
 * 速度取内容长高的速度，不取弹簧自己的速度：拿自己的速度定刚度会互相推高，一块大的长高第一帧就
 * 冲出去几百像素。
 */
function stiffness(rate: number, lag: number): number {
	return Math.min(1 / TAU_MIN, Math.max(1 / TAU_MAX, (3 * rate) / CHASE_LAG, (lag - CHASE_LAG) / BOOST));
}

/** 最近小幅长高的总量（按 `FLOW_TAU` 衰减）、记下它的时刻，和这一阵输出从什么时候开始。 */
interface Flow {
	amount: number;
	at: number;
	since: number;
}

/**
 * 输出速度（像素/毫秒）。一阵输出刚开始时衰减的总量还没攒满，按它实际跑了多久归一，不然头几行
 * 估得极慢、落后一大截；最少按 150ms 算，不然头一行会被当成一瞬间到的。
 */
function outputRate(flow: Flow, now: number): number {
	const window = FLOW_TAU * (1 - Math.exp(-Math.max(150, now - flow.since) / FLOW_TAU));
	return (flow.amount * Math.exp(-(now - flow.at) / FLOW_TAU)) / window;
}

/** 还有高度过渡在跑吗。顺手清掉被卸掉的：卸掉的元素收不到结束事件。 */
function transitioning(inFlight: Set<EventTarget>): boolean {
	for (const target of inFlight) {
		if (target instanceof Node && !target.isConnected) inFlight.delete(target);
	}
	return inFlight.size > 0;
}
