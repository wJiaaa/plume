import { formatDate, hourStyle, IconButton, type ResolvedUiLocale, Text, translate, useCopied, useI18n } from "@plume/ui";
import { Check, Copy } from "@plume/ui/icons";
import type { ReactNode } from "react";

/**
 * 回答底下那一行：什么时候写的、这一轮花了多久，和能拿它做什么。
 *
 * 悬停才显出来：它沿着整页一路重复，满色的话会和它所属的对话抢眼。显不显都占着高度，指针往下走时转录不跟着重排。
 * 谁画它谁就挂 `group/msg`：悬停的目标是整条消息，不是这一行。
 *
 * 行高等于里面的按钮，按钮悬停的底色才不会伸出行外压到上面的字上。和上面那条消息的间距由调用方定：回复那一列已经有 `gap-2.5`。
 */
export function MessageActions({
	timestamp,
	text,
	copyText,
	className = "",
	durationMs,
	requestMs,
	sseDurationMs,
	tokens,
	requests,
	children,
}: {
	timestamp: number;
	/** 复制按钮放进剪贴板的东西。 */
	text: string;
	/** 点击时读取交互块的当前值，普通消息沿用 text。 */
	copyText?: () => string;
	className?: string;
	/** 这一轮实际跑了多久：墙钟，工具的时间都在里面。见 `turns.ts` 的 `TurnStats`。 */
	durationMs?: number | undefined;
	/** 其中模型在应答的时间，工具不在里面——只进悬浮说明。 */
	requestMs?: number | undefined;
	/** 纯出字的时间：tok/s 的分母。 */
	sseDurationMs?: number | undefined;
	/** 输出的 token：算 tok/s。 */
	tokens?: number | undefined;
	/** 这一轮发了几次请求，用来解释上面那两个数的差。 */
	requests?: number | undefined;
	children?: ReactNode;
}) {
	const { copied, mark } = useCopied();
	// 从上下文取语言：画它的行是 memo 过的，换语言只有经上下文才穿得过 memo。
	const { resolvedLocale } = useI18n();
	const timeTip = formatTimestampTip(timestamp, resolvedLocale);
	const badge = formatDurationBadge(durationMs, sseDurationMs, tokens);
	const durationTip = formatDurationTip(durationMs, requestMs, sseDurationMs, tokens, requests);

	return (
		<div
			data-plume-hover-reveal=""
			className={`flex h-6 items-center gap-1.5 opacity-0 transition-opacity duration-[var(--plume-t-quick)] group-hover/msg:opacity-100 has-[:focus-visible]:opacity-100 ${className}`}
		>
			<span data-plume-tip={timeTip || undefined} className="inline-flex items-center">
				<Text size="caption" tone="faint" numeric>
					{formatSentAt(timestamp, resolvedLocale)}
				</Text>
			</span>
			{badge && (
				/*
				 * 左边那个数是墙钟，右边那个速度的分母却是纯出字的时间——两个口径并排站着，谁也不会想到它们不是一回事。
				 * 悬浮上去把几个数一次说清楚，比挑一个口径去迁就另一个要诚实。
				 */
				<span data-plume-tip={durationTip || undefined} className="inline-flex items-center px-1 py-0.5 font-mono text-caption tabular-nums text-ink-faint">
					{badge}
				</span>
			)}
			<IconButton
				label={translate("messageActions.copyThis")}
				onClick={() => {
					void navigator.clipboard.writeText(copyText ? copyText() : text).then(() => mark(true));
				}}
				icon={copied ? <Check size={12.5} strokeWidth={2.2} className="text-ok" /> : <Copy size={12.5} strokeWidth={1.8} />}
			/>
			{children}
		</div>
	);
}

function formatDurationBadge(durationMs?: number, sseDurationMs?: number, tokens?: number): string | null {
	if (!durationMs || durationMs <= 0) return null;
	// 速度按纯出字的时间算：排队、首字延迟、连接往返都不该摊进每秒出了几个字里。
	const seconds = (sseDurationMs && sseDurationMs > 0 ? sseDurationMs : durationMs) / 1000;
	if (tokens && tokens > 0 && seconds > 0) return `${formatSpan(durationMs)} · ${(tokens / seconds).toFixed(1)} tok/s`;
	return formatSpan(durationMs);
}

/**
 * 一段时长读出来的样子。和运行行的 `formatElapsed` 同一副写法：秒向下取整、分钟补零。这一行接的正是那一行——回合一结束，
 * 运行行让位给它——两边取整方式不一样，数字会在交接的那一帧抖一下。一分钟以内多给一位小数：这是最终结果。
 */
function formatSpan(ms: number): string {
	const secs = ms / 1000;
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const whole = Math.floor(secs);
	const minutes = Math.floor(whole / 60);
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** 徽章上那两个数分别是怎么来的，悬浮才说：模型只应答了其中一段，速度是按那一段里纯出字的时间算的。 */
function formatDurationTip(durationMs?: number, requestMs?: number, sseDurationMs?: number, tokens?: number, requests?: number): string {
	const lines: string[] = [];
	if (durationMs && durationMs > 0 && requestMs && requestMs > 0 && requests && requests > 0) {
		lines.push(translate("messageActions.spanTip", { total: formatSpan(durationMs), model: formatSpan(requestMs), n: requests }));
	}
	if (tokens && tokens > 0 && sseDurationMs && sseDurationMs > 0)
		lines.push(translate("messageActions.rateTip", { n: tokens, decode: formatSpan(sseDurationMs) }));
	return lines.join("\n");
}

function formatTimestampTip(timestamp: number, locale: ResolvedUiLocale): string {
	return formatDate(timestamp, locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: hourStyle(locale), minute: "2-digit", second: "2-digit" });
}

/** 月、日、时刻，年份只在不是今年时才写。月份用短的：长的在英文里是「September 26 at 2:28 PM」，挂在每条消息底下太长。 */
function formatSentAt(timestamp: number, locale: ResolvedUiLocale): string {
	const sent = new Date(timestamp);
	const sameYear = sent.getFullYear() === new Date().getFullYear();
	return formatDate(sent, locale, { ...(sameYear ? {} : { year: "numeric" }), month: "short", day: "numeric", hour: hourStyle(locale), minute: "2-digit" });
}
