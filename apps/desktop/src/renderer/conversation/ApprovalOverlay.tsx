/**
 * 等人决定的那一次工具调用，压在输入框正上方：对话照样能往上翻，挡住的只有输入框。
 *
 * 卡片放在输入框上方而不是工具卡片下面：人的视线本来就停在输入框这里，而且卡片按正常流占住自己的高度，
 * 对话在它上面滚，不会被它盖住。外框（收放的标题栏、倒计时、+N）是 `@plume/ui` 的 `ApprovalFrame`，插件画的提问卡也用它。
 *
 * 审批（放不放行）只有这一张卡，插件换不掉。
 * 同一格也摆等人给数据的卡（`run.request`，提问卡、计划卡、表单）：插件按 `kind` 登记（`ui.requestCard`），没有时退回一张只能「不答」的通用卡。
 */

import type { ApprovalDecision, ApprovalRequest, HumanRequest, PendingRequest, ToolKind } from "@plume/contract";
import { ApprovalFrame, Button, type MessageKey, Scroller, translate, useI18n } from "@plume/ui";
import { Check, MessageCircle, ShieldCheck, TriangleAlert, X } from "@plume/ui/icons";
import { useRef, useState } from "react";
import { RequestCardSlot } from "../plugins.tsx";

/** 卡片右上角的小标签：要做的是哪一类事（`ApprovalRequest.kind` 是 `ToolKind` 里这几种时）；别的照原样写。 */
const KIND_LABEL: Partial<Record<string, MessageKey>> = {
	command: "approval.command",
	create: "approval.create",
	modify: "approval.modify",
	view: "approval.view",
} satisfies Partial<Record<ToolKind, MessageKey>>;

/** 理由和正文只差空白时不再重复一遍。 */
function approvalReason(reason: string | undefined, detail: string): string | undefined {
	const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
	return reason && normalize(reason) && normalize(reason) !== normalize(detail) ? reason : undefined;
}

/**
 * `from`：问的是插件的子会话（侧边聊天、子 Agent），卡上写明是它在请求，给它的标题。
 * `compact`：窄窗口，面板区一次只摆一格，交给插件画的等人卡（打开面板会盖住卡片）。
 * `queued`：排在这张后面还在等的张数。`respond` 答审批（等人给数据的卡上「不答」也是它的 `reject`），`answer` 交回数据。
 */
export function ApprovalOverlay({
	request,
	queued = 0,
	sessionId,
	respond,
	answer,
	from,
	compact,
}: {
	request: PendingRequest | undefined;
	queued?: number | undefined;
	sessionId: string;
	respond: (decision: ApprovalDecision) => Promise<void>;
	answer: (value: unknown) => Promise<void>;
	from?: string;
	compact: boolean;
}) {
	if (!request) return null;
	const source = from !== undefined ? { from } : {};
	return (
		<div data-approval-region="" className="flex shrink-0 justify-center pb-2">
			{request.type === "request" ? (
				<RequestCardSlot
					request={request}
					queued={queued}
					sessionId={sessionId}
					answer={answer}
					decline={() => respond("reject")}
					compact={compact}
					{...source}
					fallback={<RequestFallback request={request} queued={queued} decline={() => respond("reject")} {...source} />}
				/>
			) : (
				<PermissionCard request={request} queued={queued} respond={respond} {...source} />
			)}
		</div>
	);
}

/** 来源一行：子会话问的，写明是谁在请求。 */
function FromLine({ from }: { from: string | undefined }) {
	if (from === undefined) return null;
	return (
		<p className="mb-1.5 break-words text-caption text-ink-faint" data-approval-from="">
			{translate("approval.fromChild", { title: from || translate("approval.childUntitled") })}
		</p>
	);
}

/**
 * 等人给数据、却没有插件能画的卡（插件停用了、渲染出错）：产品不知道要的是什么，画不出填的地方，只给标题和「不答」，
 * 工具照「人没答」收场，不至于卡到过期。
 */
function RequestFallback({ request, queued, decline, from }: { request: HumanRequest; queued: number; decline: () => Promise<void>; from?: string }) {
	useI18n();
	const { pending, error, submit } = useOnceAnswer(decline);
	return (
		<ApprovalFrame
			requestId={request.toolCallId}
			icon={<MessageCircle size={15} strokeWidth={1.8} className="shrink-0 text-accent" />}
			title={request.title}
			kind={request.kind}
			expiresAt={request.expiresAt}
			queued={queued}
		>
			<div className="px-4 py-2">
				<FromLine from={from} />
				<p className="break-words text-label text-ink-muted">{translate("approval.requestUnavailable")}</p>
			</div>
			<div className="shrink-0 px-4 pt-1 pb-3" data-request-fallback="">
				<div className="flex items-center justify-end" aria-busy={pending}>
					<Button variant="subtle" disabled={pending} onClick={() => void submit(undefined)} icon={<X size={14} />}>
						{translate("approval.decline")}
					</Button>
				</div>
				{error && (
					<p role="alert" className="mt-2 break-words text-caption text-danger">
						{error}
					</p>
				)}
			</div>
		</ApprovalFrame>
	);
}

function PermissionCard({
	request,
	queued,
	respond,
	from,
}: {
	request: ApprovalRequest;
	queued: number;
	respond: (decision: ApprovalDecision) => Promise<void>;
	from?: string;
}) {
	// 订阅语言：换语言时卡片跟着换。
	useI18n();
	const reason = approvalReason(request.reason, request.detail);
	const label = KIND_LABEL[request.kind];
	return (
		<ApprovalFrame
			requestId={request.toolCallId}
			icon={<TriangleAlert size={15} strokeWidth={1.8} className="shrink-0 text-accent" />}
			title={request.title}
			kind={label ? translate(label) : request.kind}
			expiresAt={request.expiresAt}
			queued={queued}
		>
			<Scroller className="plume-approval-scroll mx-2 max-h-[min(280px,30dvh)]" contentClassName="px-2 py-2">
				<FromLine from={from} />
				{reason && <p className="mb-2.5 whitespace-pre-wrap break-words text-label leading-relaxed text-ink">{reason}</p>}
				<pre className="whitespace-pre-wrap break-words font-mono text-code text-ink-muted">{request.detail}</pre>
			</Scroller>
			<PermissionChoices
				key={request.toolCallId}
				subject={request.subject}
				onceOnly={request.escalation !== undefined || request.subject === undefined}
				answer={respond}
			/>
		</ApprovalFrame>
	);
}

/**
 * 三个答案，字写在按钮上：两个是不可撤销的（放行一次、以后都不再问），只有图标的话要停下来悬停才敢点。
 * 「拒绝」推到最左，和右边两个隔开：相邻的一次误点代价不对称，最贵的那个不该挨着最便宜的。
 */
function PermissionChoices({
	subject,
	onceOnly,
	answer,
}: {
	subject?: string;
	/** 只能放行这一次（提权，或者没有可记的东西），不给「以后不再问」。 */
	onceOnly: boolean;
	answer(decision: ApprovalDecision): Promise<void>;
}) {
	const { pending, error, submit } = useOnceAnswer(answer);
	return (
		<div className="shrink-0 px-4 pt-1 pb-3" data-permission-choices="">
			<div className="flex flex-wrap items-center justify-end gap-1.5" aria-busy={pending}>
				<Button variant="subtle" disabled={pending} onClick={() => void submit("reject")} className="mr-auto" icon={<X size={14} />}>
					{translate("permission.reject")}
				</Button>
				{!onceOnly && (
					<Button
						variant="subtle"
						disabled={pending}
						onClick={() => void submit("always")}
						label={subject ? translate("permission.neverAskFor", { subject }) : translate("permission.neverAsk")}
						icon={<ShieldCheck size={14} />}
					>
						{translate("permission.never")}
					</Button>
				)}
				<Button variant="primary" disabled={pending} onClick={() => void submit("once")} icon={<Check size={14} />}>
					{translate("permission.once")}
				</Button>
			</div>
			{error && (
				<p role="alert" className="mt-2 break-words text-caption text-danger">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * 答一次：答出去之前按钮全灰，再按也不会发第二遍；没送到就把错误摆出来，按钮放开让人再答。
 * 挡第二遍靠 ref 不靠 state：一次双击的两下落在同一帧里，state 还没渲染出来，两下读到的都是 false。
 */
function useOnceAnswer<D>(answer: (decision: D) => Promise<void>) {
	const submitting = useRef(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	async function submit(decision: D) {
		if (submitting.current) return;
		submitting.current = true;
		setPending(true);
		setError("");
		try {
			await answer(decision);
		} catch (failure) {
			submitting.current = false;
			setPending(false);
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}
	return { pending, error, submit };
}
