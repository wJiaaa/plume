/**
 * 窗口里说「有新版本、下到哪了」的那一处：活动栏里设置上面的一个圆，和旁边的格子一样居中。
 *
 * 带颜色，看得出是通知而不是控件。不展开成一段字：往右展开会盖到旁边的侧栏上，版本和进度写在右边的悬停提示里。
 * 下载时一圈环跟着字节合拢，关掉对话框也还在，因为下载还在（状态在主进程，这里订阅）。
 *
 * 点它在每个阶段都是打开对话框，下载中也是：在圆上直接暂停，太容易在去点别处的路上误触。
 * 没有什么能把它藏起来：有新版本就在，装上为止。
 */

import { useI18n, useTickedAnimations } from "@plume/ui";
import { ArrowDownToLine, Pause, RefreshCw, TriangleAlert } from "@plume/ui/icons";
import { useRef, useState } from "react";
import type { UpdatePhase } from "../../shared/update.ts";
import { check, useUpdate } from "./store.ts";
import { UpdateDialog } from "./UpdateDialog.tsx";
import { fractionOf, labelFor, shouldShow } from "./view.ts";

export function UpdateBadge() {
	const { t } = useI18n();
	const { info, phase } = useUpdate();
	const [open, setOpen] = useState(false);

	if (!info || !shouldShow(info)) return null;

	const fraction = fractionOf(phase);
	// 比活动栏的格子（32px）小一圈，实心的淡底不比旁边的线条图标抢眼。
	const size = 28;
	const glyph = 13;
	const label = labelFor(phase, info.latest, t);

	return (
		<>
			<button
				type="button"
				onClick={() => {
					setOpen(true);
					// 缓存的回答可能是几小时前的；只在空闲时重查，下载中换掉版本会换掉正在下的东西。
					if (phase.at === "idle") void check(true);
				}}
				aria-label={label}
				data-plume-tip={label}
				data-plume-tip-side="right"
				data-phase={phase.at}
				data-plume-update-dot=""
				style={{ width: size, height: size }}
				className="update-dot flex shrink-0 items-center justify-center rounded-full"
			>
				<span className="relative flex shrink-0 items-center justify-center">
					{fraction !== null ? <ProgressRing fraction={fraction} spinning={phase.at === "preparing"} inset={(size - 2 - glyph) / 2} /> : null}
					<PhaseGlyph phase={phase} size={glyph} />
				</span>
			</button>
			{open ? <UpdateDialog info={info} phase={phase} onClose={() => setOpen(false)} /> : null}
		</>
	);
}

/** 中间的图标说这是关于什么。暂停画出暂停：不动的下载和在动的看起来一模一样。 */
function PhaseGlyph({ phase, size }: { phase: UpdatePhase; size: number }) {
	if (phase.at === "failed") return <TriangleAlert size={size} strokeWidth={2.4} className="shrink-0" />;
	if (phase.at === "ready") return <RefreshCw size={size} strokeWidth={2.6} className="shrink-0" />;
	if (phase.at === "paused") return <Pause size={size - 1} strokeWidth={2.6} className="shrink-0" fill="currentColor" />;
	return <ArrowDownToLine size={size + 1} strokeWidth={2.4} className="shrink-0" />;
}

const SPIN: ReadonlySet<string> = new Set(["plume-spin"]);

/**
 * 随下载合拢的环，从十二点钟开始。刚开始的几秒四舍五入是 0%，留一点看得见的最小值，不然和没开始分不清。
 * 准备中没有百分比可画，是四分之一段弧绕着转（`data-spinning`，见 styles.css）。
 */
function ProgressRing({ fraction, spinning, inset }: { fraction: number; spinning: boolean; inset: number }) {
	const radius = 10;
	const circumference = 2 * Math.PI * radius;
	// 转圈按拍走，不按帧：SVG 的转动每帧都要重排，见 `@plume/ui` 的 `motion/ticked.ts`。
	const ring = useRef<SVGSVGElement>(null);
	useTickedAnimations(ring, SPIN, spinning);
	return (
		<svg
			ref={ring}
			aria-hidden
			data-ring=""
			data-spinning={spinning ? "" : undefined}
			viewBox="0 0 24 24"
			style={{ inset: -inset }}
			className="absolute -rotate-90"
		>
			{/* 轨道：8% 的弧看得出是一圈里的一小段，而不是孤零零一个点。 */}
			<circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.32" />
			<circle
				cx="12"
				cy="12"
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeDasharray={circumference}
				strokeDashoffset={circumference * (1 - (spinning ? 0.25 : Math.max(0.07, fraction)))}
				className="transition-[stroke-dashoffset] duration-[var(--plume-t-slow)] ease-out"
			/>
		</svg>
	);
}
