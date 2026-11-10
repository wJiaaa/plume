/**
 * 审批卡的外框：压在输入框正上方的那块玻璃。标题栏整条是收放的按钮，不只是右端那颗箭头：点在标题上也能收起，
 * 键盘也落得到；收起时只剩一行，想先往上看看上下文也不用答。
 *
 * 产品的通用审批卡和插件画的提问卡共用它，同一个位置上的卡片长一个样；正文和按钮放在 `children` 里，跟着一起收。
 * 标题栏右边依次是类型小标签、倒计时（`ApprovalExpiry`）和后面还排着几张（+N）。
 */

import { type ReactNode, useState } from "react";
import { translate } from "../i18n/translate.ts";
import { useNow } from "../motion/useNow.ts";
import { Caret } from "../primitives/Caret.tsx";
import { Collapse } from "./Collapse.tsx";

/**
 * 这张卡还剩多久失效，每秒走一格（「4:59 后失效」）。到期没人答，本体按拒绝收场：不说出来的截止比没有截止更糟，
 * 人回来时这一轮已经被一个没见过的「不」结束了。
 *
 * 单独一个组件，秒针走动不重画旁边正在打字的表单。走到零就不说了：正常情况下卡片这一刻已经收走，留下的只可能是
 * 一份过时的快照，「0:00 后失效」不该出现。
 */
export function ApprovalExpiry({ at }: { at: number }) {
	const now = useNow(true, 1000);
	const left = at - now;
	if (left <= 0) return null;
	const minutes = Math.floor(left / 60_000);
	const seconds = Math.floor((left % 60_000) / 1000);
	return (
		<span className="shrink-0 tabular-nums text-caption text-ink-faint" data-approval-expiry="">
			{translate("approval.expiresIn", { time: `${minutes}:${String(seconds).padStart(2, "0")}` })}
		</span>
	);
}

export function ApprovalFrame({
	requestId,
	icon,
	title,
	kind,
	expiresAt,
	queued = 0,
	children,
}: {
	/** 这次请求的 id（`toolCallId`）：换了一张卡，收起状态不带过去。 */
	requestId: string;
	/** 标题前 15px 的图标：权限请求是警告，提问是气泡。 */
	icon: ReactNode;
	title: ReactNode;
	/** 类型小标签（「执行命令」）；提问这类不是权限的不写。 */
	kind?: string;
	/** `ApprovalRequest.expiresAt`，有就画倒计时。 */
	expiresAt?: number | undefined;
	/** 排在这张后面还在等的张数，大于 0 时写 +N。 */
	queued?: number;
	/** 正文和按钮，收起时一起收。 */
	children: ReactNode;
}) {
	// 记的是收起了哪一张：换了一张卡就是展开的，上一张收起来不等于这一张也不想看。
	const [collapsedId, setCollapsedId] = useState<string | null>(null);
	const collapsed = collapsedId === requestId;
	return (
		<div
			data-approval-card=""
			className="flex max-h-[min(560px,calc(100dvh-14rem))] w-full flex-col overflow-hidden rounded-xl border border-line bg-float/92 shadow-glass backdrop-blur-2xl backdrop-saturate-160"
		>
			<button
				type="button"
				aria-expanded={!collapsed}
				onClick={() => setCollapsedId(collapsed ? null : requestId)}
				className="group/head flex w-full shrink-0 cursor-pointer items-center gap-2 px-4 py-2.5 text-left"
				data-approval-head=""
			>
				{icon}
				<span className="min-w-0 flex-1 break-words text-label font-medium text-ink" data-approval-title="">
					{title}
				</span>
				{kind !== undefined && <span className="shrink-0 text-caption text-ink-faint">{kind}</span>}
				{expiresAt !== undefined && <ApprovalExpiry at={expiresAt} />}
				{queued > 0 && (
					<span className="shrink-0 text-caption text-ink-faint" data-approval-queued={queued}>
						+{queued}
					</span>
				)}
				<span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center text-ink-faint transition-colors group-hover/head:text-ink">
					<Caret open={!collapsed} size={15} />
				</span>
			</button>
			<Collapse open={!collapsed} keepMounted className="min-h-0" bodyClassName="flex min-h-0 flex-col overflow-hidden">
				{children}
			</Collapse>
		</div>
	);
}
