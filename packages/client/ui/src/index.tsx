/**
 * 基础组件。产品界面和插件共用，渲染进程经 import map 把同一份实例给插件。
 * 卡片外框、代码块、diff 视图在这个文件里；其余的通用组件按目录分：
 * primitives（按钮、标签条……）、inputs（输入框、选择框）、overlay（弹层、对话框、菜单、悬停提示）、
 * scroll、layout、motion、avatar，以及 lib 里它们共用的函数。图标走 `@plume/ui/icons`。
 * 类名都来自 @plume/styles 和 @plume/styles/ui.css，插件用这些组件不用自己带样式。
 */

import { card, code } from "@plume/styles";
import { type ReactNode, useRef } from "react";
import { OverlayScrollbar } from "./scroll/OverlayScrollbar.tsx";

export { I18nProvider, useI18n } from "./i18n/context.tsx";
export { formatList } from "./i18n/list.ts";
export { LOCALE_OPTIONS, type UiLocale } from "./i18n/locales.ts";
export type { MessageKey, ResolvedUiLocale } from "./i18n/messages/index.ts";
export { activeLocale, translate } from "./i18n/translate.ts";

export * from "./avatar/AgentAvatar.tsx";
export * from "./avatar/AvatarPile.tsx";
export * from "./avatar/AvatarStack.tsx";
export * from "./avatar/art.ts";
export * from "./fileIcon.tsx";
export * from "./hooks/useCopied.ts";
export * from "./hooks/useLiveRefresh.ts";
export * from "./hooks/useNarrow.ts";
export * from "./inputs/ComposerToggle.tsx";
export * from "./inputs/DateRangeField.tsx";
export * from "./inputs/NativeField.tsx";
export * from "./inputs/pickers.tsx";
export * from "./inputs/SearchField.tsx";
export * from "./inputs/Segmented.tsx";
export * from "./inputs/Select.tsx";
export * from "./inputs/TextArea.tsx";
export * from "./inputs/ShortcutRecorder.tsx";
export * from "./inputs/Toggle.tsx";
export * from "./inputs/WorktreeToggle.tsx";
export * from "./inputs/day-range.ts";
export * from "./inputs/useFieldFade.ts";
export * from "./keyboard.ts";
export * from "./layout/ApprovalFrame.tsx";
export * from "./layout/Collapse.tsx";
export * from "./layout/CopyMark.tsx";
export * from "./layout/Disclosure.tsx";
export * from "./layout/ErrorBoundary.tsx";
export * from "./layout/PageTopRow.tsx";
export * from "./layout/PanelEmpty.tsx";
export * from "./layout/ResizeHandle.tsx";
export * from "./layout/Settings.tsx";
export * from "./layout/RetainedViews.tsx";
export * from "./layout/Splitter.tsx";
export * from "./lib/agent-avatar.ts";
export * from "./lib/code/font-stack.ts";
export * from "./lib/code/themes.ts";
export * from "./lib/date-format.ts";
export * from "./lib/dispatches.ts";
export * from "./lib/hour-style.ts";
export * from "./lib/number-draft.ts";
export * from "./lib/relative-time.ts";
export * from "./lib/tiling.ts";
export * from "./lib/typing.ts";
export * from "./motion/RollWords.tsx";
export * from "./motion/RollingText.tsx";
export * from "./motion/TypedText.tsx";
export * from "./motion/freeze.ts";
export * from "./motion/held.ts";
export * from "./motion/loaders.tsx";
export * from "./motion/reduced.ts";
export * from "./motion/ticked.ts";
export * from "./motion/ticker.ts";
export * from "./motion/tokens.ts";
export * from "./motion/useNow.ts";
export * from "./overlay/Confirm.tsx";
export * from "./overlay/ContextMenu.tsx";
export * from "./overlay/Dialog.tsx";
export * from "./overlay/Menu.tsx";
export * from "./overlay/Overlay.tsx";
export * from "./overlay/Popover.tsx";
export * from "./overlay/Tooltip.tsx";
export * from "./overlay/chrome-top.ts";
export * from "./overlay/hover-layers.ts";
export * from "./overlay/portal.ts";
export * from "./overlay/scrims.ts";
export * from "./overlay/tooltip-attribute.ts";
export * from "./primitives/Button.tsx";
export * from "./primitives/Caret.tsx";
export * from "./primitives/ChoiceMark.tsx";
export * from "./primitives/ClosableTab.tsx";
export * from "./primitives/CountUp.tsx";
export * from "./primitives/GitHubMark.tsx";
export * from "./primitives/IconButton.tsx";
export * from "./primitives/MarkNumber.tsx";
export * from "./primitives/RowDeleteButton.tsx";
export * from "./primitives/Skeleton.tsx";
export * from "./primitives/TabStrip.tsx";
export * from "./primitives/Text.tsx";
export * from "./primitives/TimeAgo.tsx";
export * from "./primitives/useCountUp.ts";
export * from "./row/FlowRow.tsx";
export * from "./row/HoverRow.tsx";
export * from "./scroll/BackToLatest.tsx";
export * from "./scroll/OverlayScrollbar.tsx";
export * from "./scroll/ScrollText.tsx";
export * from "./scroll/Scroller.tsx";
export * from "./scroll/Sideways.tsx";
export * from "./scroll/fade.ts";
export * from "./scroll/follow.ts";
export * from "./scroll/measure-batch.ts";
export * from "./scroll/memory.ts";
export * from "./scroll/signature.ts";
export * from "./scroll/useFollowBottom.ts";
export * from "./scroll/useSideways.ts";
// 图片标注：看图器和截图浮层共用。逐个导出，`annotate.ts` 里 `current`、`commit` 这类泛称和两处同名的 `Point` 不进公共名字空间。
export { clampZoom, wheelZoomFactor, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, zoomAt, type Shape, type Tool } from "./image/annotate.ts";
export { COLOURS, useAnnotator, type Annotator, type AnnotatorOptions, type RawPixels } from "./image/Annotator.tsx";
export { AnnotateCanvas, STAGE_FIT } from "./image/AnnotateCanvas.tsx";
export { AnnotateToolbar } from "./image/AnnotateToolbar.tsx";
export {
	clampRect,
	clampToolbar,
	HANDLE_CURSOR,
	HANDLES,
	handlePoint,
	hitHandle,
	insideRect,
	moveRect,
	rectFromPoints,
	resizeRect,
	toolbarPosition,
	type Handle,
	type Point,
	type Rect,
} from "./image/screenshot-geometry.ts";
export { useBarDrag, type BarSize } from "./image/useBarDrag.ts";
export { useMovableBar, type MovableBar } from "./image/useMovableBar.ts";
export { useToolbarPlacement, type ToolbarPlacement } from "./image/useToolbarPlacement.ts";

export interface CardProps {
	title: ReactNode;
	/** 标题右边的简短说明，单行，超出省略。 */
	subtitle?: ReactNode;
	/** 右上角的状态文字。 */
	status?: ReactNode;
	tone?: "default" | "error" | "warning";
	children?: ReactNode;
}

export function Card({ title, subtitle, status, tone = "default", children }: CardProps) {
	return (
		<div className={`${card.frame} ${card.tone[tone].frame}`}>
			<div className={`${card.head} ${card.tone[tone].head}`}>
				<span className={card.title}>{title}</span>
				{subtitle !== undefined && <code className={card.subtitle}>{subtitle}</code>}
				{status !== undefined && <span className={card.status}>{status}</span>}
			</div>
			{children !== undefined && <div className={card.body}>{children}</div>}
		</div>
	);
}

/**
 * 代码块和 diff 自己会竖着滚（`max-h-72`），原生滚动条全局关掉了，滑块由 `OverlayScrollbar` 画在 `<pre>` 上。
 */
function ScrollingPre({ className, children }: { className: string; children: ReactNode }) {
	const pre = useRef<HTMLPreElement>(null);
	return (
		<div className="plume-scroll-host relative">
			<pre ref={pre} className={className}>
				{children}
			</pre>
			<OverlayScrollbar viewport={pre} orientation="vertical" />
		</div>
	);
}

export function CodeBlock({ children }: { children: string }) {
	return <ScrollingPre className={code.block}>{children}</ScrollingPre>;
}

type DiffLine = { kind: "same" | "add" | "remove"; text: string };

/** 按行比较。用 LCS，够看小段改动；大文件的 diff 不在这里做。 */
export function diffLines(before: string, after: string): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	const lcs = Array.from({ length: a.length + 1 }, () => Array.from<number>({ length: b.length + 1 }).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			const row = lcs[i] as number[];
			row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			lines.push({ kind: "same", text: a[i++] as string });
			j++;
		} else if (i < a.length && (j >= b.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
			// 两边一样长时先删后加，和常见 diff 的顺序一致。
			lines.push({ kind: "remove", text: a[i++] as string });
		} else {
			lines.push({ kind: "add", text: b[j++] as string });
		}
	}
	return lines;
}

const MARKS = { same: " ", add: "+", remove: "-" };

export function DiffView({ before, after }: { before: string; after: string }) {
	return (
		<ScrollingPre className={code.diff}>
			{diffLines(before, after).map((line, index) => (
				<div key={index} data-diff={line.kind} className={`${code.diffLine} ${code.diffKind[line.kind]}`}>
					{MARKS[line.kind]} {line.text}
				</div>
			))}
		</ScrollingPre>
	);
}

export * from "./inputs/ColorField.tsx";
export * from "./inputs/Slider.tsx";
