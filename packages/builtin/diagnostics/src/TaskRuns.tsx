import { Caret, ScrollText, Text, useI18n } from "@plume/ui";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Entry } from "./entries.ts";
import { duration } from "./Detail.tsx";
import { STATUS_LABELS } from "./messages.ts";

/** 只展开一项，保留展开项和键盘焦点；插入新记录时守住正在看的位置。 */
export function TaskRuns({ entries, scrollRef, render }: { entries: Entry[]; scrollRef: RefObject<HTMLDivElement | null>; render(entry: Entry): ReactNode }) {
	const { resolvedLocale: locale } = useI18n();
	const host = useRef<HTMLDivElement>(null);
	const [openId, setOpen] = useState<string>();
	const [focused, setFocused] = useState<string>();
	const [rowHeight, setRowHeight] = useState(36);
	const [openHeight, setOpenHeight] = useState(0);
	const [range, setRange] = useState({ start: 0, end: 40 });
	const [ready, setReady] = useState(0);
	const first = useRef(entries[0]?.id);
	const openIndex = entries.findIndex((entry) => entry.id === openId);
	const extra = openIndex < 0 ? 0 : Math.max(0, openHeight - rowHeight);
	useLayoutEffect(() => {
		const list = host.current;
		const viewport = scrollRef.current;
		if (!list || !viewport) {
			const frame = requestAnimationFrame(() => setReady((value) => value + 1));
			return () => cancelAnimationFrame(frame);
		}
		const added = entries.findIndex((entry) => entry.id === first.current);
		if (added > 0 && viewport.scrollTop > list.offsetTop) viewport.scrollTop += added * rowHeight;
		first.current = entries[0]?.id;
		let lastTop = viewport.scrollTop;
		const measure = () => {
			if (!viewport.clientHeight) return;
			const top = Math.max(0, viewport.scrollTop - list.offsetTop);
			const indexAt = (y: number) =>
				openIndex < 0 || y < openIndex * rowHeight
					? Math.floor(y / rowHeight)
					: y < (openIndex + 1) * rowHeight + extra
						? openIndex
						: Math.floor((y - extra) / rowHeight);
			const pad = Math.max(12, Math.ceil(Math.abs(viewport.scrollTop - lastTop) / rowHeight) + Math.ceil(viewport.clientHeight / rowHeight));
			lastTop = viewport.scrollTop;
			const start = Math.max(0, indexAt(top) - pad);
			const end = Math.min(entries.length, indexAt(top + viewport.clientHeight) + pad + 1);
			setRange((value) => (value.start === start && value.end === end ? value : { start, end }));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(viewport);
		for (const child of viewport.children) observer.observe(child);
		viewport.addEventListener("scroll", measure, { passive: true });
		return () => {
			observer.disconnect();
			viewport.removeEventListener("scroll", measure);
		};
	}, [entries, scrollRef, rowHeight, extra, openIndex, ready]);
	const visible = Array.from({ length: Math.max(0, range.end - range.start) }, (_, index) => index + range.start).filter((index) => index < entries.length);
	if (openIndex >= 0 && !visible.includes(openIndex)) visible.push(openIndex);
	const focusIndex = entries.findIndex((entry) => entry.id === focused);
	if (focusIndex >= 0 && !visible.includes(focusIndex)) visible.push(focusIndex);
	visible.sort((a, b) => a - b);
	const signature = visible.join(",");
	useLayoutEffect(() => {
		const list = host.current;
		if (!list) return;
		const measure = () => {
			const closed = list.querySelector<HTMLElement>('[data-task-record][data-open="false"]');
			const open = list.querySelector<HTMLElement>('[data-task-record][data-open="true"]');
			if (closed?.offsetHeight) setRowHeight(closed.offsetHeight);
			if (open?.offsetHeight) setOpenHeight(open.offsetHeight);
		};
		measure();
		const observer = new ResizeObserver(measure);
		for (const child of list.children) observer.observe(child);
		return () => observer.disconnect();
	}, [signature, openId]);
	return (
		<div ref={host} className="plume-diagnostics-records" data-task-records style={{ height: entries.length * rowHeight + extra }}>
			{visible.map((index) => {
				const entry = entries[index]!;
				const open = entry.id === openId;
				return (
					<div
						key={entry.id}
						className="plume-diagnostics-record"
						data-task-record={entry.callId}
						data-open={open}
						style={{ top: index * rowHeight + (index > openIndex && openIndex >= 0 ? extra : 0) }}
						onFocusCapture={() => setFocused(entry.id)}
						onBlurCapture={(event) => {
							if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
						}}
					>
						<div className="plume-diagnostics-record-head">
							<button
								type="button"
								aria-expanded={open}
								className="plume-diagnostics-row"
								onClick={() => {
									setOpen(open ? undefined : entry.id);
									setOpenHeight(0);
								}}
							>
								<Text size="detail" tone="muted" className="plume-diagnostics-grow">
									<ScrollText text={entry.summary} />
								</Text>
								<span className="plume-diagnostics-dot" data-status={entry.status} />
								<Text size="caption" tone="faint" numeric>
									{entry.durationMs === undefined ? entry.status && STATUS_LABELS[locale][entry.status] : duration(entry.durationMs)}
								</Text>
								<Caret open={open} size={12} />
							</button>
						</div>
						{open && <div className="plume-diagnostics-record-body">{render(entry)}</div>}
					</div>
				);
			})}
		</div>
	);
}
