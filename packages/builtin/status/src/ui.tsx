/**
 * plume.status 的界面入口：输入框工具栏右边、模型选择前面的上下文用量。
 *
 * 圆环只回答「快满了吗」；点开回答「为什么」：对话消息、工具表、系统提示词各占多少，真要动手时看的是这个。
 * 项目指令和记忆收在「记忆文件」一行里，展开按文件列出：该去删哪份没人再读的 AGENTS.md，看的是这里。
 * 圆环和总数从 `ui.useSession` 的消息里算（format.ts），分段在点开时向宿主要（`ui.contextBreakdown`）。
 */

import type { ContextBreakdown, ContextSegmentKey } from "@plume/contract";
import type { ComposerItemProps, UiContext, UiPlugin } from "@plume/contract/ui";
import { Disclosure, Popover, ScrollText, Text, useI18n, usePopover } from "@plume/ui";
import { FileText } from "@plume/ui/icons";
import { useEffect, useMemo, useState } from "react";
import { type ContextReading, contextReading, formatTokens } from "./format.ts";
import { fill, MESSAGES } from "./messages.ts";
import css from "./status.css";

/** 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：更新后重新加载时换掉内容，不叠一份。 */
function mountStyles(): void {
	const id = "plume.status";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = css;
}

/**
 * 和转圈的那个同一种画法——24 的视框里半径 9、线宽 3.4——两个记号读起来是一家。转四分之一圈，从十二点起：
 * 不从十二点起的表盘，扫一眼读不出来。
 */
function Ring({ ratio, tight }: { ratio: number; tight: boolean }) {
	const circumference = 2 * Math.PI * 9;
	return (
		<svg width={14} height={14} viewBox="0 0 24 24" aria-hidden>
			<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3.4" className="status-ring-track" />
			<circle
				cx="12"
				cy="12"
				r="9"
				fill="none"
				stroke="currentColor"
				strokeWidth="3.4"
				strokeLinecap="round"
				strokeDasharray={`${circumference * ratio} ${circumference}`}
				transform="rotate(-90 12 12)"
				className="status-ring-fill"
				data-tight={tight || undefined}
			/>
		</svg>
	);
}

/**
 * 色块：已用的各段是同一个强调色由深到浅（按大小排，第几段就是第几档），剩余空间是线色，接近上限时已用的都是危险色。
 * 故意只用一种颜色：这几段是同一个量的几部分，换成五种颜色读起来像五件不相干的事。
 */
type Swatch = number | "tight" | "free";

function swatchData(swatch: Swatch) {
	return typeof swatch === "number" ? { "data-shade": Math.min(swatch, 5) } : swatch === "tight" ? { "data-tight": "" } : {};
}

function Row({ swatch, label, tokens, share }: { swatch: Swatch; label: string; tokens: number; share: number }) {
	return (
		<div className="status-row">
			<span className="status-swatch" {...swatchData(swatch)} />
			<Text size="detail" tone="muted" className="status-row-label">
				{label}
			</Text>
			<Text size="detail" tone="muted" numeric>
				{formatTokens(tokens)}
			</Text>
			<Text size="detail" tone="faint" numeric className="status-row-share">
				{(share * 100).toFixed(1)}%
			</Text>
		</div>
	);
}

/** 收进「记忆文件」那一行的两段，不单独列行；进度条上照样各占一截。 */
const MEMORY_SEGMENTS: ReadonlySet<ContextSegmentKey> = new Set(["conventions", "memory"]);

/** 「记忆文件」折叠行：右边是两段合计和文件数，展开列出各文件，点一个在文件面板里打开。 */
function MemoryFiles({ breakdown, onOpen }: { breakdown: ContextBreakdown; onOpen: (path: string) => void }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const files = breakdown.memoryFiles;
	const tokens = breakdown.segments.filter((segment) => MEMORY_SEGMENTS.has(segment.key)).reduce((sum, segment) => sum + segment.tokens, 0);
	return (
		<Disclosure
			variant="compact"
			title={text.memoryFiles}
			trailing={
				<span className="status-files-sum">
					<Text size="detail" tone="faint" numeric>
						{formatTokens(tokens)}
					</Text>
					<Text size="detail" tone="faint" numeric className="status-row-share">
						{files.length}
					</Text>
				</span>
			}
		>
			{files.map((file) => (
				<button key={file.path} type="button" data-plume-tip={file.path} className="plume-scroll status-file" onClick={() => onOpen(file.path)}>
					<FileText size={12} strokeWidth={1.8} className="status-file-icon" />
					<Text size="caption" tone="faint" mono className="status-file-text status-file-path">
						<ScrollText text={file.path} />
					</Text>
					<Text size="detail" tone="faint" numeric className="status-file-text">
						{formatTokens(file.tokens)}
					</Text>
				</button>
			))}
			{files.length === 0 && (
				<Text as="p" size="detail" tone="faint" className="status-file-none">
					{text.noMemoryFiles}
				</Text>
			)}
		</Disclosure>
	);
}

/**
 * 点开后的读数。分段只在开着时向宿主要：宿主每次现算，关着时不必跟着每条消息算。开着时来了新消息就再要一次。
 * 要到之前（`undefined`）只画总数；宿主给不出分段（本次启动后这个会话还没发过请求，或者出错）时，已用的整个算一段。
 */
function Detail({
	ui,
	sessionId,
	messageCount,
	reading,
	onOpen,
}: {
	ui: UiContext;
	sessionId: string;
	messageCount: number;
	reading: ContextReading;
	onOpen: (path: string) => void;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [detail, setDetail] = useState<{ sessionId: string; breakdown: ContextBreakdown | null } | undefined>(undefined);
	useEffect(() => {
		let live = true;
		void ui.contextBreakdown(sessionId).then(
			(breakdown) => live && setDetail({ sessionId, breakdown }),
			() => live && setDetail({ sessionId, breakdown: null }),
		);
		return () => {
			live = false;
		};
	}, [ui, sessionId, messageCount]);
	const current = detail?.sessionId === sessionId ? detail : undefined;
	const segments = current?.breakdown?.segments ?? [];
	const { used, limit, tight } = reading;
	const free = Math.max(0, limit - used);
	return (
		<div className="status-card">
			<div className="status-head">
				<Text>{text.window}</Text>
				<Text tone={tight ? "danger" : "muted"} numeric>
					{fill(text.usedOfLimit, { used: formatTokens(used), limit: formatTokens(limit), percent: reading.percent })}
				</Text>
			</div>
			<div className="status-bar">
				{segments.length === 0 ? (
					// 分段还没到时，条上也先画出已经知道的总数。
					<div className="status-bar-fill" {...swatchData(tight ? "tight" : 0)} style={{ width: `${Math.max(1, Math.min(1, used / limit) * 100)}%` }} />
				) : (
					segments.map((segment, index) => (
						<div
							key={segment.key}
							className="status-bar-fill"
							{...swatchData(tight ? "tight" : index)}
							style={{ width: `${(segment.tokens / limit) * 100}%` }}
						/>
					))
				)}
			</div>
			{tight && (
				<Text as="p" size="detail" tone="faint" className="status-section">
					{text.nearLimit}
				</Text>
			)}
			{current && (
				<div className="status-rows">
					{segments.length > 0 ? (
						segments.map((segment, index) =>
							MEMORY_SEGMENTS.has(segment.key) ? null : (
								<Row
									key={segment.key}
									swatch={tight ? "tight" : index}
									label={text.segments[segment.key]}
									tokens={segment.tokens}
									share={segment.tokens / limit}
								/>
							),
						)
					) : (
						<Row swatch={tight ? "tight" : 0} label={text.used} tokens={used} share={Math.min(1, used / limit)} />
					)}
					<Row swatch="free" label={text.remaining} tokens={free} share={free / limit} />
					{current.breakdown && <MemoryFiles breakdown={current.breakdown} onOpen={onOpen} />}
				</div>
			)}
		</div>
	);
}

function makeMeter(ui: UiContext) {
	return function ContextMeter({ sessionId, model }: ComposerItemProps) {
		const text = MESSAGES[useI18n().resolvedLocale];
		const popover = usePopover();
		const session = ui.useSession(sessionId);
		// 按消息记住：输出时视图每一拍都换，消息没变，不用每拍把整段转录再数一遍。
		const messages = session?.messages;
		const contextWindow = model?.contextWindow;
		const reading = useMemo(() => (messages && contextWindow !== undefined ? contextReading(messages, contextWindow) : null), [messages, contextWindow]);
		// 还没有一条写完的回复时没什么可报的：空转录旁边的「已用 1%」是一段还没开始的路的读数。
		if (!sessionId || !session || !model || !reading) return null;
		const tip = fill(text.usedPercent, { percent: reading.percent });
		return (
			<>
				<button
					type="button"
					data-plume-context-meter=""
					// 输入框底下那一排放不下模型名时，在权限签的字之后让出它：它是看一眼的读数，模型名认不出来更要紧。
					data-plume-fit-drop="2"
					data-plume-tip={tip}
					aria-label={tip}
					aria-haspopup="dialog"
					aria-expanded={popover.open}
					onClick={popover.toggle}
					className="plume-composer-control plume-composer-icon status-ring"
				>
					<Ring ratio={Math.min(1, reading.used / reading.limit)} tight={reading.tight} />
				</button>
				{popover.open && (
					// 是读数不是菜单：`group`，读屏不把它念成一列可选的东西。
					<Popover anchor={popover.anchor} onClose={popover.close} placement="top" align="center" width="panel" role="group" label={text.windowUsage}>
						<Detail
							ui={ui}
							sessionId={sessionId}
							messageCount={session.messages.length}
							reading={reading}
							onOpen={(path) => {
								popover.close();
								void ui.openFile(path, sessionId).catch((error) => ui.notify(String(error), "error"));
							}}
						/>
					</Popover>
				)}
			</>
		);
	};
}

export default {
	name: "plume.status",
	apply(ui) {
		mountStyles();
		// 读数挨着模型：窗口多大是那个模型决定的。
		ui.composerItem("context", makeMeter(ui), { side: "end" });
	},
} satisfies UiPlugin;
