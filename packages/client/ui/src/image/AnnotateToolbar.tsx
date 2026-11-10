/**
 * 标注工具条：选工具、选颜色、选粗细，以及那几个一次性动作。
 *
 * 从 `Annotator.tsx` 拆出来的——那个文件本来就是三块：一个 hook、一块画布、一条工具条，只是三块住在
 * 一起。工具条这一块和另外两块之间只有四个符号来往，其中三个（`BACKDROPS`、`WEIGHT_LEVELS`，以及这里的
 * 一堆度量与图标表）本来就只有它自己用，跟着搬过来了；剩下 `COLOURS` 两边都用，留在原处导出。
 *
 * 工具条不能住在画布的父节点里：舞台为了缩放带着 transform，而 `position: fixed` 在一个被 transform 过的
 * 祖先里是相对那个祖先固定的。一个跟着图片一起放大、一起滑走的工具条，在 400% 下没法用。
 */

import type { MessageKey } from "../i18n/messages/index.ts";
import { translate } from "../i18n/translate.ts";
import {
	ArrowUpRight,
	Check,
	Delete,
	Circle,
	Download,
	Grid2x2,
	ListOrdered,
	Minus,
	Pencil,
	Pin,
	Redo2,
	Square,
	Trash2,
	Type,
	Undo2,
	X,
} from "../icons/index.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { macKeyboard, shortcutLabel, shortcutLetter } from "../keyboard.ts";

import type { Tool } from "./annotate.ts";
import { COLOURS, type Annotator } from "./Annotator.tsx";

/** 文字底下能垫什么。透明排第一，因为大多数文字什么都不要。 */
const BACKDROPS: [string | undefined, MessageKey][] = [
	[undefined, "annotate.transparent"],
	["#ffffffe6", "annotate.white"],
	["#111827e6", "annotate.black"],
	["#fde68ae6", "annotate.paleYellow"],
];

/** 标记和文字粗细的倍数，看图器和截图浮层都用。第三位是这一档在气泡里画成多大的点。 */
const WEIGHT_LEVELS: [number, MessageKey, number][] = [
	[0.6, "annotate.thin", 4],
	[1, "annotate.medium", 6],
	[1.8, "annotate.thick", 9],
];

const TOOLS: [Tool, typeof Pencil, MessageKey][] = [
	["pen", Pencil, "annotate.pen"],
	["arrow", ArrowUpRight, "annotate.arrow"],
	["line", Minus, "annotate.line"],
	["rect", Square, "annotate.rectangle"],
	["ellipse", Circle, "annotate.ellipse"],
	["step", ListOrdered, "annotate.step"],
	["text", Type, "annotate.text"],
	["mosaic", Grid2x2, "annotate.mosaic"],
];

/**
 * 尺寸控件在每种工具下调的是什么。
 *
 * 一直是同一个控件管着三样东西；只是它的名字从来只说了线。
 */
const SIZE_LABEL: Partial<Record<Tool, MessageKey>> = {
	text: "annotate.fontSize",
	mosaic: "annotate.mosaicSize",
	step: "annotate.stepSize",
};

const COLOUR_NAMES: Record<string, MessageKey> = {
	"#ef4444": "annotate.red",
	"#3b82f6": "annotate.blue",
	"#22c55e": "annotate.green",
	"#eab308": "annotate.yellow",
	"#111827": "annotate.black",
};

/**
 * 这条工具条有多大，放在一起是因为这些数彼此不独立：`step` 和 `inset` 决定某个工具的中心在这一排的
 * 什么位置，属性气泡就锚在那里。按钮变大了它们不跟着变，气泡就会指错工具。
 *
 * 到处都是 36pt 的按钮。原因在截图浮层：这条工具条浮在一张冻结的桌面上，四周没有窗口，位置随每次选区
 * 变化，而且是在**手还在动**的时候被瞄准的——刚拖完选区的那只手。这个平台上的截图工具都把这一排做在
 * 32–36pt 左右，正是这个原因；当初的反馈是「截图控件尺寸实在是太小了」，旁边附的是微信的截图，36。
 * 看图器曾经留着自己的一档 24pt 的 `compact`，后来它也要这一档，那张小表就没人用了。
 */
const METRICS = {
	bar: "gap-1 rounded-2xl px-2 py-1.5",
	button: "h-9 w-9 rounded-lg",
	icon: 18,
	divider: "mx-1.5 h-5",
	action: "h-9 px-2.5",
	confirm: "h-9 w-9",
	// 36pt 的按钮加 4pt 间距，第一个按钮自己的半宽之前还有 8pt 内边距。
	step: 40,
	inset: 26,
	bubble: "gap-1.5 rounded-xl px-2.5 py-1.5",
	weight: "h-7 w-7",
	swatch: "h-[18px] w-[18px]",
	bubbleDivider: "mx-1 h-4",
};

/**
 * 在按钮上按住多久，算「我要挪这条工具栏」而不是「我要按这个按钮」。
 *
 * 320ms：比一次利落的点击长得多（那是 80–150ms），又短到按下去等一等就有反应，不至于让人以为
 * 按住不管用。跟系统里长按呼出菜单的那个数是一个量级。
 */
const HOLD_TO_DRAG_MS = 320;
/** 按住期间手抖几个像素还算没动。超过就是在往别的按钮上蹭，那一下仍然是点击。 */
const HOLD_SLOP = 4;

/**
 * 工具条自己的样子。它站在哪是持有它的一方的事：两个调用方都用自己的一个盒子装着它、摆那个盒子——截图浮层
 * 摆在选区旁边，看图器摆在被拖到的地方。
 *
 * 这里只能有一个类设置 `position`。一串类名里放两个，哪个生效取决于 Tailwind 输出它们的顺序，而不是写的
 * 顺序。曾经一个多出来的 `relative` 挨着 `fixed`，让本该浮着的工具条留在了文档流里，成了看图器 flex 舞台里
 * 的第二个元素：图被挤出窗口 113px，工具条被裁掉了。
 */
const BAR_SURFACE =
	"pointer-events-auto relative flex items-center border plume-image-glass shadow-overlay backdrop-blur-xl transition-[opacity,transform] duration-[var(--plume-t-base)] ease-out";

export function AnnotateToolbar({
	annotator,
	onCancel,
	onSave,
	onPin,
	onDownload,
	onGrab,
	grabbing = false,
	canReplace,
	delivers = false,
	saveLabel,
	cancelLabel,
	requireDirty = true,
	style,
	propertiesSide = "above",
}: {
	annotator: Annotator;
	onCancel: () => void;
	onSave: () => void;
	/**
	 * 把这张图留在桌面上、浮在一切之上，而不是交出去。
	 *
	 * 只在有意义的地方给——截图浮层——因为把一张已经开在窗口里的图的一块置顶，是给正在看的东西复制一份。
	 */
	onPin?: () => void;
	/** 把这张图写进下载目录。理由同 `onPin`。 */
	onDownload?: () => void;
	/**
	 * 这一条要挪窝了：从哪儿按下的，按下时它在哪儿。
	 *
	 * 挪到哪儿是调用方的事——它飘在一张截好的屏幕上，得留在屏幕里——所以这里只说「开始了」，外加
	 * 两个位置。带上 `origin` 而不是让调用方自己去 DOM 里量：这一条的位置只有它自己最清楚，而且
	 * 按住按钮触发的那一次是从定时器里发出的，那会儿 React 的合成事件早就没有 `currentTarget` 了。
	 *
	 * 不传就是不能挪。
	 */
	onGrab?: (grab: { from: { x: number; y: number }; origin: { x: number; y: number } }) => void;
	/** 正在挪，好让整条和它上面每个控件都显示同一个光标。 */
	grabbing?: boolean;
	/**
	 * 当前工具的属性气泡往哪边开，以这条工具条为准。
	 *
	 * `above` 开在工具条上面，`below` 开在下面。由调用方决定，因为只有调用方知道工具条摆在被标注的东西的
	 * 哪一边：气泡得往远离它的方向开，否则就把它盖住了。默认 `above`，看图器就是这样——工具条一开始贴着
	 * 舞台底边。
	 */
	propertiesSide?: "above" | "below";
	/** 保存能不能替换原图，还是只能另出一份副本。 */
	canReplace: boolean;
	/**
	 * 副本是交出去接着用，而不是导出。
	 *
	 * 对话里的一张图被标注，是为了让它照着重画，所以副本进那个对话的输入框：按钮是带勾的「完成」，而不是
	 * 一个下载箭头，许诺一个谁也没要的文件。
	 */
	delivers?: boolean;
	/** 覆盖保存按钮上的字。不传就按 `canReplace` 的意思说。 */
	saveLabel?: string;
	cancelLabel?: string;
	/**
	 * 保存是不是要求先画过东西。
	 *
	 * 对一张已经存在的图是 true——保存一份没动过的副本只会多出一个一模一样的文件，所以在有东西可存之前
	 * 按钮是死的。对截图浮层是 false：那个按钮就是确认这次截图的方式，而一块没有标注的区域是最常见的需求。
	 */
	requireDirty?: boolean;
	style?: React.CSSProperties;
}) {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		// 晚一帧，好让过渡有个起点可以离开。
		const id = requestAnimationFrame(() => setShown(true));
		return () => cancelAnimationFrame(id);
	}, []);

	const bar = useRef<HTMLDivElement | null>(null);
	/** 按住计时中的那一次，连同它按在哪儿——手挪出去就作废。 */
	const holding = useRef<{ from: { x: number; y: number }; timer: ReturnType<typeof setTimeout> } | null>(null);
	/** 这一次按下已经变成了挪窝，那么随之而来的那个 click 不作数。 */
	const dragged = useRef(false);

	const endHold = useCallback(() => {
		if (holding.current) clearTimeout(holding.current.timer);
		holding.current = null;
	}, []);
	useEffect(() => endHold, [endHold]);

	const beginDrag = useCallback(
		(from: { x: number; y: number }) => {
			const box = bar.current?.getBoundingClientRect();
			if (!box || !onGrab) return;
			dragged.current = true;
			onGrab({ from, origin: { x: box.left, y: box.top } });
		},
		[onGrab],
	);

	// 撤销、重做、删除走键盘，画画的人第一个伸手去够的就是那里。
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			// 写文字的时候绝不：那里 ⌘Z 归输入框，退格就是退格。一个把正写到一半的标记删掉的快捷键，比没有
			// 快捷键更糟。
			if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;

			const letter = shortcutLetter(event);
			if ((event.metaKey || event.ctrlKey) && letter === "z") {
				event.preventDefault();
				if (event.shiftKey) annotator.redo();
				else annotator.undo();
				return;
			}
			// Windows 和 Linux 上 Ctrl+Y 是重做。Mac 上不是 ⌘Y，那里重做只有 ⇧⌘Z。
			if (!macKeyboard() && event.ctrlKey && !event.shiftKey && !event.altKey && letter === "y") {
				event.preventDefault();
				annotator.redo();
				return;
			}

			if ((event.key === "Backspace" || event.key === "Delete") && annotator.selected !== null) {
				// 在有些环境下退格是浏览器的「后退」；把它拿过来正是目的。
				event.preventDefault();
				annotator.removeSelected();
			}

			// 方向键一次挪选中的标记一个点，按住 Shift 十个：放置的最后那几个点，正是握着鼠标的手做不到的。
			const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
			if (nudge && annotator.selected !== null && !event.metaKey && !event.ctrlKey && !event.altKey) {
				event.preventDefault();
				const step = event.shiftKey ? 10 : 1;
				annotator.nudge(nudge[0]! * step, nudge[1]! * step);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [annotator]);

	return (
		<div
			/*
			 * 拖动时，它上面的每个控件也一样。
			 *
			 * 工具条跟着指针走，所以整个拖动过程中指针都**在工具条上**——在按钮上，而每个按钮都有自己的光标。
			 * 没有那条后代规则的话，握紧的手只在抓手上出现一帧，之后整个手势都被箭头替掉，读起来像是拖动断了。
			 */
			ref={bar}
			/*
			 * 整条都能拿起来，光标一直这么说着。
			 *
			 * 之前是行首一个竖点手柄，只有那 8pt 宽的一小条能拖。它有两处不对：得先看见它、再瞄准
			 * 它，而这条工具栏本身就是浮在别人屏幕上的临时东西，没有窗口标题栏那样的位置约定；而且
			 * 它在一排按钮的最前面，本身就是这排按钮里的一个「洞」。
			 *
			 * 现在按钮之外的地方按下就能拖，光标从进来那一刻就说得清楚。按钮上按住不放也能拖——
			 * 见 `HOLD_TO_DRAG_MS`——因为这条几乎全是按钮，只留缝隙可拖等于还是要瞄准。
			 */
			className={`${BAR_SURFACE} ${METRICS.bar} ${grabbing ? "cursor-grabbing [&_*]:cursor-grabbing" : onGrab ? "cursor-grab" : ""}`}
			style={{
				opacity: shown ? 1 : 0,
				...style,
			}}
			/*
			 * 工具条从不把焦点从正在打的字上抢走。
			 *
			 * 文字在它的输入框失焦时提交，而按这里的一个按钮就足以让它失焦——于是伸手去选大一号的字，结束的是
			 * 这段文字而不是改它的大小，下一下又在别处开了一段新的。在 `mousedown` 上阻止默认行为就是不让焦点
			 * 移走；click 照样触发，所以每个控件都和原来一样工作，只是输入框之后还在，新的大小当场就用在它上面。
			 */
			onMouseDown={(event) => event.preventDefault()}
			onPointerDown={(event) => {
				if (!onGrab || event.button !== 0) return;
				const target = event.target as HTMLElement;
				// 气泡飘在这一条外面，只是 DOM 上挂在里面。调粗细不该把整条带走。
				if (target.closest?.("[data-toolbar-bubble]")) return;
				const from = { x: event.clientX, y: event.clientY };
				if (!target.closest?.("button, input, textarea, select, a")) {
					// 空白处：按下就是要挪它，没有第二种解释。
					event.preventDefault();
					beginDrag(from);
					return;
				}
				/*
				 * 按在按钮上：先当成要按它，按住不放才改主意。
				 *
				 * 反过来（按下即拖、松开算点击）也能实现，代价是每一次点击都先动一下——按钮在手指
				 * 底下抖，这条工具栏上的每一个操作都会变得不确定。
				 */
				endHold();
				holding.current = {
					from,
					timer: setTimeout(() => {
						holding.current = null;
						beginDrag(from);
					}, HOLD_TO_DRAG_MS),
				};
			}}
			onPointerMove={(event) => {
				const held = holding.current;
				if (!held) return;
				// 手挪开了就不是「按住」，是在往某个按钮上蹭——那一下仍然该是点击。
				if (Math.abs(event.clientX - held.from.x) > HOLD_SLOP || Math.abs(event.clientY - held.from.y) > HOLD_SLOP) endHold();
			}}
			onPointerUp={endHold}
			onPointerCancel={endHold}
			onPointerLeave={endHold}
			/*
			 * 挪完之后那一下 click 要吞掉。
			 *
			 * 按住一个按钮把整条拖走，松手时浏览器照样会在这条上派发一次 click——那正是刚才被按住
			 * 的那个按钮。不吞掉的话，「把工具栏从要标注的地方挪开」会顺手切一次工具，或者更糟，
			 * 按到「完成」把整个截图交出去。
			 */
			onClickCapture={(event) => {
				if (!dragged.current) return;
				dragged.current = false;
				event.preventDefault();
				event.stopPropagation();
			}}
		>
			{/*
			 * 手里那个工具的属性，放在这一排的上方而不是里面。
			 *
			 * 把每个工具的每个属性摆成一行，是这条工具条宽得像一块笔记本屏幕的原因——而且任何时候大半都不起作用：
			 * 颜色对马赛克没用，底色对箭头没用。提到一个指着所属工具的气泡里，这一排就只剩工具，屏幕上的也只有
			 * 当前工具真正有的东西。
			 */}
			<ToolProperties annotator={annotator} index={TOOLS.findIndex(([id]) => id === annotator.tool)} side={propertiesSide} />

			{/*
			 * 行首曾经有一个竖点手柄，现在没有了。
			 *
			 * 它占着一排按钮的头一格，本身却不是按钮——一排控件里的一个洞，第一次看到的人得先弄明白
			 * 那是什么。而它换来的能力，现在整条都有：按钮之外按下就能拖，按钮上按住不放也能拖。
			 * 少一格，这一条还窄了 20pt，在一块框得很小的区域旁边，那 20pt 是看得出来的。
			 */}
			{TOOLS.map(([id, Icon, label], at) => (
				<ToolButton key={id} toolIndex={at} label={translate(label)} active={annotator.tool === id} onClick={() => annotator.setTool(id)}>
					<Icon size={METRICS.icon} strokeWidth={1.9} />
				</ToolButton>
			))}

			<Divider />

			<ToolButton label={translate("annotate.undo")} disabled={!annotator.canUndo} onClick={annotator.undo}>
				<Undo2 size={METRICS.icon} strokeWidth={1.9} />
			</ToolButton>
			<ToolButton label={translate("annotate.redo")} disabled={!annotator.canRedo} onClick={annotator.redo}>
				<Redo2 size={METRICS.icon} strokeWidth={1.9} />
			</ToolButton>
			{/*
			 * 删除选中的标记，放在选中的标记不在的地方。
			 *
			 * 只在有东西选中时出现，挨着其余那些作用于整幅画的动作。它是出现，而不是变灰，这样这一排大部分时候
			 * 不带一个死控件。
			 */}
			{annotator.selected !== null && (
				<span className="flex animate-[plume-tool-in_var(--plume-t-base)_ease-out]">
					<ToolButton label={translate("annotate.deleteSelected")} onClick={annotator.removeSelected}>
						<Delete size={METRICS.icon} strokeWidth={1.9} />
					</ToolButton>
				</span>
			)}
			<ToolButton label={translate("annotate.clear")} disabled={!annotator.dirty} onClick={annotator.clear}>
				<Trash2 size={METRICS.icon} strokeWidth={1.9} />
			</ToolButton>

			{/*
			 * 两条不是「交给应用」的出路，自成一组。
			 *
			 * 两个都结束这次截图，也都不把它交给应用，所以它们在绘图工具和确认按钮之间单成一组：置顶把图留在
			 * 桌面上看，下载把图留在文件夹里存。只在有意义的地方出现——看图器里的这条工具条两个都没有。
			 */}
			{(onPin || onDownload) && <Divider />}
			{onPin && (
				<ToolButton label={translate("annotate.pinToDesktop")} onClick={onPin}>
					<Pin size={METRICS.icon} strokeWidth={1.9} />
				</ToolButton>
			)}
			{onDownload && (
				<ToolButton label={translate("annotate.download")} onClick={onDownload}>
					<Download size={METRICS.icon} strokeWidth={1.9} />
				</ToolButton>
			)}

			<Divider />

			<button
				type="button"
				data-plume-tip={cancelLabel ?? translate("annotate.exit")}
				data-plume-tip-side="top"
				aria-label={cancelLabel ?? translate("annotate.exit")}
				onClick={onCancel}
				className={`flex cursor-pointer items-center rounded-lg plume-image-quiet transition-colors duration-[var(--plume-t-quick)] ${METRICS.action}`}
			>
				<X size={METRICS.icon - 1} strokeWidth={2} />
			</button>
			<button
				type="button"
				data-plume-tip={saveLabel ?? translate(canReplace ? "annotate.saveOver" : delivers ? "annotate.doneTip" : "annotate.saveCopyTip")}
				data-plume-tip-side="top"
				disabled={requireDirty && !annotator.dirty}
				onClick={onSave}
				// 用 `whitespace-nowrap` 是因为字有四个、按钮靠内边距撑开：没有它，「保存副本」折成两行，把整条的
				// 高度也一起带了上去。
				aria-label={saveLabel ?? translate(canReplace ? "common.save" : delivers ? "common.done" : "annotate.saveCopy")}
				className={`grid cursor-pointer place-items-center rounded-lg plume-image-confirm transition-opacity duration-[var(--plume-t-quick)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35 ${METRICS.confirm}`}
			>
				{/* 存文件归单独的下载按钮；确认一次截图不能再许诺一次下载。 */}
				{canReplace || onDownload || delivers ? (
					<Check size={METRICS.icon - 1} strokeWidth={2.4} aria-hidden />
				) : (
					<Download size={METRICS.icon - 1} strokeWidth={2} aria-hidden />
				)}
			</button>
		</div>
	);
}

/** 用 `mx-1.5` 而不是 `mx-1`：挨着分隔线的色块带着一圈环，要留出地方。 */
const Divider = () => <span className={`w-px shrink-0 plume-image-rule ${METRICS.divider}`} />;

/**
 * 当前手里那个工具的属性，放在一个指着它的气泡里。
 *
 * 把它们从这一排里提出来有两个好处。这一排不再是每个工具每个属性的目录——那是它宽到跑出屏幕边的原因——
 * 每个工具也只显示它真正有的东西：马赛克取的是底下的图，没有自己的颜色；箭头没有底色。一个影响不到手里
 * 东西的控件比没有更糟，因为它读起来是一个工具不会兑现的许诺。
 *
 * 锚在工具自己的按钮上而不是居中，这样「在配哪个工具」由气泡的位置回答；再夹一下，不让它悬出工具条的
 * 两端。
 */
function ToolProperties({ annotator, index, side }: { annotator: Annotator; index: number; side: "above" | "below" }) {
	const isText = annotator.tool === "text";
	// 马赛克是唯一没有自己颜色的工具——它用的是图的颜色。
	const hasColour = annotator.tool !== "mosaic";

	/*
	 * 所属的那个工具实际在哪，量出来而不是算出来。
	 *
	 * 原先是 `index * 26 + 18`——按钮宽加间距，再加工具条的内边距——这道算术是把布局在第二个地方抄了一份。
	 * 它早就落后了一档：工具前面有一个拖动手柄的工具条，每个按钮都往后挪了手柄那么宽，于是尾巴指着手里那个
	 * 工具的前一个，只在截图浮层的工具条上这样。以后加在这一排开头的每个控件都会这样。
	 *
	 * 公式留作第一帧的值，因为 `useLayoutEffect` 在这次渲染之后才跑，一个先出现在 0 再跳过去的气泡，比第一帧
	 * 差几个点的更糟。
	 */
	const box = useRef<HTMLDivElement | null>(null);
	const [anchor, setAnchor] = useState(Math.max(0, index) * METRICS.step + METRICS.inset);
	useLayoutEffect(() => {
		const bar = box.current?.offsetParent as HTMLElement | null;
		const button = bar?.querySelector<HTMLElement>(`[data-tool-index="${index}"]`);
		if (!button) return;
		setAnchor(button.offsetLeft + button.offsetWidth / 2);
	}, [index, annotator.selected]);

	/*
	 * 留在窗口里，尾巴仍然指着它的按钮。
	 *
	 * 以第一个工具为中心时，气泡本来就悬出了工具条的左端；工具条能被拖到窗口边以后，它有一半悬到了窗口外面，
	 * 连同那几个颜色。每次渲染之后都量，而不是按依赖列表，因为挪动它的是工具条被拖着走，这个组件不会被告知
	 * 这件事——它只是被重新渲染。
	 */
	const [shift, setShift] = useState(0);
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- 故意每次渲染后都量（工具条被挪动时不会通知这里）；只在偏移差超过半个点时才设，一轮就稳定
	useLayoutEffect(() => {
		const el = box.current;
		const bar = el?.offsetParent;
		if (!el || !bar) return;
		const width = el.getBoundingClientRect().width;
		if (!width) return;
		// 不偏移时它会在哪，从工具条和锚点算——不从它自己的矩形算，那里已经带着偏移，会把偏移再喂回自己。
		const left = bar.getBoundingClientRect().left + anchor - width / 2;
		const margin = 8;
		const next = left < margin ? margin - left : left + width > window.innerWidth - margin ? window.innerWidth - margin - (left + width) : 0;
		if (Math.abs(next - shift) > 0.5) setShift(next);
	});

	return (
		<div
			/*
			 * 往远离选区的方向开，而不是总往上。
			 *
			 * 只要放得下，工具条本身就在选区下面，于是钉在 `bottom-full` 的气泡开进了两者之间的缝里——盖在正要
			 * 标注的那块区域的底部。哪边是「远离」只有摆工具条的地方知道，所以传进来：`below` 表示工具条在选区
			 * 下面、气泡再往下开，`above` 表示它在上面、气泡再往上开。
			 */
			ref={box}
			/*
			 * 标出来，好让工具栏的按住拖拽把这一片排除在外。
			 *
			 * 气泡在 DOM 上是工具栏的孩子、在屏幕上却飘在它外面。工具栏空白处按下就能拖，气泡里的
			 * 空白（按钮之间那几个像素）如果也算数，调粗细时手一沉整条工具栏就跟着走了。
			 */
			data-toolbar-bubble
			className={`absolute left-0 flex cursor-default animate-[plume-tool-in_var(--plume-t-base)_ease-out] items-center border plume-image-bubble shadow-overlay backdrop-blur-xl ${METRICS.bubble} ${
				side === "below" ? "top-full mt-2" : "bottom-full mb-2"
			}`}
			/*
			 * 用 `translate` 居中，不用 `transform`。
			 *
			 * 入场关键帧动的是 `transform`，而动画运行期间优先级高于行内样式：头 220ms 气泡往右偏着自己半个宽，
			 * 尾巴指着错的按钮，动画一结束又跳回来。单独的属性会和被动画的那个叠加，而不是被它替掉。
			 */
			style={{ left: anchor + shift, translate: "-50% 0" }}
		>
			{/*
			 * 「细中粗」三个字换成三个大小不同的点。
			 *
			 * 每一档的直径早就在 `WEIGHT_LEVELS` 的第三位上了，只是一直没人用——它本来就是为这个
			 * 准备的。画粗细的控件用字说粗细，本身是绕了一圈：点的大小就是这一档画出来的线的
			 * 粗细，看一眼就知道，而「中」和「粗」哪个更粗要想一下。
			 */}
			{WEIGHT_LEVELS.map(([value, label, dot]) => (
				<button
					key={label}
					type="button"
					onClick={() => annotator.setWeight(value)}
					data-plume-tip={translate(label)}
					aria-label={translate("annotate.sizeIs", {
						what: translate(SIZE_LABEL[annotator.tool] ?? "annotate.weight"),
						label: translate(label),
					})}
					aria-pressed={annotator.weight === value}
					className={`flex cursor-pointer items-center justify-center rounded-md transition-colors ${METRICS.weight} ${
						annotator.weight === value ? "plume-image-weight plume-image-weight-on" : "plume-image-weight"
					}`}
				>
					<span aria-hidden className="rounded-full bg-current" style={{ width: dot, height: dot }} />
				</button>
			))}

			{hasColour && <span className={`w-px shrink-0 plume-image-rule ${METRICS.bubbleDivider}`} />}

			{hasColour &&
				COLOURS.map((value) => (
					<button
						key={value}
						type="button"
						aria-label={COLOUR_NAMES[value] ? translate(COLOUR_NAMES[value]) : value}
						aria-pressed={annotator.colour === value}
						onClick={() => annotator.setColour(value)}
						style={{ background: value }}
						className={`shrink-0 cursor-pointer rounded-full transition-transform duration-[var(--plume-t-quick)] ${METRICS.swatch} ${
							annotator.colour === value ? "scale-110 plume-image-swatch-on" : "opacity-80 hover:scale-110 hover:opacity-100"
						}`}
					/>
				))}

			{/* 只有文字能垫一块底，别的都不能，所以别的都不给。 */}
			{isText && <span className={`w-px shrink-0 plume-image-rule ${METRICS.bubbleDivider}`} />}
			{isText &&
				BACKDROPS.map(([value, label]) => (
					<button
						key={label}
						type="button"
						aria-label={translate("annotate.textBackground", { label: translate(label) })}
						aria-pressed={annotator.backdrop === value}
						onClick={() => annotator.setBackdrop(value)}
						style={value ? { background: value } : undefined}
						className={`shrink-0 cursor-pointer rounded-sm transition-transform duration-[var(--plume-t-quick)] ${METRICS.swatch} ${
							value ? "" : "plume-image-checker"
						} ${annotator.backdrop === value ? "scale-110 plume-image-swatch-on" : "opacity-80 hover:scale-110 hover:opacity-100"}`}
					/>
				))}

			{/*
			 * 那个小尖角——它让这个气泡成为某个按钮的气泡，而不是第二排。开在工具条哪一边，它就在哪一边。
			 *
			 * 它存在是为了说明气泡属于哪个按钮，原先却不管气泡往哪开，都钉在底边、朝下指。气泡会翻：工具条在
			 * 区域下面时，气泡开在**工具条下面**，底边上的尖角指着的是空屏幕——当初的反馈里是程序坞——而它所属
			 * 的按钮在它上面。
			 *
			 * 一个方块转 45°、留下其中两条边，就成了尖；留哪两条决定它朝哪边。
			 */}
			<span
				className={`absolute h-2 w-2 -translate-x-1/2 rotate-45 plume-image-bubble ${
					side === "below" ? "-top-1 border-t border-l" : "-bottom-1 border-r border-b"
				}`}
				style={{ left: `calc(50% - ${shift}px)` }}
			/>
		</div>
	);
}

function ToolButton({
	label,
	active,
	disabled,
	onClick,
	toolIndex,
	children,
}: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	/** 这是哪个绘图工具，好让属性气泡找到它、指着它。 */
	toolIndex?: number;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-plume-tip={label}
			data-tool-index={toolIndex}
			// 朝上：工具条在窗口底部，往下开的提示会出屏幕，反正也会被翻上来。直接这么说就省了那次翻转。
			data-plume-tip-side="top"
			// 悬停提示在显示时会转换 ⌘；无障碍名是直接从这里读的。
			aria-label={shortcutLabel(label)}
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
			className={`flex cursor-pointer items-center justify-center transition-colors duration-[var(--plume-t-quick)] disabled:cursor-not-allowed disabled:opacity-30 ${METRICS.button} ${
				active ? "plume-image-tool plume-image-tool-on" : "plume-image-tool"
			}`}
		>
			{children}
		</button>
	);
}
