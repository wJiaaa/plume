/**
 * 转录左边那条问题导航：人问过的每一句是一道刻痕，指上去看那一问和回答的开头，点一下跳过去。
 *
 * 长会话里要找「我上次问的那个」，往上翻是一屏一屏地找；刻痕按问题排，一眼就是第几问。指着的那一道最长，越远越短，
 * 鼠标在上面移动时像放大镜扫过去；一次只排 `QUESTION_LIMIT` 道，滚轮把这一段往前往后挪。
 */

import { useI18n } from "@plume/ui";
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { markdownExcerpt } from "../markdown/excerpt.ts";
import { conversationTime, type Question, questionWindow } from "./question-navigation.ts";

/** 隔了一阵再说的那句话上面那条时间线，见 `timeSeparators`。 */
export function ConversationTime({ timestamp }: { timestamp: number }) {
	const { t, resolvedLocale } = useI18n();
	return (
		<div className="py-2 text-center text-caption text-ink-faint">
			<time dateTime={new Date(timestamp).toISOString()}>
				{conversationTime(timestamp, Date.now(), resolvedLocale, { today: t("recency.today"), yesterday: t("recency.yesterday") })}
			</time>
		</div>
	);
}

export function QuestionNav({
	questions,
	viewport,
	onSelect,
}: {
	questions: Question[];
	/** 转录的滚动层：从里面的 `[data-question-index]` 认出现在读到了第几问。 */
	viewport: RefObject<HTMLDivElement | null>;
	onSelect: (index: number) => void;
}) {
	const { t } = useI18n();
	const [active, setActive] = useState<number | null>(null);
	const [hovered, setHovered] = useState<number | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const [clickedWidths, setClickedWidths] = useState<ReadonlyMap<number, number> | null>(null);
	const focusTarget = useRef<number | null>(null);
	const [center, setCenter] = useState(questions.length - 1);
	const [preview, setPreview] = useState<{ text: string; answer: string; slot: number } | null>(null);
	const nav = useRef<HTMLElement>(null);
	const rail = useRef<HTMLDivElement>(null);
	// 人正在导航上滚、指、按方向键时，读到哪一问不再把这一段拉回去。
	const engaged = useRef(false);
	const position = Math.max(
		0,
		questions.findIndex((question) => question.index === active),
	);
	useLayoutEffect(() => {
		if (!engaged.current) setCenter(position);
	}, [position]);

	// 读到了第几问：视口顶上 60px 以上最后一个露过头的问题。滚动、内容变了、尺寸变了都重新认一次，一帧最多一次。
	useLayoutEffect(() => {
		const element = viewport.current;
		if (!element) return;
		let frame = 0;
		const measure = () => {
			frame = 0;
			const top = element.getBoundingClientRect().top + 60;
			let current: number | null = null;
			for (const row of element.querySelectorAll<HTMLElement>("[data-question-index]")) {
				if (row.getBoundingClientRect().top > top && current !== null) break;
				current = Number(row.dataset.questionIndex);
			}
			setActive(current);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		measure();
		element.addEventListener("scroll", schedule, { passive: true });
		const mutations = new MutationObserver(schedule);
		mutations.observe(element, { childList: true, subtree: true });
		const resize = new ResizeObserver(schedule);
		if (element.firstElementChild) resize.observe(element.firstElementChild);
		return () => {
			element.removeEventListener("scroll", schedule);
			mutations.disconnect();
			resize.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [viewport, questions.length]);

	// 滚轮挪这一段，不滚转录：攒够一格才挪，一次挪三道，触控板的细碎滚动不会让它抖。
	useLayoutEffect(() => {
		const element = rail.current;
		if (!element) return;
		let delta = 0;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			delta += event.deltaY;
			if (Math.abs(delta) < 24) return;
			engaged.current = true;
			setHovered(null);
			setClickedWidths(null);
			const steps = Math.sign(delta) * 3;
			delta = 0;
			setCenter((value) => Math.max(0, Math.min(questions.length - 1, value + steps)));
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, [questions.length]);

	const range = questionWindow(questions.length, center);
	useLayoutEffect(() => {
		if (focusTarget.current === null) return;
		nav.current?.querySelector<HTMLButtonElement>(`[data-position="${focusTarget.current}"]`)?.focus({ preventScroll: true });
		focusTarget.current = null;
	});

	const show = (at: number) => {
		const question = questions[at];
		if (!question) return;
		engaged.current = true;
		setDismissed(false);
		setClickedWidths(null);
		setHovered(at);
		setPreview({ text: question.text, answer: question.answer, slot: at - range.start });
	};
	const select = (at: number, focus = false) => {
		const next = Math.max(0, Math.min(questions.length - 1, at));
		const question = questions[next];
		if (!question) return;
		engaged.current = true;
		setDismissed(true);
		if (focus) {
			setClickedWidths(null);
			if (next < range.start || next >= range.end) setCenter(next);
			setHovered(next);
			focusTarget.current = next;
		} else {
			// 鼠标点下去时停在已经画出来的宽度上：一次点击期间指针下面的刻痕不跳。
			const widths = new Map<number, number>();
			for (const mark of rail.current?.querySelectorAll<HTMLButtonElement>("[data-position]") ?? []) {
				const line = mark.querySelector("span");
				if (line) widths.set(Number(mark.dataset.position), line.getBoundingClientRect().width);
			}
			setClickedWidths(widths);
		}
		onSelect(question.index);
	};
	const leave = () => {
		engaged.current = false;
		setHovered(null);
		setClickedWidths(null);
		setCenter(position);
	};

	return (
		<nav ref={nav} className="absolute inset-y-3 left-0 z-20 flex w-7 items-center @min-[520px]:left-3" aria-label={t("questionNav.label")}>
			<div
				ref={rail}
				role="toolbar"
				tabIndex={-1}
				aria-label={t("questionNav.pick")}
				className="relative w-full"
				onMouseLeave={leave}
				onBlur={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget)) leave();
				}}
				onKeyDown={(event) => {
					const current = hovered ?? center;
					const next =
						event.key === "Home"
							? 0
							: event.key === "End"
								? questions.length - 1
								: event.key === "ArrowUp"
									? current - 1
									: event.key === "ArrowDown"
										? current + 1
										: null;
					if (next === null) return;
					event.preventDefault();
					select(next, true);
				}}
			>
				{questions.slice(range.start, range.end).map((question, slot) => {
					const at = range.start + slot;
					const distance = hovered === null ? 5 : Math.abs(at - hovered);
					const width = clickedWidths?.get(at) ?? (distance < 4 ? 24 - distance * 5 : hovered === null && active === question.index ? 12 : 6);
					return (
						<button
							key={question.index}
							type="button"
							data-position={at}
							className="flex h-3 w-7 items-center rounded-sm pl-1.5"
							aria-label={t("questionNav.goTo", { n: at + 1, text: question.text })}
							aria-current={active === question.index ? "location" : undefined}
							onMouseEnter={() => show(at)}
							onFocus={() => {
								if (focusTarget.current !== at) show(at);
							}}
							onClick={() => select(at)}
						>
							<span
								style={{ width, transition: dismissed ? "none" : undefined }}
								className={`block h-[2px] rounded-full transition-[width,background-color,opacity] ${distance === 0 ? "bg-ink" : active === question.index ? "bg-ink-muted" : "bg-ink-faint/40"}`}
							/>
						</button>
					);
				})}
				{preview && (
					<div
						className="plume-question-preview pointer-events-none absolute left-9 w-[min(320px,calc(100cqw-60px))] rounded-panel border border-line bg-float p-3 text-label shadow-menu"
						role="tooltip"
						inert
						aria-hidden={hovered === null || dismissed}
						data-open={hovered !== null && !dismissed}
						data-dismissed={dismissed}
						style={
							{ top: 0, "--plume-preview-y": `${Math.max(-24, Math.min((range.end - range.start) * 12 - 80, preview.slot * 12 - 24))}px` } as CSSProperties
						}
					>
						<p className="line-clamp-2 font-medium break-words text-ink">{preview.text}</p>
						{preview.answer && <p className="mt-1 line-clamp-3 leading-relaxed break-words text-ink-muted">{markdownExcerpt(preview.answer)}</p>}
					</div>
				)}
			</div>
		</nav>
	);
}
