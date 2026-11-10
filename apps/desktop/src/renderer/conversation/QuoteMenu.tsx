/**
 * 在对话里划一段字，拿去侧边聊天问，或者引用到下面的输入框里接着说。
 *
 * 只是把引文挂到输入框上（框上方那枚引用，见 `QuoteChip`）、光标停在框里，不替人发出去：划下来的是材料，问什么还得人自己说。
 * 字在松开鼠标那一刻就取好了——正在写的那条回复下一帧可能又长了一截，点下去时再读选区，拿到的会是另一段。
 */

import type { QuoteAction } from "@plume/contract/ui";
import { Popover, useI18n } from "@plume/ui";
import { Fragment, memo, type RefObject, useEffect, useState } from "react";
import { localized } from "../plugins.tsx";
import { notify } from "../toast/index.ts";
import { type DraftQuote, quotedIn, selectedBounds } from "./quote.ts";

/** 双击之后等第三下的时间：macOS 默认的双击间隔上下。浏览器读不到系统的实际设置。 */
const DOUBLE_CLICK_WAIT = 400;

interface Picked {
	text: string;
	from: DraftQuote["from"];
	range: Range;
	/**
	 * 菜单挂在选区上，不挂鼠标：`x` 是选区的横中线，`y` 是它的上沿。挂鼠标那一点的话，同一次划选从左往右划和从右往左划，
	 * 菜单会落在两个地方。上面放不下时 `Popover` 自己翻到下面去。
	 */
	at: { x: number; y: number };
}

function atOf(range: Range): Picked["at"] {
	const rect = selectedBounds(range);
	return { x: rect.left + rect.width / 2, y: rect.top };
}

// 按 props 记住：它和转录挂在同一个组件里，转录流式输出时每一拍都重画。`onQuote` 要稳定。
export const QuoteMenu = memo(function QuoteMenu({
	scrollRef,
	onQuote,
	sessionId,
	actions,
}: {
	scrollRef: RefObject<HTMLDivElement | null>;
	onQuote: (quote: DraftQuote) => void;
	sessionId?: string;
	actions?: readonly QuoteAction[];
}) {
	const { t, resolvedLocale } = useI18n();
	const [picked, setPicked] = useState<Picked | null>(null);

	useEffect(() => {
		const box = scrollRef.current;
		if (!box) return;
		/*
		 * 双击松开时还不知道人要的是这个词，还是接着点第三下选整段。立刻弹的话，第三下按下去先把菜单收了、松开又在整段上弹一次，
		 * 一次三击闪两回。所以双击先等一个双击间隔，期间再按下就作废，由那一下的松开来定。
		 */
		let waiting = 0;
		const onDown = () => window.clearTimeout(waiting);
		const onUp = (event: MouseEvent) => {
			if (event.button !== 0) return;
			window.clearTimeout(waiting);
			// 双击、三击选词选段，选区要等这一下松开之后才定。
			const pick = () =>
				requestAnimationFrame(() => {
					const quoted = quotedIn(window.getSelection(), box);
					setPicked(quoted ? { ...quoted, at: atOf(quoted.range) } : null);
				});
			if (event.detail === 2) waiting = window.setTimeout(pick, DOUBLE_CLICK_WAIT);
			else pick();
		};
		// 跟着字走，不是滚一下就收：贴着底部时回复每长一截转录就滚一次，滚就收的话，菜单在正在写的那条回复上一出来就没了。
		let frame = 0;
		const onScroll = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				setPicked((was) => {
					if (!was) return was;
					const now = atOf(was.range);
					return now.x === was.at.x && now.y === was.at.y ? was : { ...was, at: now };
				});
			});
		};
		box.addEventListener("mousedown", onDown);
		box.addEventListener("mouseup", onUp);
		box.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(waiting);
			box.removeEventListener("mousedown", onDown);
			box.removeEventListener("mouseup", onUp);
			box.removeEventListener("scroll", onScroll);
		};
	}, [scrollRef]);

	// 选区没了（按了方向键、点了别处的字），菜单跟着走。
	useEffect(() => {
		if (!picked) return;
		const onChange = () => {
			if (window.getSelection()?.isCollapsed !== false) setPicked(null);
		};
		document.addEventListener("selectionchange", onChange);
		return () => document.removeEventListener("selectionchange", onChange);
	}, [picked]);

	if (!picked) return null;
	const close = () => setPicked(null);
	const quote = (): DraftQuote => ({ id: crypto.randomUUID(), text: picked.text, from: picked.from });

	// `hug` + `w-max`：宽度跟着字走，写死的宽度在中文和英文的标签之间总有一边要截断。`panel`：整张卡都是内容，不留菜单那圈内衬。
	return (
		<Popover anchor={picked.at} onClose={close} placement="top" align="center" width="hug" surface="panel" className="w-max" role="menu">
			{/* 按下去不能动选区：一动，`selectionchange` 先把菜单收了，点击就落了空。 */}
			<div className="flex text-caption text-ink" onMouseDown={(event) => event.preventDefault()}>
				{sessionId &&
					actions?.map((action, index) => (
						<Fragment key={index}>
							<button
								type="button"
								role="menuitem"
								className="min-w-0 px-2.5 py-1.5 hover:bg-card-hover"
								onClick={() => {
									const selected = quote();
									close();
									void Promise.resolve()
										.then(() => action.run(selected, sessionId))
										.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
								}}
							>
								{localized(action.label, resolvedLocale)}
							</button>
							<div className="w-px shrink-0 bg-line-float" aria-hidden />
						</Fragment>
					))}
				<button
					type="button"
					role="menuitem"
					className="min-w-0 px-2.5 py-1.5 hover:bg-card-hover"
					onClick={() => {
						onQuote(quote());
						close();
					}}
				>
					{t("conversation.quoteToComposer")}
				</button>
			</div>
		</Popover>
	);
});
