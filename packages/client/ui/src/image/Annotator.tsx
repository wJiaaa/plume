/**
 * 在图片上面画东西，而不是画进图片里。
 *
 * 标记存成一张形状清单，每次从清单重画，而不是落一笔就累积进画布。正因为这样，撤销和重做才是清单上的
 * 一个游标而不是一叠位图；撤掉一个步骤标号，其余的才会自己重新编号；正在画的形状才能实时显示——还在拖的
 * 矩形每一帧都从同一张清单加一个临时项画出来，预览和提交走的是同一段代码。
 *
 * 画布按图片的**原始**像素开，再由 CSS 缩小。指针坐标进来时经 `getBoundingClientRect` 换算，它已经把
 * 上层舞台的缩放算进去了——所以在 400% 下画，落点仍然在指针处，而这个文件里根本不用出现缩放。
 *
 * 拆成一个 hook、一块画布和一条工具条，是因为工具条不能住在画布的父节点里：舞台为了缩放带着 transform，
 * 而 `position: fixed` 在被 transform 过的祖先里是相对那个祖先固定的，不是相对窗口。一条跟着图片一起
 * 放大、一起滑走的工具条，在 400% 下没法用。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
	badgeAt,
	canRedo,
	canUndo,
	commit,
	current,
	emptyHistory,
	mosaicBlock,
	mosaicBrush,
	moveShape,
	redo,
	strokeAt,
	typeAt,
	undo,
	type History,
	type Shape,
	type Tool,
} from "./annotate.ts";
import { paintAll } from "./paint.ts";

export const COLOURS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#111827"];

/**
 * 一张解码好的图，和它的像素尺寸。
 *
 * 到这里的有两种东西，不是同一种对象。看图器标注的是一张能当 URL 用的图，解码成一个 `<img>`；截图浮层
 * 拿到的是屏幕的原始像素，解码成 `ImageBitmap`——因为在主进程里把屏幕编码成 PNG 要花掉截图出现之前的
 * 那段延迟里的 133ms，而截图上的画面是在那段延迟**之前**拍下的，于是这 133ms 里屏幕可能变了，再肉眼可见
 * 地弹回去。
 *
 * `drawImage` 两种都收，分不出区别。不同的是它们报尺寸的方式——`naturalWidth` 对 `width`——所以只在
 * 这里读一次，下游一律用这个形状。
 */
interface Decoded {
	source: CanvasImageSource;
	width: number;
	height: number;
}

export interface Annotator {
	tool: Tool;
	setTool: (tool: Tool) => void;
	colour: string;
	setColour: (colour: string) => void;
	/** 文字底下垫什么；undefined 就是什么都不垫。 */
	backdrop: string | undefined;
	setBackdrop: (backdrop: string | undefined) => void;
	weight: number;
	setWeight: (weight: number) => void;
	undo: () => void;
	redo: () => void;
	clear: () => void;
	canUndo: boolean;
	canRedo: boolean;
	dirty: boolean;
	/** 选中的是哪个标记，或者 null。是当前状态那张清单里的下标。 */
	selected: number | null;
	setSelected: (index: number | null) => void;
	removeSelected: () => void;
	/** 把选中的标记挪这么多个屏幕点——方向键用的。 */
	nudge: (dx: number, dy: number) => void;
	/**
	 * 标注好的图，PNG data URL，按图片自己的尺寸；源图还没解码完时是 null。
	 *
	 * 重新画一遍，而不是从屏幕上那块画布读回来：那块是按屏幕的分辨率画的，图片显示得比它本身大的时候，
	 * 像素比图片本身还多。读回来的话，一张 1408px 的图交出去的是 2200px 的副本。两边用的是同一个
	 * `paintAll`，所以出来的就是屏幕上的样子，尺寸和进来时一样。
	 */
	render: () => string | null;
	/**
	 * 把正在写的那段文字提交掉，如果有的话。返回有没有。
	 *
	 * 任何要把这幅画变成一张图的操作都得先调它。文字在提交之前住在一个 `<textarea>` 里，提交它的是这个
	 * 输入框失去焦点——可工具条故意不拿焦点（`onMouseDown` → `preventDefault`），因为写字时按「粗」必须
	 * 是改这段字的大小，而不是结束它。于是光标还在文字里就按「完成」，什么也没提交：字在屏幕上，在画布
	 * 上面的一个输入框里，而被裁出来的是画布。出来的图上没有那段字。
	 *
	 * `true` 表示提交了东西、画布**还没有**重画——重画是一个 effect，要等 React 把状态变化刷出去以后才
	 * 落下。调用方等一帧再读。
	 */
	flushText: () => boolean;
	// 下面是画布要用的内部件，不给调用方用。
	/**
	 * `flushText` 怎么够到那段文字——它住在 `AnnotateCanvas` 里，不在这里。
	 *
	 * 用 ref 而不是 state：画布在写字时填上它、写完清空，没有任何东西因为它而渲染得不一样。为了这一次调用
	 * 把整套编辑状态提到这里来，要搬好几百行。
	 */
	pendingText: React.RefObject<(() => void) | null>;
	shapes: Shape[];
	canvas: React.RefObject<HTMLCanvasElement | null>;
	setHistory: React.Dispatch<React.SetStateAction<History>>;
	image: React.RefObject<Decoded | null>;
	/** 这个网格大小的马赛克取样用的那张平均过的图，用到时才建，建了就缓存。 */
	mosaicSourceFor(block: number): HTMLCanvasElement | null;
	ready: boolean;
	/**
	 * 这个标注器先后解码过几张图——「源图换了，重画」唯一诚实的依赖。
	 *
	 * `ready` 说不出这件事。新图解码时它变成 false，落地后又变回 true，所以两次截图之间它的**值**两次都是
	 * true——要是解码快到在 React 把那个 `false` 刷出去之前就完成了，两次更新落在同一轮里，这个标志根本没
	 * 变，盯着它的 effect 再也不会跑。`image` 也说不出：它是 ref，所以压根不能当依赖。
	 *
	 * 截图浮层是这件事看得出代价的地方。它在一个以 `ready` 为依赖的 effect 里用这张位图画冻结的桌面，而
	 * 第一次截图还开着时又截了一次，五毫秒就解码完了——于是浮层一边从这一次的图里裁，一边继续显示**上一次**
	 * 的画面，也再没发出让窗口上屏的 `ready` 握手，窗口只好等它 1500ms 的兜底超时。
	 */
	revision: number;
	/**
	 * 这张图和所有从它派生出来的 canvas 用的色彩空间。
	 *
	 * 传下去而不是各处自己猜：裁剪出来的那张、马赛克取样的那张、放大镜里的那张，都得跟主画布同一
	 * 个空间，否则 `drawImage` 会在它们之间做转换——一次转换就是一次色偏，而且只偏彩色不偏灰。
	 */
	colorSpace: PredefinedColorSpace;
	/**
	 * 源图的原始宽度，放在 state 里而不是从 ref 上读。
	 *
	 * 这里的每个尺寸——线宽、字号、马赛克格子——都由它推出来，从 `image.current` 推的话，推导就没有诚实的
	 * 依赖：ref 当不了依赖，拿 `ready` 标志顶替它是一句谎话，lint 拒绝它是对的。
	 */
	width: number;
	/** 现在画一笔马赛克会用的网格。已经画上的标记各自带着自己的。 */
	block: number;
	/**
	 * 在图片适配后的尺寸下，一个屏幕点盖住多少个图片像素：工具条给出的尺寸是屏幕尺寸，标记存的是图片像素，
	 * 靠它换算。由画布报上来——只有画布知道图片在屏幕上有多大。
	 */
	unit: number;
	setUnit: (unit: number) => void;
}

export interface AnnotatorOptions {
	/**
	 * 一个随图片变化的值，哪怕字节没有变。
	 *
	 * 截图浮层是一张长期存在的页面——显示、隐藏，而不是建了又拆——所以 `src` 是唯一能告诉它**新的**一次
	 * 截图开始了的东西。两次截图之间屏幕没变的话，编码出来的 PNG 逐字节相同，`src` 也就相同，第一次画上
	 * 的标记在第二次还会在。
	 */
	session?: number | string;
	/**
	 * 这张图的数值属于哪个色彩空间。
	 *
	 * 只有截图会说这件事，因为只有它拿到的是显示器帧缓冲的原始数值——一台 Display P3 的机器上，
	 * 屏幕上的纯红在那串数里是 234,51,35。默认按 sRGB 读，那是每一张解码出来的图片的答案（PNG
	 * 自带 profile，浏览器已经替我们转好了），也是没有色彩管理时的安全答案。
	 */
	colorSpace?: PredefinedColorSpace;
}

/**
 * 屏幕的原始像素，直接从主进程来。
 *
 * 已经是 RGBA：从平台的 BGRA 换过来，在主进程里是五毫秒，放到渲染进程里就是一个 22MB 的循环，还是在
 * 要把结果画出来的那个线程上。
 */
export interface RawPixels {
	pixels: Uint8Array;
	width: number;
	height: number;
}

/** 画进画布会污染它的地址：和本页不同源的（`data:`、`blob:` 本来就算本页的）。 */
function foreign(src: string): boolean {
	if (/^(data|blob):/i.test(src)) return false;
	try {
		return new URL(src, location.href).origin !== location.origin;
	} catch {
		return false;
	}
}

export function useAnnotator(src: string | RawPixels | null, options?: AnnotatorOptions): Annotator {
	const canvas = useRef<HTMLCanvasElement>(null);
	const image = useRef<Decoded | null>(null);
	/** 写字时由 `AnnotateCanvas` 填上。见 `flushText`。 */
	const pendingText = useRef<(() => void) | null>(null);
	const [tool, setTool] = useState<Tool>("pen");
	const [colour, setColour] = useState(COLOURS[0]!);
	const [backdrop, setBackdrop] = useState<string | undefined>(undefined);
	const [history, setHistory] = useState<History>(emptyHistory);
	const [selected, setSelected] = useState<number | null>(null);
	const [ready, setReady] = useState(false);
	/** 见 `Annotator` 上的 `revision`：`ready` 当不了的那个计数。 */
	const [revision, setRevision] = useState(0);
	const [width, setWidth] = useState(0);
	const [weight, setWeight] = useState(1);
	const [unit, setUnit] = useState(1);

	// 只加载一次；每次重画都画这同一张解码好的位图，而不是再解码一遍。
	const session = options?.session;
	const colorSpace = options?.colorSpace ?? "srgb";
	useEffect(() => {
		setReady(false);
		setHistory(emptyHistory());
		setSelected(null);

		/*
		 * 拿下一张图之前先放掉这一张。
		 *
		 * `ImageBitmap` 的像素在 JavaScript 堆外面——这块屏幕上是 22MB——回收器不知道它占着多少，所以一点
		 * 也不着急。截图浮层每次截图**和**每次截图结束都会走到这里，它所在的窗口又不再销毁，不在这里放就
		 * 永远没人放。
		 */
		const previous = image.current;
		image.current = null;
		if (previous?.source instanceof ImageBitmap) previous.source.close();

		/*
		 * 马赛克那几张平均过的副本属于要走的这张图。
		 *
		 * 它们原先放在一个只写不清的 ref 里，于是第二次截图在同一个网格大小下找到的是**第一次**截图的平均值，
		 * 并且照着画了出来。马赛克块的颜色在这块屏幕上无从说起——让这件事暴露出来的那次，是上一张截图背后
		 * 的桌面。
		 *
		 * 这比画错一块颜色更糟：马赛克是人拿来盖住不想让人看见的东西的，而这一块盖在上面的是**更早**一张
		 * 截图的像素。底下的东西没被遮住不说，盖在上面的格子还露出了另一次截图的内容。
		 */
		sources.current.clear();

		// 看图器只是显示图片时传的是 ""。给 Image 设空的 `src` 会按文档地址解析、去取页面本身，并不是无害的
		// 空操作——得跳过，不能让它失败了事。
		if (!src) return;

		/** 解码出来的不管是哪种——交出去、按它定画布尺寸、重画。 */
		const accept = (decoded: Decoded) => {
			image.current = decoded;
			const el = canvas.current;
			if (el) {
				el.width = decoded.width;
				el.height = decoded.height;
			}
			setWidth(decoded.width);
			setReady(true);
			/*
			 * 再说一声这是**另一张**图——上面三样都说不出。
			 *
			 * `ready` 又是 true，之前也是 true；`width` 还是同一块屏幕；位图住在 ref 里。只盯着它们其中之一
			 * 重画的，画一次之后这一页就再也不画了——那是什么样子，见 `Annotator` 上的 `revision`。
			 */
			setRevision((n) => n + 1);
		};

		/*
		 * 原始像素走近路。
		 *
		 * 对一个 `ImageData` 做 `createImageBitmap` 是一次复制，不是一次解码——没有 PNG 要解析，因为主进程
		 * 根本没编码过。从前拍下画面和能把它显示出来之间的那 133ms 就花在这里。
		 */
		if (typeof src !== "string") {
			let live = true;
			/*
			 * 按它本来的色彩空间读这串数，而不是一律当 sRGB。
			 *
			 * 抓屏拿回来的是显示器帧缓冲里的原始数值：一台 Display P3 的机器上，屏幕上的纯红在这串
			 * 数里是 234,51,35。不说清楚这一点，浏览器就按 sRGB 理解它，再替我们转一次去显示——那个
			 * 红被扩了一道，截出来比屏幕上更艳，而灰阶分毫不差（中性轴在两个空间里重合）。这正是
			 * 「截图有色差」被报上来的样子。
			 */
			const data = new ImageData(new Uint8ClampedArray(src.pixels), src.width, src.height, { colorSpace });
			void createImageBitmap(data).then(
				(bitmap) => {
					if (live) accept({ source: bitmap, width: bitmap.width, height: bitmap.height });
					else bitmap.close();
				},
				() => {},
			);
			return () => {
				live = false;
			};
		}

		const img = new Image();
		img.onload = () => accept({ source: img, width: img.naturalWidth, height: img.naturalHeight });
		let live = true;
		let local: string | null = null;
		/*
		 * 别的源的图先取成字节，再按本页的 blob 地址画。
		 *
		 * `plume-media://` 这类协议对页面来说是另一个源：直接画进画布，画布就被污染，`toDataURL` 抛错，
		 * 标注完的副本读不回来（「完成」什么也交不出）。取不到字节时照旧按原地址画，看得见图，只是读不回。
		 */
		if (foreign(src)) {
			void fetch(src)
				.then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
				.then(
					(blob) => {
						if (!live) return;
						local = URL.createObjectURL(blob);
						img.src = local;
					},
					() => {
						if (live) img.src = src;
					},
				);
		} else {
			img.src = src;
		}
		return () => {
			live = false;
			img.onload = null;
			if (local) URL.revokeObjectURL(local);
		};
		// `session` 不带数据——它在这里，是为了屏幕没变时的第二次截图（像素和上一次逐字节相同）也能清掉标记。
		// 见 `AnnotatorOptions`。
	}, [src, session, colorSpace]);

	/** **现在**画一笔马赛克会用的颗粒。已经在图上的标记各自带着自己的。 */
	const block = width > 0 ? mosaicBlock(unit, weight) : 0;

	/**
	 * 马赛克取样用的那张平均过的图，每种网格大小一张，用到时才建。
	 *
	 * 把整张图按每格一个像素画进一块画布，一次调用就得到每一格的平均色——马赛克就是这个。画一格就是把这张图
	 * 的一个像素关掉平滑、按格子大小贴回去；另一种做法是每帧每格去平均像素，那是同一个答案每秒算几千遍。
	 *
	 * 按格子大小分开存而不是只留一块，因为这张图的分辨率**就是**网格：它有 `naturalWidth / block` 个像素，
	 * 按一种颗粒建、按另一种贴，每一格取到的都是错的像素。现在每个标记都记得自己画时的颗粒，一张图上就可能
	 * 有好几种——一大块粗的盖住一个窗口、一行细的盖住一行字——每种都要自己的那张。有几档尺寸就最多几张，
	 * 每张几 KB。
	 */
	const sources = useRef(new Map<number, HTMLCanvasElement>());
	const mosaicSourceFor = useCallback(
		(grid: number): HTMLCanvasElement | null => {
			const img = image.current;
			const key = Math.max(1, Math.round(grid));
			if (!img || !Number.isFinite(grid) || grid <= 0) return null;
			const known = sources.current.get(key);
			if (known) return known;
			const small = document.createElement("canvas");
			small.width = Math.max(1, Math.ceil(img.width / key));
			small.height = Math.max(1, Math.ceil(img.height / key));
			// 跟主画布同一个色彩空间：`drawImage` 会在两个空间之间做转换，转过去再转回来，马赛克块
			// 的颜色就跟它盖住的那片不是一回事了。
			small.getContext("2d", { colorSpace })?.drawImage(img.source, 0, 0, small.width, small.height);
			sources.current.set(key, small);
			return small;
		},
		[image, colorSpace],
	);

	const shapes = current(history);

	/**
	 * 给选中的标记换样式，如果有选中的话。
	 *
	 * 工具条原先只管**接下来**会发生什么：选红色，改的是下一个标记的颜色，刚画完、还选着、手柄还亮着的那个
	 * 箭头原样不动。每个编辑器都是反过来的，而且有道理：选中的东西就是你正在说的那个，接下来伸手去够的控件
	 * 说的也是它。原先想改一个标记的颜色，只能删了重画。
	 *
	 * 记进历史，所以能像别的编辑一样撤销。
	 */
	const restyle = useCallback(
		(change: (shape: Shape) => Shape) => {
			setHistory((h) => {
				const list = current(h);
				const shape = selected === null ? undefined : list[selected];
				if (!shape) return h;
				const changed = change(shape);
				/*
				 * 什么都没改的改动不算一步。选一个标记已经是的颜色——重新打开一段文字时会这么做，好把它的颜色放回
				 * 工具条——原先会记一步，于是下一次撤销看上去什么也没做。
				 */
				if (JSON.stringify(changed) === JSON.stringify(shape)) return h;
				return commit(
					h,
					list.map((one, index) => (index === selected ? changed : one)),
				);
			});
		},
		[selected],
	);

	const applyColour = useCallback(
		(next: string) => {
			setColour(next);
			restyle((shape) => ({ ...shape, colour: next }));
		},
		[restyle],
	);

	/**
	 * 尺寸控件，也作用到选中的标记上。
	 *
	 * 每种工具的「大小」单位不一样——线有线宽，文字有字号，马赛克有网格和笔刷——所以这里按那个标记实际带着的
	 * 那几样重算，而不是往什么上都写一个线宽。文字的栏宽和高度跟着新字号一起缩放，否则按 15pt 量出来的框会
	 * 把 22pt 的字裁掉。
	 */
	const applyWeight = useCallback(
		(next: number) => {
			setWeight(next);
			if (width <= 0) return;
			restyle((shape) => {
				if (shape.tool === "text") {
					const size = typeAt(unit, next);
					const ratio = shape.size ? size / shape.size : 1;
					return {
						...shape,
						size,
						width: shape.width ? shape.width * ratio : shape.width,
						height: shape.height ? shape.height * ratio : shape.height,
					};
				}
				if (shape.tool === "mosaic") {
					return { ...shape, block: mosaicBlock(unit, next), brush: mosaicBrush(unit, next) };
				}
				// 标号是一个尺寸，不是一道线宽：它自己的半径，和另外两样设置保持同步。
				if (shape.tool === "step") return { ...shape, size: badgeAt(unit, next), stroke: strokeAt(unit, next) };
				return { ...shape, stroke: strokeAt(unit, next) };
			});
		},
		[restyle, width, unit],
	);

	/*
	 * 任何改动清单的操作都清掉选中。
	 *
	 * 选中是一个下标，下标只对取它的那张清单有意义。撤销之后清单就是另一张了：同一个下标是另一个标记，或者
	 * 什么都不是，选中框会画在用户没选的东西外面。清掉既是对的，也是每个编辑器的做法——撤销是把你放回去，
	 * 不是让你的手留在原处。
	 */
	const step = useCallback((change: (h: History) => History) => {
		setSelected(null);
		setHistory(change);
	}, []);

	return {
		tool,
		setTool: useCallback((next: Tool) => {
			// 换工具就是换话题：刚才选中的标记不再是手上在做的东西，留在它外面的框会比它的意义活得久。
			setSelected(null);
			setTool(next);
		}, []),
		colour,
		setColour: applyColour,
		backdrop,
		setBackdrop,
		weight,
		setWeight: applyWeight,
		undo: useCallback(() => step(undo), [step]),
		redo: useCallback(() => step(redo), [step]),
		clear: useCallback(() => step((h) => (current(h).length === 0 ? h : commit(h, []))), [step]),
		canUndo: canUndo(history),
		canRedo: canRedo(history),
		dirty: shapes.length > 0,
		selected,
		setSelected,
		// 两次普通调用，而不是一个套在另一个的 updater 里：updater 必须是纯的，因为 React 每次提交会跑它不止
		// 一遍。让一段文字提交了两次的就是这个坑，每次都值得老老实实写开。
		removeSelected: useCallback(() => {
			if (selected === null) return;
			setHistory((h) => {
				const list = current(h);
				return selected < list.length
					? commit(
							h,
							list.filter((_, i) => i !== selected),
						)
					: h;
			});
			setSelected(null);
		}, [selected]),
		nudge: useCallback((dx: number, dy: number) => restyle((shape) => moveShape(shape, dx * unit, dy * unit)), [restyle, unit]),
		render: useCallback(() => {
			const img = image.current;
			if (!img) return null;
			const out = document.createElement("canvas");
			out.width = img.width;
			out.height = img.height;
			// 用图片自己的色彩空间，和屏幕上那块画布同一个理由。
			const ctx = out.getContext("2d", { colorSpace });
			if (!ctx) return null;
			ctx.drawImage(img.source, 0, 0);
			paintAll(ctx, shapes, { stroke: strokeAt(unit, weight), mosaicSourceFor, block, brush: mosaicBrush(unit, weight) });
			// 画布上还画着别的源来的东西时，这里会抛错；由调用方去说。
			try {
				return out.toDataURL("image/png");
			} catch {
				return null;
			}
		}, [shapes, unit, weight, mosaicSourceFor, block, colorSpace]),
		flushText: useCallback(() => {
			const commit = pendingText.current;
			if (!commit) return false;
			commit();
			return true;
		}, []),
		pendingText,
		shapes,
		canvas,
		setHistory,
		image,
		mosaicSourceFor,
		ready,
		revision,
		colorSpace,
		width,
		block,
		unit,
		setUnit,
	};
}
