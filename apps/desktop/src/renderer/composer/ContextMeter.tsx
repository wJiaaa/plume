/**
 * 输入框工具栏右边、模型选择前面的上下文用量。
 *
 * 圆环只回答「快满了吗」；点开回答「为什么」：对话消息、工具表、系统提示词各占多少，真要动手时看的是这个。
 * 项目指令和记忆收在「记忆文件」一行里，展开按文件列出：该去删哪份没人再读的 AGENTS.md，看的是这里。
 * 圆环和总数从会话的消息里算（context-usage.ts），分段在点开时向 agent 进程要（`contextBreakdown`）。
 */

import type { ContextBreakdown, ContextSegmentKey, SessionView } from "@plume/contract";
import { Disclosure, type MessageKey, Popover, ScrollText, Text, useI18n, usePopover } from "@plume/ui";
import { FileText } from "@plume/ui/icons";
import { useEffect, useMemo, useState } from "react";
import { formatTokens } from "../conversation/running-line.ts";
import { openFile } from "../files/open-file.ts";
import { modelsAgent } from "../models/store.ts";
import { notify } from "../toast/index.ts";
import { type ContextReading, contextReading } from "./context-usage.ts";

/**
 * 和转圈的那个同一种画法——24 的视框里半径 9、线宽 3.4——两个记号读起来是一家。转四分之一圈，从十二点起：
 * 不从十二点起的表盘，扫一眼读不出来。轨道比转圈的那个重：这个不动，读数低时弧只有几个像素，轨道太淡整个控件就融进输入框了。
 */
function Ring({ ratio, tight }: { ratio: number; tight: boolean }) {
	const circumference = 2 * Math.PI * 9;
	return (
		<svg width={14} height={14} viewBox="0 0 24 24" aria-hidden>
			<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3.4" className="text-line" />
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
				className={tight ? "text-danger" : "text-accent"}
			/>
		</svg>
	);
}

/**
 * 色块：一段一种颜色，按段定死、不按大小排第几——同一段在哪个会话里都是同一个颜色，认颜色就认出是哪一段。
 * 项目指令和记忆收在「记忆文件」一行里，两段取相邻的绿和青。对话消息用字色：它是唯一一直在长的一段，压在最显眼的那一档。
 * `used` 是分段还没到（或给不出）时已用的那一整段，`free` 是剩余空间。
 */
type Swatch = ContextSegmentKey | "used" | "free";

const SWATCHES: Record<Swatch, string> = {
	systemPrompt: "bg-accent",
	projectInstructions: "bg-ok",
	memory: "bg-chart-2",
	tools: "bg-violet",
	mcpTools: "bg-chart-5",
	skills: "bg-chart-3",
	messages: "bg-ink",
	used: "bg-accent",
	free: "bg-line",
};

function Row({ swatch, label, tokens }: { swatch: Swatch; label: string; tokens: number }) {
	return (
		<div className="flex items-center gap-2.5 py-0.5">
			<span className={`size-2 shrink-0 rounded-full ${SWATCHES[swatch]}`} />
			<Text className="min-w-0 flex-1 truncate">{label}</Text>
			<Text numeric>{formatTokens(tokens)}</Text>
		</div>
	);
}

/** 收进「记忆文件」那一行的两段，不单独列行；进度条上照样各占一截。 */
const MEMORY_SEGMENTS: ReadonlySet<ContextSegmentKey> = new Set(["projectInstructions", "memory"]);

/** 「记忆文件」折叠行：右边是两段合计和文件数，展开列出各文件，点一个在文件面板里打开。 */
function MemoryFiles({ breakdown, onOpen }: { breakdown: ContextBreakdown; onOpen: (path: string) => void }) {
	const { t } = useI18n();
	const files = breakdown.memoryFiles;
	const tokens = breakdown.segments.filter((segment) => MEMORY_SEGMENTS.has(segment.key)).reduce((sum, segment) => sum + segment.tokens, 0);
	return (
		<Disclosure
			variant="compact"
			title={t("contextMeter.memoryFiles")}
			trailing={
				<Text size="detail" tone="faint" numeric>
					{t("contextMeter.fileCount", { n: files.length })} · {formatTokens(tokens)}
				</Text>
			}
		>
			{files.map((file) => (
				// 平时是淡字，指针经过时整行变深，说明它能点开。
				<button
					key={file.path}
					type="button"
					data-plume-memory-file=""
					data-plume-tip={file.path}
					className="plume-scroll group flex w-full items-center gap-1.5 py-1 text-left text-ink-faint transition-colors hover:text-ink"
					onClick={() => onOpen(file.path)}
				>
					<FileText size={12} strokeWidth={1.8} className="shrink-0" />
					<Text size="caption" tone="faint" mono className="flex min-w-0 flex-1 transition-colors group-hover:text-ink">
						<ScrollText text={file.path} />
					</Text>
					<Text size="detail" tone="faint" numeric className="transition-colors group-hover:text-ink">
						{formatTokens(file.tokens)}
					</Text>
				</button>
			))}
			{files.length === 0 && (
				<Text as="p" size="detail" tone="faint" className="py-1">
					{t("contextMeter.noMemoryFiles")}
				</Text>
			)}
		</Disclosure>
	);
}

/**
 * 点开后的读数。分段只在开着时向 agent 进程要：它每次现算，关着时不必跟着每条消息算。开着时来了新消息就再要一次。
 * 要到之前（`undefined`）只画总数；给不出分段（本次启动后这个会话还没发过请求，或者出错）时，已用的整个算一段。
 */
function Detail({
	sessionId,
	messageCount,
	reading,
	onOpen,
}: {
	sessionId: string;
	messageCount: number;
	reading: ContextReading;
	onOpen: (path: string) => void;
}) {
	const { t } = useI18n();
	const [detail, setDetail] = useState<{ sessionId: string; breakdown: ContextBreakdown | null } | undefined>(undefined);
	useEffect(() => {
		let live = true;
		void modelsAgent()
			.contextBreakdown(sessionId)
			.then(
				(breakdown) => live && setDetail({ sessionId, breakdown }),
				() => live && setDetail({ sessionId, breakdown: null }),
			);
		return () => {
			live = false;
		};
	}, [sessionId, messageCount]);
	const current = detail?.sessionId === sessionId ? detail : undefined;
	const segments = current?.breakdown?.segments ?? [];
	const { used, limit, tight } = reading;
	const free = Math.max(0, limit - used);
	return (
		<div className="px-3.5 py-3">
			<div className="flex items-baseline justify-between gap-4">
				<Text weight="medium">{t("contextMeter.window")}</Text>
				<Text tone={tight ? "danger" : "muted"} numeric>
					{t("contextMeter.percentUsed", { percent: reading.percent })}
				</Text>
			</div>
			{/* 各段是轨道上一颗一颗的胶囊，中间留缝：颜色相近的两段靠缝分开。再小的一段也留 3px，不然在条上找不到。 */}
			<div className="mt-2.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-line">
				{segments.length === 0 ? (
					// 分段还没到时，条上也先画出已经知道的总数。
					<div className={`h-full min-w-0.75 rounded-full ${SWATCHES.used}`} style={{ width: `${Math.min(1, used / limit) * 100}%` }} />
				) : (
					segments.map((segment) => (
						<div
							key={segment.key}
							className={`h-full min-w-0.75 rounded-full ${SWATCHES[segment.key]}`}
							style={{ width: `${(segment.tokens / limit) * 100}%` }}
						/>
					))
				)}
			</div>
			<Text as="p" size="detail" tone="faint" numeric className="mt-1.5">
				{t("contextMeter.usedOfLimit", { used: formatTokens(used), limit: formatTokens(limit) })}
			</Text>
			{current && (
				<div className="mt-3 flex flex-col gap-0.5">
					{segments.length > 0 ? (
						segments.map((segment) =>
							MEMORY_SEGMENTS.has(segment.key) ? null : (
								<Row
									key={segment.key}
									swatch={segment.key}
									// 工具表在 Plume 都来自插件，MCP 服务的单列一段，其余的不叫「内置工具」。
									label={t(`contextMeter.segment.${segment.key}` satisfies MessageKey)}
									tokens={segment.tokens}
								/>
							),
						)
					) : (
						<Row swatch="used" label={t("contextMeter.used")} tokens={used} />
					)}
					<Row swatch="free" label={t("contextMeter.remaining")} tokens={free} />
					{current.breakdown && <MemoryFiles breakdown={current.breakdown} onOpen={onOpen} />}
				</div>
			)}
			{tight && (
				// 接近上限的提醒：放在最后，上面一道细线隔开。占比已经红了，各段保持自己的颜色，才看得出是哪一段撑满的。
				<Text as="p" size="detail" tone="faint" className="mt-2.5 border-t border-line-float pt-2.5">
					{t("contextMeter.nearLimit")}
				</Text>
			)}
		</div>
	);
}

/** `view` 是这个输入框的会话（新对话里还没有），`contextWindow` 是下一轮会用的模型的窗口（没有可用模型时为空）：读数挨着模型，窗口多大是那个模型决定的。 */
export function ContextMeter({ view, contextWindow }: { view?: SessionView | undefined; contextWindow?: number | undefined }) {
	const { t } = useI18n();
	const popover = usePopover();
	// 按消息记住：输出时视图每一拍都换，消息没变，不用每拍把整段转录再数一遍。
	const messages = view?.messages;
	const reading = useMemo(() => (messages && contextWindow !== undefined ? contextReading(messages, contextWindow) : null), [messages, contextWindow]);
	// 还没有一条写完的回复时没什么可报的：空转录旁边的「已用 1%」是一段还没开始的路的读数。
	if (!view || !reading) return null;
	const sessionId = view.summary.id;
	const tip = t("contextMeter.usedPercent", { percent: reading.percent });
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
				// 悬停不铺底色，和旁边的按钮不同：圆环是读数，card-hover 的底和轨道几乎一个颜色，铺上去占比就看不清了。改成提亮圆环本身，一样说明「这能点」。
				className="plume-composer-control plume-composer-icon flex shrink-0 items-center justify-center rounded-field opacity-80 transition-opacity hover:opacity-100 aria-expanded:opacity-100"
			>
				<Ring ratio={Math.min(1, reading.used / reading.limit)} tight={reading.tight} />
			</button>
			{popover.open && (
				// 是读数不是菜单：`group`，读屏不把它念成一列可选的东西。
				<Popover
					anchor={popover.anchor}
					onClose={popover.close}
					placement="top"
					align="center"
					width="panel"
					role="group"
					label={t("contextMeter.windowUsage")}
				>
					<Detail
						sessionId={sessionId}
						messageCount={view.messages.length}
						reading={reading}
						onOpen={(path) => {
							popover.close();
							void openFile(path, undefined, sessionId).catch((error) => notify(String(error), "error"));
						}}
					/>
				</Popover>
			)}
		</>
	);
}
