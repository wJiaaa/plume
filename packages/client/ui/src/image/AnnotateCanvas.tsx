/**
 * 画布：把标记画出来，以及把指针动作翻译成标记。
 *
 * 从 `Annotator.tsx` 拆出来的第二块。标记是一张形状清单，每帧从清单重画，而不是随手落笔累积
 * 到画布上——那是撤销/重做能成为清单上的一个游标而不是一叠位图的原因，也是撤掉一个步骤徽章之后
 * 其余的会自己重新编号的原因，还是「正在拖的那个矩形」能实时显示的原因：预览和提交走的是同一段
 * 代码，清单加一个临时项而已。
 *
 * 标记存在图片的**原始**像素里；画布的像素数则按它在屏幕上的样子来（见 `backingScale`），不再
 * 等于原图。指针坐标进来时经 `getBoundingClientRect` 换算，那个方法已经把上层舞台的缩放算进去了
 * ——所以在 400% 下画，落点仍然在指针处。缩放在这里只用来定两件事：画布该有多少像素才清楚，以及
 * 选中框、手柄这些「编辑用的东西」该缩回多少才不跟着图一起变大。
 *
 * 工具条为什么不在这里：`AnnotateToolbar.tsx` 的文件头写着。
 */

import type { MessageKey } from "../i18n/messages/index.ts";
import { translate } from "../i18n/translate.ts";
import { Textarea } from "../inputs/NativeField.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	badgeAt,
	commit,
	constrainEnd,
	current,
	handlesOf,
	hitShape,
	hitShapes,
	insideBounds,
	mosaicBrush,
	moveShape,
	pickTolerance,
	resizeShape,
	shapeBounds,
	strokeAt,
	typeAt,
	WIDTH_HANDLE,
	type Point,
	type Shape,
	type Tool,
} from "./annotate.ts";
import { fontOf, paintAll, LINE, PAD } from "./paint.ts";
import type { Annotator } from "./Annotator.tsx";

/**
 * 空的文字框里写着什么，也就决定了空的文字框至少要多宽。
 *
 * 做成常量是因为两处要用，而且不能各说各的：输入框把它显示出来，`fitWidth` 量它来决定空框有多宽。
 * 两处各写一遍的话，改一次措辞就会悄悄地重新出现一个连自己的占位字都装不下的框——之前正是这么坏的：
 * 下限是按字数猜的，占位字是四个字，猜的是 1.6。
 *
 * 存的是 key：这个模块加载的时候，界面语言还没定下来。
 */
const PLACEHOLDER: MessageKey = "annotate.textPlaceholder";

/** 一段正在输入、还没变成形状的文字在哪，单位是原始像素。 */
interface Typing {
	at: Point;
	value: string;
	/** 它折行的栏宽，由边上的把手拖出来。 */
	width: number;
	/**
	 * 栏宽是不是手动定的。
	 *
	 * 没定之前，框跟着字走：一开始很小，边打边长，这正是一条标注想要的——以前每个文字框一打开就是
	 * 图片宽度的 30%，两个词的说明落在一个比它指着的东西还宽的框里，想让它合身只能每次都去拖把手。
	 * 一旦拖过，那就是一条指令，框不再自作主张。
	 */
	manual?: boolean;
	/**
	 * 正在编辑一条已有的文字、而不是新写一条时，它替换的是哪一条。编辑期间那一条不参与绘制，
	 * 免得画两遍。
	 */
	replacing?: number;
	/**
	 * 左边缘本来要落在哪。在图片右边缘附近开始写的文字，会像右对齐的文字那样边写边往左长，
	 * 删字时再退回来；这里记的就是退回到哪。以前它是在剩下的那点地方折行——在边上开头的一句话，
	 * 出来是四个字宽、六行高。
	 */
	anchor?: number;
}

/** 正在拖的一个标记：哪一个、从哪儿开始拖、拖到了哪儿。 */
interface Dragging {
	index: number;
	from: Point;
	moving: Shape;
	/** 拽的是哪个手柄；整个标记在挪时是 null。 */
	handle: number | null;
	/**
	 * 按下去的时候，它是不是已经被选中了。
	 *
	 * 在已经选中的东西上按一下、没挪就松开，是「点一下选中，再点一下编辑」的第二下——
	 * 和文件管理器里重命名是同一个手势。
	 */
	wasSelected: boolean;
	/**
	 * 它是不是真的挪动过。
	 *
	 * 一次选中的点击是一次长度为零的拖拽，把它提交进去，就会在历史里放一步什么都没改的记录——
	 * 撤销要按两次才看得出有用。
	 */
	moved: boolean;
}

/**
 * 画完就值得立刻选中的标记。
 *
 * 除了两种自由笔画以外的全部。一个矩形几乎从来不是一次就画对的，画完直接带着手柄交回来，
 * 省掉的正是这一整套安排想去掉的「先去切选择工具」那一趟。画笔则不同：通常是连着画好几笔，
 * 每一笔都选中的话，每画一下就多一个框。
 */
const SELECT_ON_DRAW = new Set<Tool>(["rect", "ellipse", "line", "arrow", "step"]);

/** 和看图器的 `<img>` 共用，进入编辑时图不会差一个像素。 */
export const STAGE_FIT = "max-h-[86vh] max-w-[86vw]";

/** 短于这个距离（屏幕点）的拖拽，是手抖了一下的点击，不是一个形状。 */
const MIN_DRAG = 4;

/** 不管缩放到多少，一块画布最多给这么多像素：4096²，64MB。 */
const MAX_BACKING = 4096 * 4096;

/**
 * 每个图片像素给多少画布像素，标记才和屏幕一样清楚。
 *
 * 画布以前正好是图片那么多像素，再由 CSS 拉伸。截图是按一个图片像素对一个设备像素显示的，所以这对
 * 截图浮层是对的，对别处都不对：一张 1408px 的画，放进 1100 点宽的窗口，在 Retina 屏上是 2200 个
 * 设备像素宽，上面每一条线、每个箭头、每段文字都是一张 1408px 的画放大 1.56 倍——本该锐利的东西
 * 边缘发虚，每放大一档就更糊。
 *
 * 不少于图片自己的像素（保存出去的就是那么多，缩小显示时本来就清楚），不多于 `MAX_BACKING`，
 * 按八分之一取整，免得捏合的每一个事件都重新分配画布。低于 1.05 就是 1：截图正好按它自己的像素画，
 * 因为截图浮层要保存的图是直接从这块画布上裁出来的。
 */
function backingScale(css: number, dpr: number, zoom: number, width: number, height: number): number {
	if (css <= 0 || width <= 0 || height <= 0) return 1;
	const wanted = Math.min((css * dpr * zoom) / width, Math.sqrt(MAX_BACKING / (width * height)));
	return wanted < 1.05 ? 1 : Math.ceil(wanted * 8) / 8;
}

const CURSOR: Partial<Record<Tool, string>> = {
	text: "cursor-text",
	step: "cursor-copy",
	/*
	 * 马赛克把指针藏起来，自己画一个。
	 *
	 * 下笔之前最需要知道的就是这一笔会盖住多大一片——打码这件事，没人想事后才发现盖窄了——而系统
	 * 光标说不出这个。下面那个圈就是答案，按笔刷的真实大小画；旁边再有个系统光标，只是多一样要看的东西。
	 */
	mosaic: "cursor-none",
};

/**
 * @param className 替换画布自己的尺寸和外框，给需要把它摆得分毫不差的调用方。看图器要 `STAGE_FIT`
 *   ——按图片自己的像素定大小、以窗口为上限；截图浮层要的正相反，一块钉在它已经选好的矩形上的画布。
 *   不传的话画布按位图尺寸以 CSS 像素排版，在 Retina 屏上是它该盖住的区域的两倍。
 */
export function AnnotateCanvas({ annotator, zoom, className, style }: { annotator: Annotator; zoom: number; className?: string; style?: React.CSSProperties }) {
	const { canvas, image, mosaicSourceFor, ready, width, tool, colour, backdrop, weight, shapes, setHistory, selected, setSelected, colorSpace, unit, setUnit } =
		annotator;
	const [drawing, setDrawing] = useState<Shape | null>(null);
	const [typing, setTyping] = useState<Typing | null>(null);
	const [dragging, setDragging] = useState<Dragging | null>(null);
	const [hovering, setHovering] = useState<"move" | "point" | "width" | null>(null);
	/** 马赛克的圈在哪，单位是图片像素；指针不在画布上时是 null。 */
	const [brushAt, setBrushAt] = useState<Point | null>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const sizing = useRef<{ x: number; from: number; scale: number } | null>(null);
	const carrying = useRef<{ x: number; y: number; from: Point; scale: number } | null>(null);

	/** 画布排版后的宽度（CSS 像素），一直盯着，而不是只读一次。 */
	const [cssWidth, setCssWidth] = useState(0);
	const observer = useRef<ResizeObserver | null>(null);
	/** 每个 CSS 像素对多少设备像素；窗口挪到另一块屏幕上时会变。 */
	const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
	useEffect(() => {
		let media: MediaQueryList | null = null;
		const watch = () => {
			setDpr(window.devicePixelRatio || 1);
			media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
			media.addEventListener("change", watch, { once: true });
		};
		watch();
		return () => media?.removeEventListener("change", watch);
	}, []);

	/*
	 * 图片像素 → 显示像素，按图片适配后的大小算。
	 *
	 * 声明在这么靠上，是因为 `commitText` 闭包里用到它：`useCallback` 的依赖数组在组件渲染时求值，
	 * 定义在更下面的 `const` 到那时还在暂时性死区里。按图片的宽度算，不按画布的：画布有屏幕需要的
	 * 那么多像素（`backingScale`），图片有它自己的。
	 */
	const laidOut = cssWidth || canvas.current?.clientWidth || 0;
	const display = laidOut > 0 && width > 0 ? laidOut / width : 1;
	/** 此刻看着的每个图片像素占多少屏幕点：按下去瞄准时用的就是这个。 */
	const scale = display * zoom;
	/** 编辑用的东西——外框、手柄——画在被缩放的舞台里面，再缩回去。 */
	const chrome = 1 / Math.max(zoom, 0.01);
	const height = image.current?.height ?? 0;
	const backing = backingScale(laidOut, dpr, zoom, width, height);

	// 现在画一个标记会拿到的尺寸，单位是图片像素：屏幕尺寸经 `unit` 换算过来。见 `strokeAt`。
	const stroke = strokeAt(unit, weight);
	const typeSize = typeAt(unit, weight);
	const badge = badgeAt(unit, weight);
	const brush = mosaicBrush(unit, weight);

	// 告诉 annotator 图片在屏幕上有多大，工具条上的尺寸才能按同样的方式落下去。
	useEffect(() => {
		if (laidOut <= 0 || width <= 0) return;
		const next = width / laidOut;
		if (Math.abs(next - unit) / unit > 0.005) setUnit(next);
	}, [laidOut, width, unit, setUnit]);

	/*
	 * 挂上时就定好尺寸，而不只是加载完才定，这就是不闪的原因。
	 *
	 * 没有 width 属性的画布是 300×150。以前进入编辑模式时挂上的就是这么大的一块，等图片解码完才改过来，
	 * 于是有一帧——有时好几帧——一个白色小方块顶替了图片。现在看图器在只是看图的时候就把图解码好放着，
	 * 所以这里挂上时原始尺寸已经知道了，可以在元素出现的同一刻用上。
	 */
	const attach = useCallback(
		(el: HTMLCanvasElement | null) => {
			canvas.current = el;
			observer.current?.disconnect();
			observer.current = null;
			if (!el) return;
			const img = image.current;
			if (img && el.width !== img.width) {
				el.width = img.width;
				el.height = img.height;
			}
			// 它在屏幕上多大，决定了它要多少像素，以及一个点合多少图片像素。
			setCssWidth(el.clientWidth);
			observer.current = new ResizeObserver(() => setCssWidth(el.clientWidth));
			observer.current.observe(el);
		},
		[canvas, image],
	);
	useEffect(() => () => observer.current?.disconnect(), []);

	/**
	 * 屏幕上实际有什么：已提交的标记，正在拖的那个画在它被拖到的地方，正在重新编辑的那个拿掉，
	 * 因为输入框正替它站着。
	 */
	const live = useMemo(() => {
		const list = shapes.map((shape, index) => (dragging?.index === index ? dragging.moving : shape)).filter((_, index) => index !== typing?.replacing);
		return drawing ? [...list, drawing] : list;
	}, [shapes, drawing, dragging, typing?.replacing]);

	/** 选中的标记此刻的样子；拖动期间它和已提交的不一样。 */
	const chosen = selected === null ? null : ((dragging?.index === selected ? dragging.moving : shapes[selected]) ?? null);
	const grips = chosen ? handlesOf(chosen) : [];
	/**
	 * 离手柄多近算按到了它，单位是图片像素——大约就是手柄看上去那么大。
	 *
	 * 以前按笔画粗细推出来再乘 1.8，在 Retina 截图上大约是 25 个图片像素，而那个点只画了 10。
	 * 一个比自己大两倍半的目标，会让标记没法稳稳地被*拿起来*：想按住矩形中间挪它，却被一个角
	 * 抢走了这一下，变成了缩放。按 `scale` 定，所以不管图片分辨率和缩放是多少，屏幕上都是同样
	 * 几个点——以前只按 `display`，于是在 400% 下手柄够到 36 点开外，想挪一个小框却把它缩放了。
	 */
	const gripReach = 9 / (scale || 1);

	/** 选中标记上、某一点底下的手柄，有的话——按下和光标都要问它。 */
	const gripAt = (point: Point) => grips.find((g) => Math.hypot(g.at.x - point.x, g.at.y - point.y) <= gripReach);

	/*
	 * 画布上只画要保存的东西。
	 *
	 * 选中框画在 DOM 里，就在下面几行，而不是画在这里。画在画布上的话 `toDataURL` 会把它一起带走，
	 * 而补救的办法——不带它重画一遍、取 URL、再带上它重画——是另一条渲染路径，存在的意义就是日后
	 * 被人忘掉。盖在画布上的元素进不了文件。
	 */
	useEffect(() => {
		const el = canvas.current;
		const img = image.current;
		if (!el || !img || !ready) return;
		// 屏幕显示它用多少像素就给多少；标记按图片像素经一层缩放画上去。
		const w = Math.max(1, Math.round(img.width * backing));
		const h = Math.max(1, Math.round(img.height * backing));
		if (el.width !== w || el.height !== h) {
			el.width = w;
			el.height = h;
		}
		/*
		 * 画布的色彩空间跟图片的一致，否则 `drawImage` 会替我们转一道。
		 *
		 * 第一次 `getContext` 决定了这块画布的色彩空间，之后再传别的参数没有用——所以这里传的必须
		 * 跟别处一致。截图那条路上它是显示器的空间，别处（看图、编辑本地文件）是 sRGB。
		 */
		const ctx = el.getContext("2d", { colorSpace });
		if (!ctx) return;

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, el.width, el.height);
		ctx.setTransform(w / img.width, 0, 0, h / img.height, 0, 0);
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(img.source, 0, 0);

		/*
		 * 这几个尺寸给没有自带尺寸的标记——正在拖出来的那一个，以及标记还不带自己尺寸之前画的
		 * 那些。其余的都按画下时的尺寸画；见 `paintAll`。
		 */
		paintAll(ctx, live, {
			stroke,
			mosaicSourceFor,
			block: annotator.block,
			brush,
		});
	}, [live, ready, stroke, brush, backing, canvas, image, mosaicSourceFor, annotator.block, colorSpace]);

	/**
	 * 刚好装下这段文字的栏宽，单位是图片像素。
	 *
	 * 用文字最终绘制时的同一种字体来量，所以用户打字的那个框，就是文字实际会有的形状。上限是图片的
	 * 大部分宽度，因为一整行不断开的中文没有天然的停顿处。
	 */
	const fitWidth = useCallback(
		(text: string): number => {
			/*
			 * 这里只量字，跟颜色无关——参数还是要跟别处一模一样。
			 *
			 * 一块画布的色彩空间由**第一次** `getContext` 定下，之后再传什么都会被忽略。如果用户先
			 * 点了文字工具、这一句先跑，画布就被定成了 sRGB，上面那处再传 display-p3 也无济于事：
			 * 整张截图从此偏色，而触发条件是「先打字还是先画别的」这种没人会联想到的顺序。
			 */
			const ctx = canvas.current?.getContext("2d", { colorSpace });
			const pad = typeSize * PAD * 2;
			if (!ctx) return typeSize * 8;
			ctx.font = fontOf(typeSize);
			const longest = text.split("\n").reduce((n, line) => Math.max(n, ctx.measureText(line).width), 0);
			/*
			 * 两个不同的问题，以前用一个数来回答。
			 *
			 * 最后一个字后面留多少空，和什么都没写的框有多宽，不是一回事——把它们当成一回事，正是先后
			 * 两次抱怨的来源。六个字的下限让占位字看得清，却让文字坐在一个比它宽得多的框里；把下限降到
			 * 1.6，文字是收紧了，四个字的占位字却被挤进了一个字宽的栏里。
			 *
			 * 所以：内边距就是 `PAD` 说的那么多，本来就是对称的——输入框四边一样多。让右边显得松的，是
			 * *之后*再加上的那份余量，因为文字左对齐，它全落在右边。光标只有一两个像素，用不着三分之一个字。
			 *
			 * 下限是量出来的，不是猜的：不管占位字恰好写的是什么，空框都宽到能把它放在一行里。
			 */
			const caret = Math.max(2, typeSize * 0.08);
			const floor = ctx.measureText(translate(PLACEHOLDER)).width + pad + caret;
			return Math.min(Math.max(longest + pad + caret, floor), Math.max(width * 0.9, floor));
		},
		[canvas, typeSize, width, colorSpace],
	);

	/**
	 * 没定过宽的文字，按它的字来定：和最长的一行一样宽，图片右边缘会切到它时从锚点往左挪，
	 * 挪不下了才折行。
	 */
	const fitTyping = useCallback(
		(entry: Typing, value: string): Typing => {
			if (entry.manual) return { ...entry, value };
			const wanted = fitWidth(value);
			const pad = typeSize * PAD;
			const left = Math.max(-pad, Math.min(entry.anchor ?? entry.at.x, width - wanted));
			return { ...entry, value, at: { ...entry.at, x: left }, width: Math.min(wanted, width - left) };
		},
		[fitWidth, typeSize, width],
	);

	// 写字时挑的尺寸立刻用到这段文字上，框跟着新尺寸走。
	useEffect(() => {
		setTyping((entry) => (entry && !entry.manual ? fitTyping(entry, entry.value) : entry));
	}, [fitTyping]);

	/** 输入框里现在打开的这段文字，是否已经让输入框拿过焦点。 */
	const entered = useRef(false);

	// 一出现就拿焦点，马上可以打字；每敲一个键都按内容长高，框永远正好和里面的东西一样高。
	useEffect(() => {
		const el = field.current;
		if (!el || !typing) {
			entered.current = false;
			return;
		}
		if (document.activeElement !== el) el.focus();

		/*
		 * 光标放到末尾，而且只在进来的时候放。
		 *
		 * 重新打开一段文字，几乎总是要往后补，或者改它的结尾；光标停在第零个字，每个新词都插到已有的
		 * 前面——想写「第一段改了」，出来的是「改了第一段」。只做一次，不在每次按键时做，因为这个
		 * effect 每敲一个字也会跑一遍，那时再挪光标，中间的字就没法改了。
		 */
		if (!entered.current) {
			entered.current = true;
			const end = el.value.length;
			el.setSelectionRange(end, end);
		}

		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [typing]);

	/** 显示坐标 → 图片像素，形状就存在那里。 */
	// 收任何带 client 坐标的东西，所以双击能和指针按下一样定位，两者都不用知道对方的事件类型。
	const at = useCallback(
		(event: { clientX: number; clientY: number }): Point => {
			const el = canvas.current;
			const img = image.current;
			if (!el || !img) return { x: 0, y: 0 };
			// 这个矩形已经包含了舞台的缩放变换，所以任何缩放下都是对的。用图片的像素，不用画布的：
			// 画布有屏幕需要的那么多。
			const box = el.getBoundingClientRect();
			return {
				x: ((event.clientX - box.left) / box.width) * img.width,
				y: ((event.clientY - box.top) / box.height) * img.height,
			};
		},
		[canvas, image],
	);

	/** 上一次提交的那段文字，所以同一段的第二次调用——按下之后跟着的那次失焦——什么也不做。 */
	const committed = useRef<Typing | null>(null);
	/*
	 * 两次普通调用，而不是一个套在状态更新函数里的调用。
	 *
	 * 写成 `setTyping(entry => { setHistory(...); return null })`，看上去是一种不用把当前项列进依赖
	 * 就能拿到它的办法，其实是错的：更新函数必须是状态的纯函数，因为 React 每次提交会调它不止一次——
	 * StrictMode 下是两次。于是文字被提交了两遍，同一个位置落下两个一模一样的形状。看上去什么问题都
	 * 没有；要按两次撤销才能去掉一段文字。
	 */
	const commitText = useCallback(
		(select = false) => {
			if (!typing || committed.current === typing) return;
			committed.current = typing;
			const { at: where, value, width: column, replacing } = typing;
			// 从打字的那个输入框量出来，所以之后能被选中的框，正好就是当时看到的框。元素已经不在了就退回一行高。
			const height = field.current ? field.current.offsetHeight / (display || 1) : typeSize * LINE;

			setHistory((h) => {
				const list = current(h);
				const written = value.trim();

				if (replacing !== undefined) {
					if (replacing >= list.length) return h;
					// 把一段已有的文字清空，就是删掉它。否则会留下一个看不见却还能被选中的标记，
					// 比用户想要的任何一种结果都糟。
					if (!written)
						return commit(
							h,
							list.filter((_, i) => i !== replacing),
						);
					return commit(
						h,
						list.map((shape, i) =>
							i === replacing
								? { ...shape, colour, points: [where], text: value, size: typeSize, width: column, height, background: backdrop, fixed: typing.manual === true }
								: shape,
						),
					);
				}

				if (!written) return h;
				return commit(h, [
					...list,
					{ tool: "text", colour, points: [where], text: value, size: typeSize, width: column, height, background: backdrop, fixed: typing.manual === true },
				]);
			});
			/*
			 * 有意结束的——Esc、⌘↵、在旁边点一下——交回来时是选中的，和一个框一画完就交回来一样：外框说明
			 * 它现在是一个可以挪、可以缩放、可以换颜色的东西，工具条下一次按下就作用在它身上。
			 */
			if (select && value.trim()) setSelected(replacing ?? shapes.length);
			setTyping(null);
		},
		[typing, setHistory, colour, typeSize, backdrop, display, setSelected, shapes.length],
	);

	/*
	 * 把正在写的文字借给马上要把这幅画变成图片的那一方。
	 *
	 * 文字在被提交之前住在画布上方的一个 `<textarea>` 里，提交它的是那个输入框失焦。工具条从不拿
	 * 焦点——这是有意的，这样写字时按「粗」改的是这段文字的大小，而不是把它结束掉——于是写到一半按
	 * 「完成」什么也没提交，用户明明看得见的文字没进文件。它在屏幕上，在一个输入框里；底下的画布从没
	 * 听说过它。
	 *
	 * `typing` 每变一次都重新登记，因为 `commitText` 闭包里有它。没有在输入时清空，`flushText` 才能
	 * 老实回答「没有」，而不是去提交一个过期的闭包。
	 */
	const { pendingText } = annotator;
	useEffect(() => {
		pendingText.current = typing ? commitText : null;
		return () => {
			pendingText.current = null;
		};
	}, [typing, commitText, pendingText]);

	/*
	 * 拿起另一个工具，就是这段文字写完了。
	 *
	 * 工具条不拿焦点，所以新工具已经在手上了，输入框还开着、里面还是那段旧文字——下一次按在图上，
	 * 既让输入框失焦提交了它，*又*开始了一笔，一个手势做了两件事。
	 */
	const toolWas = useRef(tool);
	useEffect(() => {
		if (toolWas.current === tool) return;
		toolWas.current = tool;
		if (tool !== "text") commitText();
	}, [tool, commitText]);

	/** 把一段已有的文字放回它当初的输入框里。 */
	const editText = useCallback(
		(index: number) => {
			const shape = shapes[index];
			if (!shape || shape.tool !== "text") return false;
			annotator.setColour(shape.colour);
			annotator.setBackdrop(shape.background);
			setSelected(null);
			setTyping({
				at: shape.points[0] ?? { x: 0, y: 0 },
				value: shape.text ?? "",
				width: shape.width ?? fitWidth(shape.text ?? ""),
				/*
				 * 宽度只有亲手定的才算一个决定。写的时候是按字适配的，那就继续适配：以前往一段文字里
				 * 加词，会按它最初那几个词的宽度折行。
				 */
				manual: shape.fixed === true,
				anchor: shape.points[0]?.x,
				replacing: index,
			});
			return true;
		},
		[shapes, annotator, setSelected, fitWidth],
	);

	const start = (event: React.PointerEvent) => {
		if (event.button !== 0) return;
		const point = at(event);

		const tolerance = pickTolerance(stroke, scale);

		/*
		 * 选中的标记在*任何*工具下都能抓，而不只是在选择工具下。
		 *
		 * 这正是整套安排的意义。画了一个矩形，想把它往左挪两厘米，以前是：切到指针工具、拖、再切回来。
		 * 一次调整三个动作，每次都是，下一个矩形再来一遍。这里刚画的标记还是活的：按在它上面就挪它，
		 * 按在手柄上就缩放它，按在别处就是在画下一个。什么都不用切。
		 *
		 * 只限*选中的*那个，是有意的。如果每个标记都能抓，一笔从已有标记上划过去的画笔会把它挪走
		 * 而不是画线，手里的工具就不再是它说的那个意思了。
		 */
		if (chosen && selected !== null) {
			const grip = gripAt(point);
			if (grip) {
				event.currentTarget.setPointerCapture(event.pointerId);
				setDragging({ index: selected, from: point, moving: chosen, handle: grip.index, moved: false, wasSelected: true });
				return;
			}
		}

		/*
		 * 这一下按住了什么，如果有的话。
		 *
		 * 任何一个已有的标记，只要手里的工具是*放置*东西的——也就是除了两种涂抹工具以外的全部。放一个
		 * 矩形、一个箭头、一个徽章或一段文字，都是从一个特意选的点开始的，而选的点恰好落在别的标记的
		 * 轮廓上很少见；想顺手挪一下那个标记却不少见。以前只限选中的那个，于是画一个框、再画一个箭头，
		 * 就发现框碰不得了——选中跟着箭头走了，按在框上又画出第二个箭头。
		 *
		 * 画笔和马赛克除外，取舍全在这里。它们是涂出来的，不是放上去的：一笔从手恰好在的地方开始，常常
		 * 就压在图上已有的东西上，一支会抓起它本该划过去的东西的笔刷是没法用的。用这两种工具时，永远是
		 * 工具说了算。
		 *
		 * 剩下的范围窄，而且会自己纠正：轮廓只在离笔画几个点以内才算按中，所以框的里面照样可以画、可以写，
		 * 矩形也总可以从另一个角开始画。
		 */
		const smears = tool === "pen" || tool === "mosaic";
		let target = -1;
		let held = false;
		/*
		 * 选中的标记在它外框里任何地方都能抓，而不只是在笔画上。
		 *
		 * 其余的仍然按轮廓算——为什么值得保留这个区分，见 `insideBounds`。画笔和马赛克连这个也不算：
		 * 它们的外框是一团涂鸦的包围盒，可能占半张图。
		 */
		const framed = chosen !== null && chosen.tool !== "pen" && chosen.tool !== "mosaic";
		if (
			chosen &&
			selected !== null &&
			(hitShape([chosen], point, tolerance) === 0 || (framed && insideBounds(chosen, point, chosen.stroke ?? stroke, tolerance)))
		) {
			target = selected;
			held = true;
		} else if (!smears) {
			target = hitShape(shapes, point, tolerance);
		}

		if (target >= 0) {
			// 先提交：拿起另一个标记的那一刻，正在写的文字就算写完了；还开着的话，下一次松开会同时改两样东西。
			if (typing && typing.replacing !== target) commitText();
			setSelected(target);
			event.currentTarget.setPointerCapture(event.pointerId);
			setDragging({ index: target, from: point, moving: shapes[target]!, handle: null, moved: false, wasSelected: held });
			return;
		}

		// 指针底下什么都没有，那这就是一个新标记的开始。
		if (selected !== null) setSelected(null);

		if (tool === "text") {
			/*
			 * 图上的一个输入框，而不是 `window.prompt`。
			 *
			 * Electron 直接禁掉了 prompt——什么都不显示就返回 null，文字工具因此毫无反应。就算不论这个，
			 * 就地打字也是更好的做法：文字按它最终的样式、大小和位置出现，而不是在别处的一个框里描述完、
			 * 再去发现它长什么样。
			 *
			 * 它能留下来靠的是 `preventDefault`。按在画布上的默认动作是挪焦点，而输入框正是在这一下里
			 * 挂上的：下面的 effect 给了它焦点，片刻之后同一次点击又把焦点拿走，`onBlur` 提交了一段空文字，
			 * 也就是把输入框删掉了。结果是一个只闪一帧的框——和工具毫无反应分不出来，报上来时也正是这么说的。
			 */
			event.preventDefault();
			/*
			 * 在正在写的文字旁边按一下，是把它写完，而且只做这一件事。
			 *
			 * 以前是写完它，再在按下的地方打开下一个——在手为了说「好了」而随便点的地方，冒出一个虚线框和
			 * 一个闪烁的光标，那几乎从来不是想写第二段的地方。再点到真正想写的地方，会扔掉那个空框再开一个，
			 * 于是框看起来在图上乱跳。所有标注工具都把离开后的第一次点击当作这段文字的结束，下一次才开始下一段。
			 */
			if (typing) {
				commitText(true);
				return;
			}
			/*
			 * 光标落在按下的地方：框往左上挪一个内边距加半行，第一行正好以这个点为中心，文字从这里开始。
			 * 按框的角来放的话，每段文字都落在要的位置下面一行、偏右一点。
			 */
			const pad = typeSize * PAD;
			const line = typeSize * LINE;
			const imageHeight = image.current?.height ?? Number.POSITIVE_INFINITY;
			// 靠近下边缘时框往上挪，而不是挂出图外；靠近右边缘时由 `fitTyping` 往左挪。
			const y = Math.max(-pad, Math.min(point.y - pad - line / 2, imageHeight - line - pad * 2));
			setTyping(fitTyping({ at: { x: point.x - pad, y }, anchor: point.x - pad, value: "", width: 0 }, ""));
			return;
		}

		// 徽章是放上去的，不是拖出来的；按下和松开之间没有什么可预览的。
		if (tool === "step") {
			// 也带着自己的尺寸，就是工具条此刻设的半径，和文字的字号一样。
			setHistory((h) => commit(h, [...current(h), { tool: "step", colour, points: [point], stroke, size: badge }]));
			setSelected(shapes.length);
			return;
		}

		event.currentTarget.setPointerCapture(event.pointerId);
		/*
		 * 尺寸在画下的那一刻盖上去，而不是绘制时再读回来。
		 *
		 * 否则图上每个标记都按工具条此刻的设置来画，改一下设置就会回过头去改已经完成的东西——粗粗地打了
		 * 三处码，给第四处挑了更细的颗粒，前三处也跟着变细了。
		 */
		setDrawing({
			tool: tool as Exclude<Tool, "text" | "step">,
			colour,
			points: [point],
			stroke,
			...(tool === "mosaic" ? { block: annotator.block, brush } : {}),
		});
	};

	const move = (event: React.PointerEvent) => {
		const point = at(event);

		// 只在拿着马赛克时；别的工具都把它留成 null，不画圈。
		setBrushAt(tool === "mosaic" ? point : null);

		/*
		 * 光标说出这里有没有东西可以拿起来。
		 *
		 * 和按下用的是同一个 `hitShape`，所以光标许诺的和按下兑现的不会对不上——包括空心矩形在边上能抓、
		 * 在中间不能抓这一点。只在变化时才写，划过空白处不会每个指针事件都重新渲染。
		 */
		if (!dragging) {
			const tol = pickTolerance(stroke, scale);
			let over: "move" | "point" | "width" | null = null;
			if (chosen && selected !== null) {
				const grip = gripAt(point);
				if (grip) over = grip.index === WIDTH_HANDLE ? "width" : "point";
				else if (hitShape([chosen], point, tol) === 0) over = "move";
			}
			// 和按下同一条规矩：除了两种涂抹工具，什么都能抓。
			if (!over && tool !== "pen" && tool !== "mosaic" && hitShape(shapes, point, tol) >= 0) over = "move";
			setHovering((was) => (was === over ? was : over));
		}

		if (dragging) {
			const dx = point.x - dragging.from.x;
			const dy = point.y - dragging.from.y;
			setDragging((held) => {
				if (!held) return held;
				const origin = shapes[held.index];
				if (!origin) return held;
				// 总是从原来的那个算起，拖的过程中不会累积舍入误差。
				const moving = held.handle === null ? moveShape(origin, dx, dy) : resizeShape(origin, held.handle, point);
				return { ...held, moving, moved: held.moved || Math.hypot(dx, dy) > 0.5 };
			});
			return;
		}

		if (!drawing) return;
		/*
		 * 自上一帧以来指针经过的每一个位置，而不只是它最后停在哪。
		 *
		 * 指针移动每帧来一次，但手报上来的远不止这些；中间那些作为合并事件送来。只用每帧那几个点画出来的
		 * 快速一笔，是几个拐角用直线连起来。
		 */
		const passed = drawing.tool === "pen" || drawing.tool === "mosaic" ? event.nativeEvent.getCoalescedEvents?.().map(at) : undefined;
		const shift = event.shiftKey;
		setDrawing((live) => {
			if (!live) return live;
			// 画笔和马赛克一路累积；其余的由两端决定。
			if (live.tool === "pen" || live.tool === "mosaic") return { ...live, points: [...live.points, ...(passed?.length ? passed : [point])] };
			const from = live.points[0]!;
			return { ...live, points: [from, shift ? constrainEnd(live.tool, from, point) : point] };
		});
	};

	const end = () => {
		if (dragging) {
			const { index, moving, moved, wasSelected } = dragging;
			if (moved) {
				// 每次挪动在历史里记一步，哪儿都没去的拖拽一步也不记。
				setHistory((h) => {
					const list = current(h);
					return index < list.length
						? commit(
								h,
								list.map((s, i) => (i === index ? moving : s)),
							)
						: h;
				});
			} else {
				/*
				 * 哪儿都没去的一次按下是一次点击，而在文字上，点击的意思是「让我改字」——要么手里拿的是
				 * 文字工具，要么这是在已经选中的东西上点的第二下。
				 *
				 * 在这里而不是按下时决定，一个手势才能两用：按住拖是挪文字，按下松开是打开它。两者都不用
				 * 事先选定，这正是单击能安全地做「进入编辑」这么有分量的事的全部原因。
				 */
				const shape = shapes[index];
				if (shape?.tool === "text" && (tool === "text" || wasSelected)) {
					editText(index);
				} else if (wasSelected) {
					/*
					 * 在已经选中的东西上再点一下，就往下一层，轮到指针底下叠着的下一个。
					 *
					 * 标记会叠起来——一个箭头的尖落在框里、一个徽章压在线上——而命中测试总是回答最上面那个，
					 * 没有这一条，底下的看得见却永远碰不到。轮着来，第二下够到第二个标记，最后一个再绕回最上面。
					 *
					 * 文字在上面已经排除了，因为对它来说第二下已经是「打开文字」，那是更常想要的。
					 */
					// `from` 是按下的地方，而它没动过，所以它仍然就是那个点。
					const stack = hitShapes(shapes, dragging.from, pickTolerance(stroke, scale));
					if (stack.length > 1) {
						const here = stack.indexOf(index);
						setSelected(stack[(here + 1) % stack.length] ?? index);
					}
				}
			}
			setDragging(null);
			return;
		}

		if (!drawing) return;
		/*
		 * 没拖的一次点击留下一个只有一个点的形状，画出来什么都没有——扔掉它，画笔和马赛克除外，
		 * 对它们来说点一下就是正当的一笔。
		 *
		 * 拖了一两个点的，是手动了一下的点击：以前会提交一个一像素宽的框、选中它，留下一个什么也没框住的
		 * 外框，下一次按下又把它抓了起来。
		 */
		const keeps = drawing.tool === "pen" || drawing.tool === "mosaic";
		const first = drawing.points[0]!;
		const last = drawing.points[drawing.points.length - 1]!;
		const travelled = Math.hypot(last.x - first.x, last.y - first.y) * scale;
		if (keeps || (drawing.points.length > 1 && travelled >= MIN_DRAG)) {
			setHistory((h) => commit(h, [...current(h), drawing]));
			// 带着手柄交回来，接下来对它做的就是调整，而不是去找能调整它的那个工具。
			if (SELECT_ON_DRAW.has(drawing.tool)) setSelected(shapes.length);
		}
		setDrawing(null);
	};

	/*
	 * 正在挪一个标记时是抓紧的手，指针底下有标记时是移动，否则是工具自己的光标。`grabbing` 压过
	 * `move`，这样快速拖动甩开命中测试的那一刻，光标不会闪回去。
	 */
	const cursor = dragging
		? "cursor-grabbing"
		: hovering === "width"
			? "cursor-ew-resize"
			: hovering === "point"
				? "cursor-nwse-resize"
				: hovering === "move"
					? "cursor-move"
					: (CURSOR[tool] ?? "cursor-crosshair");

	// 单位是显示像素。`chosen` 已经跟着拖动走了，所以框随标记一起移动，而不是留在拿起它的地方。
	const box = chosen ? shapeBounds(chosen, stroke) : null;

	return (
		<div className="relative">
			<canvas
				ref={attach}
				draggable={false}
				onPointerDown={start}
				onPointerMove={move}
				onPointerUp={end}
				onPointerCancel={end}
				onPointerLeave={() => {
					setHovering(null);
					setBrushAt(null);
				}}
				onDoubleClick={(event) => {
					/*
					 * 只为了不让下面的舞台缩放。
					 *
					 * 打开文字不再在这里处理了：两次点击已经能做到——第一下选中，第二下打开——再接住双击的话
					 * 会打开两次，把第一次刚开始写的东西扔掉。
					 */
					event.stopPropagation();
				}}
				className={`${className ?? `${STAGE_FIT} rounded-xl plume-annotate-paper`} block ${cursor}`}
				/*
				 * `font-variant-numeric: normal`，因为文档里的画布画字时用的是元素自己的数字变体——而界面在
				 * body 上为计数设了 `tabular-nums`。文字里每个数字都按 0 的宽度画：「123123123123」画在图上比
				 * 在打字的输入框里宽 12%，一提交就明显散开，保存出去的那份（画在文档外的画布上）又窄回来。
				 * 输入框的 `font` 简写已经把它重置了；这是画布这一半。
				 */
				style={{ touchAction: "none", fontVariantNumeric: "normal", ...style }}
			/>

			{/*
			 * 马赛克马上要盖住的范围，按它真要盖住的大小。
			 *
			 * 画出来而不是说出来，因为「笔刷多大」唯一有用的答案就是它落在底下这张图上的形状。`display` 把
			 * 笔刷从图片像素换成屏幕像素，所以任何缩放下这个圈都是这一笔真实的落点——尺寸设置一变它就跟着变，
			 * 那个控件就是这样解释自己的。
			 */}
			{tool === "mosaic" && brushAt && (
				<span
					className="pointer-events-none absolute rounded-full border plume-annotate-brush"
					style={{
						left: (brushAt.x - brush / 2) * display,
						top: (brushAt.y - brush / 2) * display,
						width: brush * display,
						height: brush * display,
					}}
				/>
			)}

			{box && (
				/*
				 * 只是一个外框。删除按钮在工具条上。
				 *
				 * 它以前浮在这个框的角上，于是一个固定 24 点的控件会出现在标记恰好在的任何地方：两个标记挨得近时
				 * 压在旁边的文字上，标记靠近边缘时跑出图的上沿，标记很小时比标记本身还大。一个位置由它所作用的
				 * 东西决定的控件，这些一样也躲不开。放在工具条上，它永远在同一个地方、同样大小，也永远不压在图上。
				 *
				 * `pointer-events-none`，因为它盖在标记上面，一个吞掉按下的外框会让它指着的那个东西成为唯一抓不起来的。
				 */
				<span
					className="pointer-events-none absolute plume-annotate-frame"
					style={{
						left: box.x * display,
						top: box.y * display,
						width: box.w * display,
						height: box.h * display,
						// 舞台被缩放了，而它在舞台里面；跟着图一起变大的外框在 400% 下是一条 4 点粗的虚线带。
						// 它的线和圆角保持屏幕尺寸。
						borderWidth: chrome,
						borderRadius: chrome * 3,
					}}
				/>
			)}

			{/*
			 * 手柄，画出来但点不到。
			 *
			 * 它们的命中测试在画布上做，用的是拖动会用的同一套坐标。把它们做成真正的点击目标，就意味着那套逻辑
			 * 在 DOM 里还要有第二份，而两份命中测试比能保持一致的数目多一份。
			 */}
			{chosen &&
				grips.map((grip) => (
					<span
						key={grip.index}
						className="pointer-events-none absolute rounded-full plume-annotate-grip"
						style={{
							// 任何缩放下都是屏幕尺寸，和外框一样：在 400% 下，10 点的手柄曾是一个 40 点的圆盘。
							left: grip.at.x * display - 5 * chrome,
							top: grip.at.y * display - 5 * chrome,
							width: 10 * chrome,
							height: 10 * chrome,
							borderWidth: 2 * chrome,
						}}
					/>
				))}

			{typing && (
				/*
				 * 输入框就是预览。
				 *
				 * 下面每一个值，都是 `paint` 对同一段文字会做的事在显示空间里的样子：同样的字体、同样的行高、同样的
				 * 内边距、同样的颜色、同样的底色，在同样的栏宽处折行。早先的版本把输入框做成透明、在底下画一份预览，
				 * 那是同一个外观的两份实现，看起来也确实是——一个带虚线边的灰框，和结果一点也不像。
				 */
				<div
					className="absolute"
					style={{ left: typing.at.x * display, top: typing.at.y * display, width: typing.width * display }}
					onPointerDown={(event) => event.stopPropagation()}
				>
					{/*
					 * 一圈能把文字拿起来的边，写着字的时候也能用。
					 *
					 * 它垫在输入框底下、每边宽出八个点，所以唯一能按到它的是文字外面那一圈——中间照样把光标放在点的
					 * 地方。没有它的话，挪一段写到一半的文字得先提交、切工具、拖、再双击回去，回答「不是那儿，是这儿」
					 * 要四个动作。
					 */}
					<span
						aria-hidden
						onPointerDown={(event) => {
							event.preventDefault();
							event.stopPropagation();
							event.currentTarget.setPointerCapture(event.pointerId);
							// 屏幕点按此刻看着的缩放换成图片像素，否则它会落在指针后面。
							carrying.current = { x: event.clientX, y: event.clientY, from: typing.at, scale: scale || 1 };
						}}
						onPointerMove={(event) => {
							const held = carrying.current;
							if (!held) return;
							setTyping((entry) => {
								if (!entry) return entry;
								const x = held.from.x + (event.clientX - held.x) / held.scale;
								// 放到了别处，那它就从那里开始长。
								return { ...entry, anchor: x, at: { x, y: held.from.y + (event.clientY - held.y) / held.scale } };
							});
						}}
						onPointerUp={() => {
							carrying.current = null;
						}}
						className="-inset-2 absolute cursor-move rounded-lg"
					/>
					<Textarea
						ref={field}
						value={typing.value}
						onChange={(event) => {
							const value = event.target.value;
							setTyping((entry) => (entry ? fitTyping(entry, value) : entry));
						}}
						onBlur={() => commitText()}
						onKeyDown={(event) => {
							// 在这里拦住，看图器的 Esc 才不会在只想写完一段文字时把整个浮层关掉。
							event.stopPropagation();
							/*
							 * Enter 是换行。以前它是提交。
							 *
							 * 写第二行是很平常的需求，而 `shift`+`enter` 是发送的惯例，不是写字的惯例——别处写字的地方
							 * 都把换行放在不带修饰的那个键上。一段文字靠点到别处、⌘↵ 或 Esc 来结束。
							 *
							 * Esc 保留写下的字。以前它会扔掉，而在这个应用、这个平台上别的任何打字的地方都不是这样：
							 * 字在屏幕上，按 Esc 是为了写完，结果字没了。不想要的文字按一下撤销就没了；打了又丢的就回不来了。
							 */
							if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
								event.preventDefault();
								commitText(true);
							}
						}}
						placeholder={translate(PLACEHOLDER)}
						rows={1}
						spellCheck={false}
						className="relative block w-full resize-none overflow-hidden border-0 bg-transparent outline-none placeholder:text-current placeholder:opacity-40"
						style={{
							font: fontOf(typeSize * display),
							lineHeight: LINE,
							padding: `${typeSize * PAD * display}px`,
							color: colour,
							background: backdrop ?? "transparent",
							borderRadius: typeSize * 0.2 * display,
							caretColor: colour,
							// 和画布同一条折行规矩：中文任何地方都能断，拉丁文在空格处断。
							wordBreak: "break-word",
							whiteSpace: "pre-wrap",
							/*
							 * 没有底色时，和绘制时加的那道淡描边一样，理由也一样。这里没有它的话，打字时的文字比提交后
							 * 的颜色饱和一点点，这种差别只在输入框消失、文字看上去变了的那一刻才注意得到。
							 *
							 * `paint-order` 把描边放到填充下面，就是画布上先 `strokeText` 再 `fillText` 的效果。
							 */
							// 和 `paint` 保持一致：一道细线，不是光晕。两边必须一样，否则文字会在输入框消失的那一刻变样。
							WebkitTextStroke: backdrop ? undefined : `${Math.max(1, typeSize / 18) * display}px rgba(255,255,255,0.85)`,
							paintOrder: "stroke fill",
						}}
					/>
					{/* 一圈虚线，它不属于文字，只属于编辑文字这件事——和外框一样是屏幕尺寸。 */}
					<span className="pointer-events-none absolute inset-0 plume-annotate-typing" style={{ borderWidth: chrome, borderRadius: chrome * 6 }} />
					<button
						type="button"
						aria-label={translate("annotate.textWidth")}
						data-plume-tip={translate("annotate.dragWidth")}
						data-plume-tip-side="top"
						onPointerDown={(event) => {
							event.preventDefault();
							event.stopPropagation();
							event.currentTarget.setPointerCapture(event.pointerId);
							sizing.current = { x: event.clientX, from: typing.width, scale: scale || 1 };
						}}
						onPointerMove={(event) => {
							const held = sizing.current;
							if (!held) return;
							const next = held.from + (event.clientX - held.x) / held.scale;
							setTyping((entry) => (entry ? { ...entry, manual: true, width: Math.max(typeSize * 2, Math.min(next, width - entry.at.x)) } : entry));
						}}
						onPointerUp={() => {
							sizing.current = null;
						}}
						className="absolute cursor-ew-resize rounded-full plume-annotate-width transition-transform duration-[var(--plume-t-quick)] hover:scale-125"
						style={{ right: -6 * chrome, bottom: -6 * chrome, width: 14 * chrome, height: 14 * chrome, borderWidth: chrome }}
					/>
				</div>
			)}
		</div>
	);
}
