import type { SessionView } from "@plume/contract";
import {
	Button,
	Caret,
	IconButton,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	Popover,
	Scroller,
	ScrollText,
	SearchField,
	Text,
	useI18n,
	usePopover,
} from "@plume/ui";
import { ArrowDownToLine, ChevronsDownUp, ChevronsUpDown, Download, Filter, RefreshCw, Terminal, Zap } from "@plume/ui/icons";
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { duration, TraceDetail } from "./Detail.tsx";
import { entriesOf, filterEntries, SOURCES, type Entry, type Source } from "./entries.ts";
import { MESSAGES, SOURCE_LABELS, STATUS_LABELS } from "./messages.ts";
import type { Runtime } from "./state.tsx";

type TimeRange = { from: number; to: number };
function Timeline({
	all,
	selected,
	range,
	onRange,
	onSelect,
}: {
	all: Entry[];
	selected?: string;
	range?: TimeRange;
	onRange(value?: TimeRange): void;
	onSelect(entry: Entry): void;
}) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const calls = all.filter((entry) => entry.source === "request" || entry.source === "tool-call");
	const from = Math.min(...calls.map((entry) => entry.startedAt ?? entry.ts));
	const to = Math.max(...calls.map((entry) => entry.finishedAt ?? (entry.startedAt ?? entry.ts) + (entry.durationMs ?? 1)));
	const span = Math.max(1, to - from);
	const drag = useRef<{ x: number; at: number } | undefined>(undefined);
	if (!calls.length) return null;
	const position = (x: number, element: HTMLElement) =>
		from + Math.max(0, Math.min(1, (x - element.getBoundingClientRect().left) / element.clientWidth)) * span;
	return (
		<div className="plume-diagnostics-timeline-wrap">
			<div
				className="plume-diagnostics-timeline"
				aria-label={words.timeline}
				onPointerDown={(event) => {
					if (event.target !== event.currentTarget) return;
					drag.current = { x: event.clientX, at: position(event.clientX, event.currentTarget) };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					const start = drag.current;
					if (!start || Math.abs(start.x - event.clientX) < 4) return;
					const end = position(event.clientX, event.currentTarget);
					onRange({ from: Math.min(start.at, end), to: Math.max(start.at, end) });
				}}
				onPointerUp={() => {
					drag.current = undefined;
				}}
				onPointerCancel={() => {
					drag.current = undefined;
				}}
			>
				{calls.map((entry) => (
					<button
						type="button"
						key={entry.id}
						className="plume-diagnostics-time-bar"
						data-source={entry.source}
						data-selected={selected === entry.id}
						data-status={entry.status}
						data-plume-tip={`${entry.summary}\n${entry.durationMs === undefined ? "" : duration(entry.durationMs)}`}
						aria-label={entry.summary}
						onClick={() => onSelect(entry)}
						style={{
							left: `${(((entry.startedAt ?? entry.ts) - from) / span) * 100}%`,
							width: `${Math.max(0.4, (((entry.finishedAt ?? (entry.startedAt ?? entry.ts) + (entry.durationMs ?? 1)) - (entry.startedAt ?? entry.ts)) / span) * 100)}%`,
						}}
					/>
				))}
				{range && (
					<span
						className="plume-diagnostics-time-range"
						style={{ left: `${((range.from - from) / span) * 100}%`, width: `${((range.to - range.from) / span) * 100}%` }}
					/>
				)}
			</div>
			<div className="plume-diagnostics-heading">
				<Text size="caption" tone="faint" numeric>
					{new Date(from).toLocaleTimeString()}
				</Text>
				{range && (
					<Button size="xs" variant="subtle" onClick={() => onRange(undefined)}>
						{words.clearRange}
					</Button>
				)}
				<Text size="caption" tone="faint" numeric>
					{duration(span)}
				</Text>
			</div>
		</div>
	);
}

type Row = { turn: number; entry?: Entry };
function TraceList({
	entries,
	selected,
	collapsed,
	follow,
	target,
	onSelect,
	onCollapse,
	onFollowing,
}: {
	entries: Entry[];
	selected?: string;
	target?: string;
	collapsed: Set<number>;
	follow: boolean;
	onSelect(entry: Entry): void;
	onCollapse(turn: number): void;
	onFollowing(value: boolean): void;
}) {
	const { resolvedLocale: locale } = useI18n();
	const words = MESSAGES[locale];
	const viewport = useRef<HTMLDivElement>(null);
	const [range, setRange] = useState({ start: 0, end: 40 });
	const [focused, setFocused] = useState<string>();
	const [ready, setReady] = useState(0);
	const rowHeight = 34;
	const rows = useMemo(() => {
		const result: Row[] = [];
		let turn = -1;
		for (const entry of entries) {
			if (entry.turn !== turn) {
				turn = entry.turn;
				result.push({ turn });
			}
			if (!collapsed.has(turn)) result.push({ turn, entry });
		}
		return result;
	}, [entries, collapsed]);
	useLayoutEffect(() => {
		const node = viewport.current;
		if (!node) {
			const frame = requestAnimationFrame(() => setReady((value) => value + 1));
			return () => cancelAnimationFrame(frame);
		}
		const measure = () => {
			const start = Math.max(0, Math.floor(node.scrollTop / rowHeight) - 20);
			const end = Math.min(rows.length, Math.ceil((node.scrollTop + node.clientHeight) / rowHeight) + 20);
			setRange((value) => (value.start === start && value.end === end ? value : { start, end }));
		};
		measure();
		node.addEventListener("scroll", measure, { passive: true });
		const wheel = (event: WheelEvent) => {
			if (event.deltaY < 0) onFollowing(false);
		};
		node.addEventListener("wheel", wheel, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => {
			node.removeEventListener("scroll", measure);
			node.removeEventListener("wheel", wheel);
			observer.disconnect();
		};
	}, [rows, ready, onFollowing]);
	useLayoutEffect(() => {
		const node = viewport.current;
		if (!node) return;
		if (target) {
			const index = rows.findIndex((row) => row.entry?.id === target);
			if (index >= 0 && (index * rowHeight < node.scrollTop || (index + 1) * rowHeight > node.scrollTop + node.clientHeight))
				node.scrollTop = Math.max(0, index * rowHeight - node.clientHeight / 2);
		} else if (follow && !selected) node.scrollTop = node.scrollHeight;
	}, [rows, target, follow, selected, ready]);
	const indices = Array.from({ length: Math.max(0, range.end - range.start) }, (_, index) => index + range.start);
	const focusedIndex = rows.findIndex((row) => row.entry?.id === focused);
	if (focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex);
	return (
		<Scroller className="plume-diagnostics-ledger" scrollRef={viewport}>
			<div className="plume-diagnostics-trace-rows" style={{ height: rows.length * rowHeight }}>
				{indices.map((index) => {
					const row = rows[index];
					if (!row) return null;
					const entry = row.entry;
					return entry ? (
						<button
							type="button"
							key={entry.id}
							data-trace-entry={entry.id}
							aria-pressed={entry.id === selected}
							className="plume-diagnostics-trace-row"
							style={{ top: index * rowHeight, height: rowHeight }}
							onFocus={() => setFocused(entry.id)}
							onBlur={() => setFocused(undefined)}
							onClick={() => onSelect(entry)}
						>
							<Text size="caption" tone="faint" numeric className="plume-diagnostics-seq">
								{entry.seq}
							</Text>
							<span className="plume-diagnostics-dot" data-status={entry.status} />
							<Text size="caption" tone="faint" className="plume-diagnostics-source">
								{SOURCE_LABELS[locale][entry.source]}
							</Text>
							<Text size="detail" tone="muted" className="plume-diagnostics-grow">
								<ScrollText
									text={
										entry.summary ||
										(entry.source === "lifecycle" ? (entry.status === "done" ? words.endedTurn : words.startedTurn) : SOURCE_LABELS[locale][entry.source])
									}
								/>
							</Text>
							<Text size="caption" tone="faint" numeric>
								{entry.durationMs === undefined ? "" : duration(entry.durationMs)}
							</Text>
						</button>
					) : (
						<button
							type="button"
							key={`turn:${row.turn}:${index}`}
							className="plume-diagnostics-trace-row plume-diagnostics-turn"
							style={{ top: index * rowHeight, height: rowHeight }}
							aria-expanded={!collapsed.has(row.turn)}
							onClick={() => onCollapse(row.turn)}
						>
							<Caret open={!collapsed.has(row.turn)} size={12} />
							<Text size="caption" tone="faint">
								{words.turn(row.turn)}
							</Text>
						</button>
					);
				})}
			</div>
		</Scroller>
	);
}

function download(entries: Entry[], format: "json" | "md", title: string) {
	const text =
		format === "json"
			? JSON.stringify(entries, null, 2)
			: `# ${title}\n\n` +
				entries
					.map(
						(entry) =>
							`## #${entry.seq} ${entry.source} · ${entry.summary}\n\n${new Date(entry.ts).toISOString()}\n\n${[entry.detail, entry.input, entry.output].filter(Boolean).join("\n\n")}\n`,
					)
					.join("\n");
	const url = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json" : "text/markdown" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = `trajectory.${format}`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TracePanel({ session, runtime, shown }: { session: SessionView; runtime: Runtime; shown: boolean }) {
	const { resolvedLocale: locale } = useI18n();
	const words = MESSAGES[locale];
	const data = runtime.state.useSnapshot(session.summary.id, shown, false, true);
	const selection = runtime.state.useSelection(session.summary.id);
	const all = useMemo(() => entriesOf(session, data.observations, data.prompts), [session, data.observations, data.prompts]);
	const [query, setQuery] = useState("");
	const search = useDeferredValue(query);
	const [sources, setSources] = useState<Source[]>([]);
	const [status, setStatus] = useState("");
	const [time, setTime] = useState<TimeRange>();
	const [selected, setSelected] = useState<string>();
	const [target, setTarget] = useState<string>();
	const [collapsed, setCollapsed] = useState(new Set<number>());
	const [follow, setFollow] = useState(true);
	const menu = usePopover();
	const exports = usePopover();
	const root = useRef<HTMLDivElement>(null);
	const filtered = useMemo(
		() => filterEntries(all, search, status, sources).filter((entry) => !time || ((entry.finishedAt ?? entry.ts) >= time.from && entry.ts <= time.to)),
		[all, search, status, sources, time],
	);
	const counts = useMemo(() => new Map(SOURCES.map((source) => [source, all.filter((entry) => entry.source === source).length])), [all]);
	const picked = all.find((entry) => entry.id === selected);
	const totals = all.reduce(
		(sum, entry) => {
			if (entry.source === "request" && entry.usage) {
				sum.tokens += entry.usage.input + entry.usage.output;
				sum.cost += entry.usage.cost.total;
			}
			if (entry.source === "tool-call") sum.tools++;
			return sum;
		},
		{ tokens: 0, cost: 0, tools: 0 },
	);
	const navigate = (entry: Entry) => {
		setSelected(entry.id);
		setTarget(entry.id);
		setCollapsed((current) => {
			const next = new Set(current);
			next.delete(entry.turn);
			return next;
		});
	};
	useEffect(() => {
		if (!selection.call) return;
		const entry = all.find((item) => item.callId === selection.call && item.source === "tool-call");
		if (!entry) return;
		setQuery("");
		setSources([]);
		setStatus("");
		setTime(undefined);
		setCollapsed(new Set());
		setSelected(entry.id);
		setTarget(entry.id);
		runtime.state.select(session.summary.id, { call: undefined });
	}, [selection.call, all, runtime, session.summary.id]);
	const close = () => {
		setSelected(undefined);
		setTarget(undefined);
		requestAnimationFrame(() => {
			const row = root.current?.querySelector<HTMLElement>(`[data-trace-entry="${CSS.escape(selected ?? "")}"]`);
			(row ?? root.current?.querySelector("input"))?.focus({ preventScroll: true });
		});
	};
	const pickedIndex = filtered.findIndex((entry) => entry.id === selected);
	return (
		<div
			ref={root}
			className="plume-diagnostics-trace"
			data-trajectory
			onKeyDown={(event) => {
				if (event.key === "Escape" && picked && !event.defaultPrevented) {
					event.stopPropagation();
					close();
				}
			}}
		>
			<div className="plume-diagnostics-controls" role="toolbar" aria-label={words.trajectory}>
				<SearchField value={query} onChange={setQuery} placeholder={words.traceSearch} className="plume-diagnostics-grow" />
				<IconButton size="sm" label={words.filter} active={sources.length > 0 || Boolean(status)} icon={<Filter size={14} />} onClick={menu.toggle} />
				<IconButton size="sm" label={words.refresh} icon={<RefreshCw size={14} />} onClick={() => void runtime.state.refresh(session.summary.id)} />
				<IconButton
					size="sm"
					label={collapsed.size ? words.expand : words.collapse}
					icon={collapsed.size ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
					onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(all.map((entry) => entry.turn)))}
				/>
				<IconButton size="sm" label={words.follow} active={follow} icon={<ArrowDownToLine size={14} />} onClick={() => setFollow(!follow)} />
				<IconButton size="sm" label={words.exportJson} icon={<Download size={14} />} onClick={exports.toggle} />
			</div>
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} label={words.filter}>
					<MenuBody>
						<MenuItem checked={!sources.length} onClick={() => setSources([])}>
							{words.all}
						</MenuItem>
						{SOURCES.filter((source) => counts.get(source)).map((source) => (
							<MenuItem
								key={source}
								checked={sources.includes(source)}
								hint={String(counts.get(source))}
								onClick={() => setSources((value) => (value.includes(source) ? value.filter((item) => item !== source) : [...value, source]))}
							>
								{SOURCE_LABELS[locale][source]}
							</MenuItem>
						))}
						<MenuSeparator />
						<MenuLabel>{words.status}</MenuLabel>
						{["", "running", "error", "done", "cancelled", "interrupted"].map((value) => (
							<MenuItem key={value} checked={value === status} onClick={() => setStatus(value)}>
								{value ? STATUS_LABELS[locale][value as keyof (typeof STATUS_LABELS)[typeof locale]] : words.all}
							</MenuItem>
						))}
					</MenuBody>
				</Popover>
			)}
			{exports.open && (
				<Popover anchor={exports.anchor} onClose={exports.close}>
					<MenuBody>
						{(["json", "md"] as const).map((format) => (
							<MenuItem
								key={format}
								onClick={() => {
									exports.close();
									download(all, format, session.summary.title);
								}}
							>
								{format === "json" ? words.exportJson : words.exportMarkdown}
							</MenuItem>
						))}
					</MenuBody>
				</Popover>
			)}
			<Timeline all={all} selected={selected} range={time} onRange={setTime} onSelect={navigate} />
			<div className="plume-diagnostics-totals" data-trace-count>
				<Text size="caption" tone="faint" numeric>
					{filtered.length}/{all.length}
				</Text>
				<span className="plume-diagnostics-grow" />
				<Text size="caption" tone="faint" numeric data-plume-tip={words.tools}>
					<Terminal size={11} /> {totals.tools}
				</Text>
				<Text size="caption" tone="faint" numeric data-plume-tip={words.tokens}>
					<Zap size={11} /> {totals.tokens.toLocaleString()}
				</Text>
				{totals.cost > 0 && (
					<Text size="caption" tone="faint" numeric>
						${totals.cost.toFixed(2)}
					</Text>
				)}
			</div>
			{data.error && (
				<Text as="p" size="caption" tone="danger" role="alert">
					{data.error}
				</Text>
			)}
			{data.loading && (
				<Text as="p" size="caption" tone="faint" role="status">
					{words.loading}
				</Text>
			)}
			{!data.loading && !filtered.length && (
				<Text as="p" size="caption" tone="faint">
					{all.length ? words.noMatch : words.empty}
				</Text>
			)}
			<div className="plume-diagnostics-trace-body" data-has-detail={Boolean(picked)}>
				<TraceList
					entries={filtered}
					selected={selected}
					target={target}
					collapsed={collapsed}
					follow={follow}
					onFollowing={setFollow}
					onSelect={(entry) => {
						setSelected(entry.id);
						setTarget(undefined);
					}}
					onCollapse={(turn) =>
						setCollapsed((value) => {
							const next = new Set(value);
							if (!next.delete(turn)) next.add(turn);
							return next;
						})
					}
				/>
				{picked && (
					<TraceDetail
						entry={picked}
						all={all}
						runtime={runtime}
						sessionId={session.summary.id}
						onClose={close}
						onSelect={navigate}
						previous={pickedIndex > 0 ? filtered[pickedIndex - 1] : undefined}
						next={pickedIndex >= 0 ? filtered[pickedIndex + 1] : undefined}
					/>
				)}
			</div>
		</div>
	);
}
