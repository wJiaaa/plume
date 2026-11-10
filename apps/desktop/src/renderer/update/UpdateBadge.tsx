/**
 * 窗口里说「有新版本、下到哪了」的那一处：侧栏底行末尾的一个圆点，悬停展开写它是什么。
 *
 * 带颜色，看得出是通知而不是控件；句号那么大，不占窗口的地方；字在悬停时才出来。下载时一圈环跟着字节合拢，
 * 关掉对话框也还在，因为下载还在（状态在主进程，这里订阅）。
 *
 * 点它在每个阶段都是打开对话框，下载中也是：在 20px 的圆上直接暂停，太容易在去点别处的路上误触。
 * 没有什么能把它藏起来：有新版本就在，装上为止。
 */

import { ActionSpinner, useI18n } from "@plume/ui";
import { ArrowDownToLine, Pause, RefreshCw, TriangleAlert } from "@plume/ui/icons";
import { useState } from "react";
import type { UpdatePhase } from "../../shared/update.ts";
import { check, useUpdate } from "./store.ts";
import { UpdateDialog } from "./UpdateDialog.tsx";
import { fractionOf, labelFor, shouldShow } from "./view.ts";

export function UpdateBadge({ compact = false }: { compact?: boolean }) {
	const { t } = useI18n();
	const { info, phase } = useUpdate();
	const [open, setOpen] = useState(false);

	if (!info || !shouldShow(info)) return null;

	const fraction = fractionOf(phase);
	// 按旁边 16px 的线条图标定大小，不按这一行的高度。
	const size = compact ? 22 : 20;
	const glyph = compact ? 12 : 11;
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
				data-phase={phase.at}
				data-plume-update-dot=""
				// 左右内边距是圆和图标之差的一半，收起时宽等于高。
				style={{ height: size, paddingInline: (size - glyph) / 2 }}
				className="update-dot flex shrink-0 items-center rounded-full text-caption font-medium whitespace-nowrap"
			>
				<span className="relative flex shrink-0 items-center justify-center">
					{/* 环套在图标上，不套在按钮上：按钮悬停时变成胶囊，图标一直是圆的。 */}
					{fraction !== null && phase.at !== "preparing" ? <ProgressRing fraction={fraction} inset={(size - 2 - glyph) / 2} /> : null}
					<PhaseGlyph phase={phase} size={glyph} />
				</span>
				{/* 外层把宽度从 0fr 展到 1fr，里层裁掉还放不下的部分。 */}
				<span className="update-dot-label">
					<span>
						<span className="pl-1.5 tabular-nums">{label}</span>
					</span>
				</span>
			</button>
			{open ? <UpdateDialog info={info} phase={phase} onClose={() => setOpen(false)} /> : null}
		</>
	);
}

/** 中间的图标说这是关于什么。暂停画出暂停：不动的下载和在动的看起来一模一样。准备中没有百分比可画，转一个圈。 */
function PhaseGlyph({ phase, size }: { phase: UpdatePhase; size: number }) {
	if (phase.at === "failed") return <TriangleAlert size={size} strokeWidth={2.4} className="shrink-0" />;
	if (phase.at === "ready") return <RefreshCw size={size} strokeWidth={2.6} className="shrink-0" />;
	if (phase.at === "paused") return <Pause size={size - 1} strokeWidth={2.6} className="shrink-0" fill="currentColor" />;
	if (phase.at === "preparing") return <ActionSpinner size={size + 2} />;
	return <ArrowDownToLine size={size + 1} strokeWidth={2.4} className="shrink-0" />;
}

/** 随下载合拢的环，从十二点钟开始。刚开始的几秒四舍五入是 0%，留一点看得见的最小值，不然和没开始分不清。 */
function ProgressRing({ fraction, inset }: { fraction: number; inset: number }) {
	const radius = 10;
	const circumference = 2 * Math.PI * radius;
	return (
		<svg aria-hidden data-ring="" viewBox="0 0 24 24" style={{ inset: -inset }} className="absolute -rotate-90">
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
				strokeDashoffset={circumference * (1 - Math.max(0.07, fraction))}
				className="transition-[stroke-dashoffset] duration-[var(--plume-t-slow)] ease-out"
			/>
		</svg>
	);
}
