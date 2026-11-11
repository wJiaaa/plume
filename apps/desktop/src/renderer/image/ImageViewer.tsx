/**
 * 全尺寸的图，从你点它的地方飞过来。
 *
 * 两个 transform，挂在两个元素上，做两件不相干的事。
 *
 * 外层那个是飞行。它必须是 FLIP：两种状态尺寸不同，没有哪一个属性能老老实实地从一头走到另一头。先量出最终
 * 的布局——居中、限制在窗口里——飞行就是从缩略图（见 `flight.ts`）到那个盒子的一段动画。中途从不按中间尺寸
 * 排版，所以大图和小图一样便宜，路上谁都不重排。
 *
 * 内层那个是缩放和平移。单独一个元素，两者永远不会互相覆盖，飞行量到的也是停稳后的布局盒子——子元素的
 * transform 不影响它——所以放大之后再关闭，仍然飞回正确的缩略图。
 *
 * 盒子永远是 `<img>` 的。标注画布是盖在它上面的一层，从不取代它：画布取代图片时，飞行量到的是当时恰好挂着
 * 的那一个——而没解码的画布是 300×150，于是在生成的图上点「编辑」，飞行从缩略图的 2.8 倍开始、缩回原位。
 *
 * 关闭走同一条路倒过来，落地之后才卸载——一按就消失、什么都不动的浮层，正是这里取代掉的东西。
 */

import {
	AnnotateCanvas,
	AnnotateToolbar,
	clampZoom,
	EASING,
	holdScrim,
	type Point,
	portal,
	STAGE_FIT,
	useAnnotator,
	useI18n,
	useMovableBar,
	wheelZoomFactor,
	ZOOM_MAX,
	ZOOM_MIN,
	ZOOM_STEP,
	zoomAt,
} from "@plume/ui";
import { ChevronLeft, ChevronRight, Copy, Download, Maximize2, Minus, Pencil, Plus, X } from "@plume/ui/icons";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { atRest, atThumbnail, type Box, type FlightKeyframe, paintedBox, type Thumb } from "./flight.ts";
import { copyImage, notifyExportFailed, saveImage } from "./image-out.ts";
import { closeViewer, stepViewer, useViewer, type ViewerImage } from "./viewer-store.ts";

/**
 * 有意比 `--plume-t-base` 长。
 *
 * 220ms 对一张横穿整个窗口的图来说太快：它走的路比任何面板都远，220 看起来像是被甩出去的。260 是对的数。
 *
 * 写成数字，是因为卸载要按它来掐时间。
 */
const DURATION = 260;

/**
 * 应用的 `out` 曲线，从定义它的那一处取。
 *
 * 一张图从缩略图飞到屏幕中间，是应用里最显眼的动效；浏览器自带的 `ease-out` 是一条平缓的曲线，全程都在减速
 * ——在这个尺寸上读起来像图被拖着走，而不是被放开。这一条出发快、落定晚，才像图是被松手放出去的。
 */
const EASE = EASING.out;

/** 缩放层的过渡，这样退出时取消缩放和飞行一起走。 */
const FLIGHT = `transform ${DURATION}ms ${EASE}`;

/** 遮罩和控件：跟着飞行的时钟，到达时从无淡入。 */
const FADE = `opacity ${DURATION}ms ${EASE}`;
/** 遮罩的黑，和 `bg-shade/72` 画出来的一样；窗口自己的按钮按同一个数压暗。 */
const BACKDROP_ALPHA = 0.72;

const CENTRED: Point = { x: 0, y: 0 };

/**
 * 往旁边翻一张要多久。
 *
 * 整段时间里两张图都在屏幕上，所以这是一次连续移动的长度，而不是先淡出再淡入。
 */
const SLIDE_MS = 300;

/** 两张图擦肩而过时中间的空隙，读起来是两张，而不是糊成一片。 */
const SLIDE_GAP = 56;

export function ImageViewerHost() {
	const { t } = useI18n();
	const state = useViewer();
	const [leaving, setLeaving] = useState(false);
	const [editing, setEditing] = useState(false);
	const figure = useRef<HTMLDivElement>(null);
	const origin = useRef<DOMRect | null>(null);
	/** 这张图来自的那张缩略图，图在外面的时候它藏着。 */
	const source = useRef<HTMLElement | null>(null);
	/** 上一次提交时 store 的状态，给那种在别的东西打开之后才落地的退出用。 */
	const latest = useRef(state);
	useLayoutEffect(() => {
		latest.current = state;
	});

	// 关闭动画期间留着，图片缩回去之前不会先消失。
	const [held, setHeld] = useState<ReturnType<typeof useViewer>>(null);
	const shown = state ?? held;
	const image = shown?.images[shown.index] ?? null;

	/*
	 * 缩放和偏移是一份状态，不是两份。
	 *
	 * 它们总是一起变——每一次缩放都意味着让锚点不动的那个偏移——分开放，就招来那种读一个、写另一个的更新。
	 * 最早就是那样写的：`setOffset(previous => { setZoom(...); return ... })`，在一个 updater 里调另一个
	 * setter。updater 必须是状态的纯函数，因为 React 每次提交会跑它不止一遍。合成一个值就写不出那种代码，
	 * 而 `zoomAt` 返回的正好是这个形状。
	 */
	const [view, setView] = useState<{ zoom: number; offset: Point }>({ zoom: 1, offset: CENTRED });
	const { zoom, offset } = view;
	const [panning, setPanning] = useState(false);
	/**
	 * 正在进行的一次翻页：被留下的那张图，以及这一对要走多远。
	 *
	 * `phase` 是 CSS 过渡需要的两帧——`start` 不带过渡地摆好两张图，`run` 打开过渡、让它们动起来。没有渲染过
	 * 的起点就没有东西可插值，它们只会直接出现在终点。
	 */
	const [transit, setTransit] = useState<{
		parting: ViewerImage;
		dir: number;
		span: number;
		phase: "start" | "run";
	} | null>(null);
	const sliding = useRef(0);
	const [spacing, setSpacing] = useState(false);
	const grab = useRef<{ x: number; y: number; from: Point } | null>(null);

	/*
	 * 图落地之后才解码——不是按「标注」时，也不是飞行途中。
	 *
	 * 推迟到按按钮时，省了一次解码，换来一下闪烁：画布在源图加载完之前就挂上了，而没设宽度的画布是 300×150，
	 * 所以按「标注」时图片被一个小白框顶替，直到解码完。
	 *
	 * 改成立刻解码修好了那个，换来更糟的：解码一张截图、画进画布是以几十毫秒计的主线程工作，而它恰好和打开
	 * 动画在同一帧开始——于是每一次图都是一顿一顿地挪到屏幕中间，偏偏是整个组件存在就为了让它顺滑的那一刻。
	 *
	 * 所以：飞完再说。等人看完图、伸手去按「标注」的时候，它早就准备好了，也没有任何东西和动画抢。
	 *
	 * 直接以「编辑」打开也要等。从前它立刻解码，正是这一点让没解码的画布在飞行途中被量到。现在画布只是盖在
	 * 图上的一层，在有东西可画之前一直藏着，等一下看不出任何代价。
	 */
	const [decodable, setDecodable] = useState(false);
	const annotator = useAnnotator(decodable ? (image?.src ?? "") : "");
	/** 缩放控件：标注工具条不管被放到哪，都要躲开它。 */
	const zoomPill = useRef<HTMLDivElement>(null);
	const bar = useMovableBar(zoomPill);

	const resetView = useCallback(() => setView({ zoom: 1, offset: CENTRED }), []);

	useLayoutEffect(() => {
		if (!state) return;
		setHeld(state);
		setLeaving(false);
		if (state.startEditing) setEditing(true);
		if (state.origin) origin.current = state.origin;
		if (state.source) source.current = state.source;
	}, [state]);

	/*
	 * 图在别处的这段时间，缩略图让开。
	 *
	 * 不这样的话，飞行就是缩略图的一份副本从缩略图上飞走，读起来是两个东西，而不是一个东西被拿起来——回去时
	 * 图片缩到一张本来就在那里的缩略图上，最后一帧是两个东西合成一个的那一刻。用 `visibility` 而不是
	 * `display`：布局不能动，否则这段飞行要去的那个矩形就不再是图片要去的地方。
	 */
	useLayoutEffect(() => {
		const thumbnail = shown ? source.current : null;
		if (!thumbnail) return;
		thumbnail.style.visibility = "hidden";
		return () => {
			thumbnail.style.visibility = "";
		};
	}, [shown]);

	// 换一张图就是换一个要看的东西；它以自己的尺寸到来。
	const src = image?.src;
	useEffect(() => {
		resetView();
	}, [src, resetView]);

	useEffect(() => {
		if (!shown) {
			setDecodable(false);
			return;
		}
		const timer = window.setTimeout(() => setDecodable(true), DURATION + 80);
		return () => window.clearTimeout(timer);
	}, [shown, src]);

	/*
	 * 看这一张的时候，把左右两张先取来。
	 *
	 * 翻页是在已经在屏幕上的元素上换 `src`，没解码的邻居在滑动中间会显示成一个空框。现在就要它们，换的那一下
	 * 就是即时的——它们大多已经作为 data URL 在内存里，只花一次解码，不走网络。
	 */
	useEffect(() => {
		if (!shown || shown.images.length < 2) return;
		for (const delta of [1, -1]) {
			const next = shown.images[(shown.index + delta + shown.images.length) % shown.images.length];
			if (next) new Image().src = next.src;
		}
	}, [shown]);

	/*
	 * 关了就是关了，不管是怎么关的。
	 *
	 * `dismiss` 走的时候会收拾干净，可 store 能从任何地方被关掉——应用的别处，或者一个根本不经过这里的快捷键。
	 * 这时有两样东西要放手。
	 *
	 * 一是编辑模式，否则下一张图到来时标注器已经盖在一张没人要标注的图上。二是 `held`，那份为了让关闭动画有
	 * 东西可缩而留着的副本：只有 `dismiss` 会清它，于是从别处关闭，浮层就留在屏幕上，显示一张 store 已经没有
	 * 的图。这还让标注器的源图不变，连带上一次的每一个标记——重新打开同一张图，把已经放弃的标注又带了回来。
	 *
	 * 三是起飞的那张缩略图和它的位置：留着的话，下一次不带起点打开（插件的 `ui.openImage`）会把一张不相干的旧缩略图藏起来，
	 * 关的时候还飞回它那里。回程在 `dismiss` 开始时就量好了，这里清掉不影响它。
	 *
	 * `leaving` 时不清 `held`：那是 `dismiss` 有意地、慢慢地在做这件事。
	 */
	useEffect(() => {
		if (state) return;
		origin.current = null;
		source.current = null;
		setEditing(false);
		// 飞到一半的翻页另有一张图在它自己的层上；关闭得把它一起带走，否则它被留在应用上方，没人持有它。
		window.clearTimeout(sliding.current);
		setTransit(null);
		if (!leaving) setHeld(null);
	}, [state, leaving]);

	/*
	 * 飞出来这一段用 Web Animation，不用过渡。
	 *
	 * 过渡要先写起点、强制一次重排、再写终点，顺序不能错、也不能放在别处——而且测量必须落在盒子已经停稳的
	 * 那一帧。这两点在不同时候都丢过：有一次清掉行内的 transition，图片到达时根本没有飞行；还有一次在「编辑」
	 * 把图换成没解码的画布之后才量，飞行从缩略图的 2.8 倍开始。`animate()` 一次收两端，不用重排，结束后也不在
	 * 元素上留下任何东西。
	 *
	 * 按 `state` 触发，并且只对带起点的状态：那才是从缩略图的到达。翻到下一张没有起点，那是滑动的事，不是飞行；
	 * 从前它会带着还记着的第一张缩略图重跑一遍，让新图从那里飞出来。
	 */
	useLayoutEffect(() => {
		const el = figure.current;
		if (!el || !state?.origin) return;
		// 一段还把上一张图停在它缩略图上的退出动画，会比这段飞行活得更久。
		for (const running of el.getAnimations()) running.cancel();
		const thumb = thumbOf(source.current, state.origin);
		const to = el.getBoundingClientRect();
		if (!thumb || to.width === 0 || to.height === 0) return;
		el.animate([atThumbnail(thumb, to), atRest(restingRadius(el))], { duration: DURATION, easing: EASE });
	}, [state]);

	/**
	 * 翻到下一张，一次移动里两张图都在。
	 *
	 * 先前的版本是在同一个位置淡出一张、淡入下一张——读起来是图被*替换*了，而不是沿着一排往前走，也完全没有
	 * 方向感。这里它们一起走：正在看的那张朝它要去的那一侧离开，下一张从对面的边进来，整整 300ms 两张都在屏幕
	 * 上，中间隔着一道空。走过一排照片时，照片就是这样动的。
	 *
	 * 离开的那张 `fixed` 在窗口中间，而不是放在 figure 里：figure 的尺寸跟着当前那张图走——索引一变它就缩放成
	 * 新图的形状，放在它里面的任何东西都会跳。两个各自居中的层可以是不同的形状，仍然干净地擦肩而过。
	 */
	const step = useCallback(
		(delta: number) => {
			if (leaving || !shown) return;
			const parting = shown.images[shown.index];
			if (!parting || shown.images.length < 2) return;

			/*
			 * 远到每张图停下之前都已经离开视野。
			 *
			 * 按屏幕上的图来量而不是写死，这样一张窄长的竖图不用走它自己三倍宽才离开，一张宽图也不会还看得见就停了。
			 */
			const span = (figure.current?.getBoundingClientRect().width ?? window.innerWidth * 0.5) + SLIDE_GAP;

			// 翻到一半再按一下，从这一下走到的地方开始新的一次，而不是排在它后面——按住方向键应该是一路翻过去，不是一顿一顿。
			window.clearTimeout(sliding.current);
			setTransit({ parting, dir: delta, span, phase: "start" });
			stepViewer(delta);
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					setTransit((current) => (current ? { ...current, phase: "run" } : null));
					sliding.current = window.setTimeout(() => setTransit(null), SLIDE_MS);
				}),
			);
		},
		[leaving, shown],
	);

	useEffect(() => () => window.clearTimeout(sliding.current), []);

	/*
	 * 回去的路。
	 *
	 * 落地之前不动模式。从前先退出「标注」，点下去的那一刻工具条就卸载了，看图器自己的按钮在淡出期间又出现在
	 * 角上——退出的路上，一条工具条消失、三个按钮冒出来。现在不是图片的东西一起淡出，图片保持它当时的样子。
	 *
	 * 它一路都是实的。从前它会淡到 0.35，去配飞出来时那个 0.4 的起点，在浅色的对话里读起来是一张褪了色的副本在
	 * 缩略图上停了好几帧，等缩略图回来再猛地变实。`atThumbnail` 的裁切让最后一帧正好就是缩略图，没有什么需要藏。
	 */
	const dismiss = useCallback(() => {
		if (leaving) return;
		setLeaving(true);
		// 只有当前那张飞回它的缩略图；还在滑过去的那张没有自己的缩略图可回，直接走掉。
		window.clearTimeout(sliding.current);
		setTransit(null);
		// 退出时取消缩放，图片沿一条路缩回缩略图，而不是从一个布局盒子一无所知的尺寸起飞。
		resetView();

		const leavingState = latest.current;
		let landed = false;
		const land = () => {
			if (landed) return;
			landed = true;
			// 它在回家的路上时又打开了别的；那一个留着。
			if (latest.current && latest.current !== leavingState) return;
			setHeld(null);
			setLeaving(false);
			setEditing(false);
			origin.current = null;
			source.current = null;
			closeViewer();
		};

		const el = figure.current;
		const thumb = thumbOf(source.current, origin.current);
		if (el && thumb) {
			/*
			 * 从它此刻所在的地方出发。还在到达途中就被关掉，图片在原地掉头，而不是先跳到中间：先读出正在跑的
			 * 那段飞行，再把它丢掉。
			 */
			const now = getComputedStyle(el);
			const from: FlightKeyframe = {
				transform: now.transform,
				clipPath: now.clipPath === "none" ? atRest(restingRadius(el)).clipPath : now.clipPath,
			};
			for (const running of el.getAnimations()) running.cancel();
			const to = el.getBoundingClientRect();
			if (to.width > 0 && to.height > 0) {
				const back = el.animate([from, atThumbnail(thumb, to)], { duration: DURATION, easing: EASE, fill: "forwards" });
				back.onfinish = land;
			}
		}
		// 动画自己的结束才是信号；这里只兜住那种根本没跑起来的。
		window.setTimeout(land, DURATION + 120);
	}, [leaving, resetView]);

	/**
	 * 围绕屏幕上的一个点缩放，让它底下的东西不动。
	 *
	 * 测量在外面做，算术在 updater 里做，所以这个函数什么都不依赖，滚轮转得比 React 渲染还快时也能正确叠加——
	 * 每一格看到的是上一格算出的状态，而不是声明它时的那个。
	 */
	const zoomTo = useCallback((next: number, anchor?: Point) => {
		const box = figure.current?.getBoundingClientRect();
		if (!box) {
			setView((v) => ({ ...v, zoom: clampZoom(next) }));
			return;
		}
		const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
		setView((v) => zoomAt(v.zoom, next, v.offset, anchor ?? centre, centre));
	}, []);

	useEffect(() => {
		if (!shown) return;
		const typingIn = (node: EventTarget | null) => node instanceof HTMLElement && (node.tagName === "INPUT" || node.tagName === "TEXTAREA");

		const onKey = (event: KeyboardEvent) => {
			if (typingIn(event.target)) return;
			// 按住空格是平移，所以它不能同时滚动页面或按下有焦点的东西。
			if (event.code === "Space") {
				event.preventDefault();
				setSpacing(true);
				return;
			}
			/*
			 * Esc 一次只退一层。
			 *
			 * 先是选中，再是标注，最后是看图器。因为选中了什么就把整个关掉，是为了回答一个小得多的问题扔掉了手上的
			 * 活，而那样之后就没有回头路了。
			 */
			if (event.key === "Escape") {
				if (editing && annotator.selected !== null) annotator.setSelected(null);
				else if (editing) setEditing(false);
				else dismiss();
				return;
			}
			if (editing) return;
			if (event.key === "ArrowLeft") step(-1);
			if (event.key === "ArrowRight") step(1);
		};
		const onUp = (event: KeyboardEvent) => {
			if (event.code === "Space") setSpacing(false);
		};
		// 按着空格时窗口失去焦点，不处理的话它就一直卡在按下。
		const release = () => setSpacing(false);

		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onUp);
		window.addEventListener("blur", release);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("keyup", onUp);
			window.removeEventListener("blur", release);
		};
	}, [shown, editing, dismiss, annotator, step]);

	/*
	 * 系统画在页面之外的窗口按钮，遮罩够不着，所以跟着它一起压暗——遮罩开始淡出时它们也跟着变亮。见 `scrims.ts`。
	 */
	useEffect(() => (shown && !leaving ? holdScrim("#000000", BACKDROP_ALPHA) : undefined), [shown, leaving]);

	if (!shown || !image) return null;

	const open = !leaving;
	// 拖动只在不可能有别的意思时才是平移：不在编辑，或按着空格。否则在画布上拖就是画一笔，这才对。
	const canPan = spacing || (!editing && zoom > 1);

	/*
	 * 翻页途中两张图各在哪。
	 *
	 * 往下一张时 `dir` 是 +1，正在看的那张往左走，接替它的从右边进来——在一排图前往前走时，图就是这么动的。
	 * 在 `start` 那一帧，进来的那张停在边外，什么都没有过渡；到 `run` 两张都有过渡，一起走。
	 */
	const enteringX = transit?.phase === "start" ? transit.dir * transit.span : 0;
	const partingX = transit?.phase === "run" ? -transit.dir * transit.span : 0;
	const SLIDE = `transform ${SLIDE_MS}ms ${EASE}`;

	const startPan = (event: React.PointerEvent) => {
		if (!canPan || event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		grab.current = { x: event.clientX, y: event.clientY, from: offset };
		setPanning(true);
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const movePan = (event: React.PointerEvent) => {
		const from = grab.current;
		if (!from) return;
		setView((v) => ({
			...v,
			offset: { x: from.from.x + (event.clientX - from.x), y: from.from.y + (event.clientY - from.y) },
		}));
	};

	const endPan = () => {
		grab.current = null;
		setPanning(false);
	};

	return portal(
		<div
			role="dialog"
			aria-modal
			aria-label={t("viewer.title")}
			/*
			 * 整个浮层都是 `no-drag`。
			 *
			 * 窗口顶上那一行是拖动区，拖动区会在页面看到按下之前就把它交给窗口管理器。这层浮层盖住整个窗口，它的
			 * 控件就落在那一条里——画出来了、在最上面、页面能做的每一次命中测试都通过，却什么都不干：按一下，窗口
			 * 跟着挪。
			 *
			 * 整层而不是每个按钮：模态开着的时候，后面本来就没有东西可以拿来拖窗口。它一关，拖动就恢复。
			 */
			className="[app-region:no-drag] fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
			onWheel={(event) => {
				// 触控板捏合是一次按着 ctrlKey 的滚轮；两种手势在这里是一个意思，灵敏度不同——而 Ctrl+滚轮看起来像捏合。
				// 一次事件为什么有上限，见 `wheelZoomFactor`。
				zoomTo(zoom * wheelZoomFactor(event.deltaY, event.ctrlKey), { x: event.clientX, y: event.clientY });
			}}
		>
			{/*
			 * 遮罩是一个按钮，而不是挂了处理函数的 div：点外面关闭是一个真实的动作，给它一个真实的控件，键盘才够得
			 * 着，读屏才会说它是能按的。
			 */}
			<button
				type="button"
				aria-label={t("viewer.close")}
				tabIndex={-1}
				onClick={dismiss}
				/*
				 * 透明度写成类名、带起始样式，而不是行内。
				 *
				 * 行内的话它从遮罩的第一帧起就是 `1`，点下去窗口立刻暗了 72%，退出时倒是有淡出——过渡只会从一个画过的
				 * 值开始，而刚挂上的元素一个都没有。`starting:` 给了它一个，行内的透明度会压过它。
				 */
				className={`absolute inset-0 cursor-default bg-shade/72 starting:opacity-0 ${open ? "opacity-100" : "opacity-0"}`}
				style={{ transition: FADE }}
			/>

			{/*
			 * 被留下的那张图，在它自己的层上。
			 *
			 * `fixed` 并在窗口里居中，而不是放在 figure 里：figure 的尺寸跟着*当前*那张图走，而翻页一开始索引就变了
			 * ——放在它里面的任何东西都会按新图的形状重新排版，正该滑过去的那一刻往旁边一跳。两个各自居中的层可以是
			 * 不同的形状，仍然干净地擦肩而过。
			 *
			 * 层叠次序在当前那张图下面，也不接任何点击：它正在离开，不该接住给到来的那张的点击。
			 */}
			{transit && (
				<img
					key={transit.parting.src}
					src={transit.parting.src}
					alt=""
					aria-hidden
					draggable={false}
					className={`${STAGE_FIT} pointer-events-none fixed rounded-xl object-contain`}
					style={{
						left: "50%",
						top: "50%",
						transform: `translate(-50%, -50%) translateX(${partingX}px)`,
						transition: transit.phase === "start" ? "none" : SLIDE,
						willChange: "transform",
					}}
				/>
			)}

			<div
				ref={figure}
				className="relative"
				style={{
					transformOrigin: "center",
					/*
					 * 在屏幕上的整段时间都是它自己的合成层。
					 *
					 * 把一张截图从缩略图放到全尺寸，不提升图层的话每一帧都要重画；动画开始的那一刻才提升，头几帧就花在
					 * 提升上——卡顿正出在那里。声明而不是切换，因为这个元素只在看图器开着时存在。
					 */
					willChange: "transform",
				}}
			>
				<div
					onPointerDown={startPan}
					onPointerMove={movePan}
					onPointerUp={endPan}
					onPointerCancel={endPan}
					onDoubleClick={() => (zoom === 1 ? zoomTo(2) : resetView())}
					className={`relative ${canPan ? (panning ? "cursor-grabbing" : "cursor-grab") : ""}`}
					style={{
						/*
						 * 平移、缩放和翻页的到达，在一个 transform 里。
						 *
						 * 翻页时这张图有一帧停在远边，然后被放回中间；它要替换的那张在下面它自己的层上往反方向走。
						 */
						transform: `translate(${offset.x + enteringX}px, ${offset.y}px) scale(${zoom})`,
						transformOrigin: "center",
						/*
						 * 拖动时不要过渡——那会追到指针片刻之前的位置——停在边外的那一帧也不要，否则它会从上一张刚好
						 * 离开的地方滑进来。
						 */
						transition: panning || transit?.phase === "start" ? "none" : transit ? SLIDE : FLIGHT,
						willChange: "transform",
					}}
				>
					<img
						src={image.src}
						alt={image.alt ?? ""}
						draggable={false}
						/*
						 * 两种模式下都在：盒子就是它。见文件头。
						 *
						 * 不加阴影。72% 黑的遮罩上一道黑影读不出深度，读起来是第一道边外几个像素处又一道模糊的边。
						 */
						className={`${STAGE_FIT} block rounded-xl object-contain`}
					/>
					{/*
					 * 标记，在正好盖住图片的一层上。
					 *
					 * 尺寸取自下面的图而不是它自己的位图，所以它永远挪不动那个盒子；位图解码、画好之前藏着，因为在那之前
					 * 画布是 300×150 的空白；退出时和其他东西一起淡出，标注到一半被放弃的图落在缩略图上时就是缩略图本身。
					 */}
					{editing && (
						<div className="absolute inset-0" style={{ visibility: annotator.ready ? "visible" : "hidden", opacity: leaving ? 0 : 1, transition: FADE }}>
							{/* 两个方向都取自图片的盒子：画布自己的像素已经和图片的对不上了。 */}
							<AnnotateCanvas annotator={annotator} zoom={zoom} className="h-full w-full rounded-xl" />
						</div>
					)}
				</div>
			</div>

			{/* 控件和遮罩一起从无淡入——为什么是类名，见遮罩。 */}
			<div className={`pointer-events-none absolute inset-0 starting:opacity-0 ${open ? "opacity-100" : "opacity-0"}`} style={{ transition: FADE }}>
				{!editing && (
					<div className="pointer-events-auto absolute top-4 right-4 flex items-center gap-1">
						{/* 每张图都有：不能替换的图照样能标注、留一份，标注已经发出去的东西更常见的就是这个理由。 */}
						<ViewerButton label={t("viewer.annotate")} onClick={() => setEditing(true)}>
							<Pencil size={15} strokeWidth={1.9} />
						</ViewerButton>
						<ViewerButton label={t("viewer.copy")} onClick={() => void copyImage(image.src)}>
							<Copy size={15} strokeWidth={1.9} />
						</ViewerButton>
						<ViewerButton label={t("viewer.saveAs")} onClick={() => void saveImage(image.src)}>
							<Download size={15} strokeWidth={1.9} />
						</ViewerButton>
						<ViewerButton label={t("viewer.closeEsc")} onClick={dismiss}>
							<X size={16} strokeWidth={1.9} />
						</ViewerButton>
					</div>
				)}

				{/*
				 * 左下角，避开中间的标注工具条。两种模式下都在：为了精确放一个标记而放大，和为了看清一个标记而放大，
				 * 是同一种需要。
				 *
				 * 和标注工具条一样高，它们共用这条边：50pt 的工具条旁边一个 38pt 的胶囊，读起来是两家控件，小的那个像
				 * 是后来补上的。
				 */}
				<div
					ref={zoomPill}
					data-plume-viewer-zoom=""
					className="pointer-events-auto absolute bottom-3 left-6 flex items-center gap-1 rounded-2xl border plume-image-glass px-2 py-1.5 shadow-overlay backdrop-blur-xl"
				>
					<ViewerButton label={t("viewer.zoomOut")} pill disabled={zoom <= ZOOM_MIN} onClick={() => zoomTo(zoom / ZOOM_STEP)}>
						<Minus size={16} strokeWidth={2} />
					</ViewerButton>
					<button
						type="button"
						data-plume-tip={t("viewer.actualSize")}
						data-plume-tip-side="top"
						aria-label={t("viewer.zoomIs", { percent: Math.round(zoom * 100) })}
						onClick={resetView}
						className="plume-image-reading h-9 min-w-[54px] rounded-lg px-1.5 text-center text-label tabular-nums transition-colors duration-[var(--plume-t-quick)]"
					>
						{Math.round(zoom * 100)}%
					</button>
					<ViewerButton label={t("viewer.zoomIn")} pill disabled={zoom >= ZOOM_MAX} onClick={() => zoomTo(zoom * ZOOM_STEP)}>
						<Plus size={16} strokeWidth={2} />
					</ViewerButton>
					<ViewerButton label={t("viewer.fit")} pill onClick={resetView}>
						<Maximize2 size={15} strokeWidth={2} />
					</ViewerButton>
				</div>

				{shown.images.length > 1 && !editing && (
					<>
						<div className="pointer-events-auto absolute top-1/2 left-4 -translate-y-1/2">
							<ViewerButton label={t("viewer.prev")} onClick={() => step(-1)}>
								<ChevronLeft size={18} strokeWidth={1.9} />
							</ViewerButton>
						</div>
						<div className="pointer-events-auto absolute top-1/2 right-4 -translate-y-1/2">
							<ViewerButton label={t("viewer.next")} onClick={() => step(1)}>
								<ChevronRight size={18} strokeWidth={1.9} />
							</ViewerButton>
						</div>
						<div className="plume-image-count absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-shade/45 px-2.5 py-1 text-detail tabular-nums">
							{shown.index + 1} / {shown.images.length}
						</div>
					</>
				)}
			</div>

			{editing && (
				/*
				 * 由它自己的一个 fixed 盒子托着、按窗口坐标摆放，所以能拖到窗口里任何地方——见 `useMovableBar`，它在
				 * 落定时也会缓动到位，于是松手在缩放控件上的工具条会自己滑开。
				 */
				<div ref={bar.measure} data-annotate-bar="" className="pointer-events-none fixed z-[120]" style={bar.style}>
					<AnnotateToolbar
						annotator={annotator}
						onGrab={bar.startDrag}
						grabbing={bar.dragging}
						canReplace={Boolean(image.onReplace)}
						delivers={!image.onReplace && Boolean(image.onAttach)}
						/*
						 * 不加标注就交出去是一个真实的请求——「照这张再来一张」——但要等画布里有了图：没解码的画布读回来是一张
						 * 空白的 300×150 PNG。没准备好、因而也不算改过，按钮像别的时候一样等着。
						 */
						requireDirty={Boolean(image.onReplace) || !image.onAttach || !annotator.ready}
						// 退出时和其他东西一起淡出；到达时工具条自己淡入。
						style={leaving ? { opacity: 0, pointerEvents: "none" } : undefined}
						onCancel={() => setEditing(false)}
						onSave={() => {
							/*
							 * 能替换就替换，要交出去就交出去，否则复制。
							 *
							 * 已经发出去的图是记录的一部分，原地改写它就改了说过的话。对话里的图交给那个对话的输入框，因为人拿
							 * 一张标注过的图接下来要做的，就是请它照着标记重画一遍。其他的进剪贴板，那是标注截图最常见的下一步。
							 */
							const save = () => {
								const dataUrl = annotator.render();
								if (!dataUrl) {
									notifyExportFailed();
									return;
								}
								if (image.onReplace) {
									image.onReplace(dataUrl);
									void copyImage(dataUrl);
								} else if (image.onAttach) {
									image.onAttach(dataUrl);
								} else {
									void copyImage(dataUrl);
								}
								dismiss();
							};
							/*
							 * 正在写的文字先提交，再给画布一帧去画上它。
							 *
							 * 工具条从不夺焦点——正是这一点让你能改正在写的文字的大小——所以光标还在文字里时按保存，从前得到的
							 * 副本没有那段文字。`render()` 读的是画布，重画的 effect 跑完之前，那段文字只在画布上方的一个
							 * `<textarea>` 里。
							 */
							if (annotator.flushText()) requestAnimationFrame(() => requestAnimationFrame(save));
							else save();
						}}
					/>
				</div>
			)}
		</div>,
	);
}

function ViewerButton({
	label,
	onClick,
	disabled,
	pill,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	/** 在缩放胶囊里，胶囊就是它的底：自己不带底色，用胶囊的高度。 */
	pill?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-plume-tip={label}
			data-plume-tip-side="top"
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className={`plume-image-control flex items-center justify-center rounded-lg transition-colors duration-[var(--plume-t-quick)] disabled:opacity-30 ${
				pill ? "plume-image-pill h-9 w-9" : "h-8 w-8 bg-shade/45 hover:bg-shade/65"
			}`}
		>
			{children}
		</button>
	);
}

/**
 * 缩略图此刻在屏幕上的样子：图片画在里面的那一块，以及它的圆角。
 *
 * 从元素上读，而不是用点击时记下的矩形，因为回去可能是几分钟之后——下面流式进来的回复会滚动对话，一张飞回
 * 缩略图*原来*位置的图，会落在那里现在的东西上。记下的矩形只给缩略图已经不在了的情况兜底。
 *
 * 取里面的图片而不是被点的元素：一张图可能放在一个和面板一样宽的按钮里，从按钮起飞的话，图片一开始就比屏幕
 * 上出现过的任何东西都宽。
 */
function thumbOf(element: HTMLElement | null, recorded: DOMRect | null): Thumb | null {
	if (element?.isConnected) {
		const frame = element.getBoundingClientRect();
		const img = element instanceof HTMLImageElement ? element : element.querySelector("img");
		let box: Box = frame;
		let radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
		if (img) {
			const style = getComputedStyle(img);
			box = intersect(paintedBox(img.getBoundingClientRect(), { width: img.naturalWidth, height: img.naturalHeight }, style.objectFit), frame);
			radius = Math.max(radius, parseFloat(style.borderTopLeftRadius) || 0);
		}
		if (box.width > 0 && box.height > 0) return { box, radius };
	}
	return recorded && recorded.width > 0 && recorded.height > 0 ? { box: recorded, radius: 0 } : null;
}

/** 图片停在看图器里时的圆角——`<img>` 自己的，飞行就落在它上面。 */
function restingRadius(figure: HTMLElement): number {
	const img = figure.querySelector("img");
	return img ? parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0 : 0;
}

function intersect(a: Box, b: Box): Box {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
