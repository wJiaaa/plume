import { RollingText } from "@plume/ui";
import type { ReactNode } from "react";

/**
 * 展开的卡片里带标题的一块。命令、JSON 参数、程序输出是代码，用等宽、垫一块底：给字留出边距，也说清从哪开始到哪结束，
 * 不用再画一条线。标题在一次调用跑完时从「输出（进行中）」换成「结果」，换的时候滚一下。
 */
export function Section({
	title,
	mono = false,
	tone = "muted",
	children,
}: {
	title: string;
	mono?: boolean;
	tone?: "muted" | "ink" | "danger";
	children: ReactNode;
}) {
	const colour = tone === "danger" ? "text-danger/90" : tone === "ink" ? "text-ink" : "text-ink-muted";
	return (
		<div className="px-3 py-2.5">
			<div className="mb-1.5 text-caption tracking-wide text-ink-faint uppercase">
				<RollingText>{title}</RollingText>
			</div>
			<div className={`text-detail leading-relaxed break-words whitespace-pre-wrap ${colour} ${mono ? "rounded-lg bg-shell/70 px-2.5 py-2 font-mono" : ""}`}>
				{children}
			</div>
		</div>
	);
}
