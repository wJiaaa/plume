import { CodeBlock, IconButton, Segmented, Text, useI18n } from "@plume/ui";
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, Copy, FileText, History } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { Entry } from "./entries.ts";
import { outputPath } from "./entries.ts";
import { MESSAGES, SOURCE_LABELS, STATUS_LABELS } from "./messages.ts";
import type { Runtime } from "./state.tsx";

/** 详情栏的宽度：拖左边那条缝或用左右方向键调，只在这次打开的详情里记着。 */
const DETAIL_WIDTH = 380;
const MIN_DETAIL = 360;
const MAX_DETAIL = 720;
const clampDetail = (width: number) => Math.max(MIN_DETAIL, Math.min(MAX_DETAIL, width));

export function duration(ms: number): string {
	if (ms < 1000) return `${Math.round(Math.max(0, ms))} ms`;
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function DetailText({ title, text, runtime }: { title: string; text?: string; runtime: Runtime }) {
	const words = MESSAGES[useI18n().resolvedLocale];
	if (!text) return null;
	return (
		<section className="plume-diagnostics-text">
			<div className="plume-diagnostics-heading">
				<Text size="caption" tone="faint">
					{title}
				</Text>
				<IconButton
					size="xs"
					label={words.copy}
					icon={<Copy size={12} />}
					onClick={() => void navigator.clipboard.writeText(text).catch((error: unknown) => runtime.ui.notify(String(error), "error"))}
				/>
			</div>
			<CodeBlock>{text}</CodeBlock>
		</section>
	);
}

/** 观察到的那次请求实际发出去的消息和工具表：轨迹列表里不带，打开详情时才取。 */
function useRequestInput(entry: Entry, runtime: Runtime, sessionId: string): string | undefined {
	const [loaded, setLoaded] = useState<{ id: string; text: string }>();
	const { requestId } = entry;
	useEffect(() => {
		if (!requestId) return;
		let live = true;
		runtime.api.request(sessionId, requestId).then(
			({ messages, tools }) => {
				if (live) setLoaded({ id: requestId, text: JSON.stringify({ messages, tools }, null, 2) });
			},
			(error: unknown) => {
				if (live) runtime.ui.notify(String(error), "error");
			},
		);
		return () => {
			live = false;
		};
	}, [requestId, runtime, sessionId]);
	return requestId && loaded?.id === requestId ? loaded.text : undefined;
}

export function RunDetail({ entry, runtime, sessionId }: { entry: Entry; runtime: Runtime; sessionId: string }) {
	const { resolvedLocale: locale } = useI18n();
	const words = MESSAGES[locale];
	return (
		<div className="plume-diagnostics-run-detail">
			<div className="plume-diagnostics-heading">
				<Text size="caption" tone="faint" className="plume-diagnostics-break">
					{entry.toolName} · {entry.callId}
				</Text>
				<div className="plume-diagnostics-actions">
					{entry.callId && outputPath(entry) && (
						<IconButton size="sm" label={words.fullOutput} icon={<FileText size={13} />} onClick={() => runtime.openOutput(sessionId, entry.callId!)} />
					)}
					{entry.callId && (
						<IconButton size="sm" label={words.inTrace} icon={<History size={13} />} onClick={() => runtime.openTrace(sessionId, entry.callId)} />
					)}
					{entry.callId && (
						<IconButton
							size="sm"
							label={words.inConversation}
							icon={<ArrowUpRight size={13} />}
							onClick={() => void runtime.ui.revealToolCall(sessionId, entry.callId!).catch((error: unknown) => runtime.ui.notify(String(error), "error"))}
						/>
					)}
				</div>
			</div>
			<Text as="p" size="caption" tone="faint" numeric>
				{entry.startedAt === undefined ? "" : new Date(entry.startedAt).toLocaleString()}{" "}
				{entry.finishedAt === undefined ? entry.status && STATUS_LABELS[locale][entry.status] : `→ ${new Date(entry.finishedAt).toLocaleString()}`}
			</Text>
			<DetailText title={words.input} text={entry.input} runtime={runtime} />
			<DetailText title={words.output} text={entry.output} runtime={runtime} />
		</div>
	);
}

export function TraceDetail({
	entry,
	all,
	runtime,
	sessionId,
	onClose,
	onSelect,
	previous,
	next,
}: {
	entry: Entry;
	all: Entry[];
	runtime: Runtime;
	sessionId: string;
	onClose(): void;
	onSelect(entry: Entry): void;
	previous?: Entry;
	next?: Entry;
}) {
	const { resolvedLocale: locale } = useI18n();
	const words = MESSAGES[locale];
	const [tab, setTab] = useState<"content" | "info" | "raw">("content");
	const head = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(DETAIL_WIDTH);
	const resize = useRef<{ x: number; width: number } | null>(null);
	useEffect(() => {
		head.current?.focus({ preventScroll: true });
	}, []);
	const requestInput = useRequestInput(entry, runtime, sessionId);
	const related = entry.callId ? all.filter((other) => other.id !== entry.id && other.callId === entry.callId) : [];
	const facts = [
		[words.status, entry.status && STATUS_LABELS[locale][entry.status]],
		[words.provider, entry.provider],
		[words.model, entry.model],
		[words.callId, entry.callId],
		[words.started, entry.startedAt === undefined ? undefined : new Date(entry.startedAt).toLocaleString()],
		[words.ended, entry.finishedAt === undefined ? undefined : new Date(entry.finishedAt).toLocaleString()],
		[words.elapsed, entry.durationMs === undefined ? undefined : duration(entry.durationMs)],
	];
	return (
		<aside className="plume-diagnostics-inspector" data-trace-inspector aria-label={words.details} style={{ width }}>
			<div
				role="separator"
				aria-label={words.resize}
				aria-orientation="vertical"
				aria-valuemin={MIN_DETAIL}
				aria-valuemax={MAX_DETAIL}
				aria-valuenow={width}
				tabIndex={0}
				className="plume-diagnostics-resize"
				onPointerDown={(event) => {
					resize.current = { x: event.clientX, width };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					if (resize.current) setWidth(clampDetail(resize.current.width + resize.current.x - event.clientX));
				}}
				onPointerUp={() => {
					resize.current = null;
				}}
				onPointerCancel={() => {
					resize.current = null;
				}}
				onKeyDown={(event) => {
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
					event.preventDefault();
					setWidth(clampDetail(width + (event.key === "ArrowLeft" ? 20 : -20)));
				}}
			/>
			<div ref={head} tabIndex={-1} className="plume-diagnostics-heading plume-diagnostics-inspector-head">
				<IconButton size="sm" label={words.close} icon={<ArrowLeft size={14} />} onClick={onClose} />
				<Text size="caption" tone="muted" className="plume-diagnostics-grow">
					#{entry.seq} · {SOURCE_LABELS[locale][entry.source]}
				</Text>
				<IconButton size="sm" label={words.previous} icon={<ChevronLeft size={14} />} disabled={!previous} onClick={() => previous && onSelect(previous)} />
				<IconButton size="sm" label={words.next} icon={<ChevronRight size={14} />} disabled={!next} onClick={() => next && onSelect(next)} />
			</div>
			<div className="plume-diagnostics-tabs">
				<Segmented value={tab} onChange={setTab} options={(["content", "info", "raw"] as const).map((value) => ({ value, label: words[value] }))} />
			</div>
			<div className="plume-diagnostics-inspector-body">
				{tab === "content" && (
					<>
						<Text as="p" className="plume-diagnostics-break">
							{entry.summary}
						</Text>
						{entry.callId && <RunDetail entry={entry} runtime={runtime} sessionId={sessionId} />}
						{!entry.callId && (
							<>
								<DetailText title={words.input} text={entry.input ?? requestInput} runtime={runtime} />
								<DetailText title={words.output} text={entry.output} runtime={runtime} />
							</>
						)}
						<DetailText title={words.details} text={entry.detail} runtime={runtime} />
						{entry.images?.map((image, index) => {
							const src = image.media ? runtime.ui.mediaUrl(image.media) : image.data ? `data:${image.mimeType};base64,${image.data}` : undefined;
							return src ? (
								<button
									key={index}
									type="button"
									className="plume-diagnostics-image"
									onClick={(event) => runtime.ui.openImage([{ src }], 0, { from: event.currentTarget })}
								>
									<img src={src} alt={`${words.output} ${index + 1}`} />
								</button>
							) : null;
						})}
						{related.length > 0 && (
							<section>
								<Text size="caption" tone="faint">
									{words.related}
								</Text>
								{related.map((other) => (
									<button type="button" key={other.id} className="plume-diagnostics-row" onClick={() => onSelect(other)}>
										<Text size="detail">
											#{other.seq} · {SOURCE_LABELS[locale][other.source]}
										</Text>
										<ArrowUpRight size={12} />
									</button>
								))}
							</section>
						)}
					</>
				)}
				{tab === "info" && (
					<>
						<dl className="plume-diagnostics-facts">
							{facts
								.filter(([, value]) => value !== undefined)
								.map(([label, value]) => (
									<div key={label}>
										<dt>
											<Text size="caption" tone="faint">
												{label}
											</Text>
										</dt>
										<dd>
											<Text size="caption" className="plume-diagnostics-break">
												{value}
											</Text>
										</dd>
									</div>
								))}
						</dl>
						<DetailText title={words.tokens} text={entry.usage && JSON.stringify(entry.usage, null, 2)} runtime={runtime} />
						<DetailText title={words.details} text={entry.metadata === undefined ? undefined : JSON.stringify(entry.metadata, null, 2)} runtime={runtime} />
					</>
				)}
				{tab === "raw" && <DetailText title={words.raw} text={JSON.stringify(entry, null, 2)} runtime={runtime} />}
			</div>
		</aside>
	);
}
