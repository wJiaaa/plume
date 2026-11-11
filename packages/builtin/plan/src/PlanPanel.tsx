/**
 * 右栏的计划面板：把计划摊开读，等审批时划一段字就地留评论。
 *
 * 评论本身列在审批卡上（`PlanApproval.tsx`），由那里修订或带着接受；面板上那段字画下划线、末尾挂一枚和卡上同号的序号。
 * 批准或打回以后面板只读，那份计划留着看。等审批时正文用审批卡上那一份；其余时候从会话消息里读最后交上来的那份，
 * 重启以后也还在。一个会话批准过好几份时，状态那一行右边能切到别的批准过的那几份，打回的不列。
 */

import type { PanelProps, UiContext } from "@plume/contract/ui";
import {
	Button,
	Caret,
	IconButton,
	MarkNumber,
	MenuBody,
	MenuItem,
	PanelEmpty,
	Popover,
	relativeTime,
	Scroller,
	Text,
	Textarea,
	useI18n,
	usePopover,
} from "@plume/ui";
import { ArrowUp, ListOrdered, MessageSquare } from "@plume/ui/icons";
import { textarea } from "@plume/styles";
import { useEffect, useMemo, useRef, useState } from "react";
import { offsetIn, paint, rangeIn, selectedText } from "./anchor.ts";
import { MESSAGES } from "./messages.ts";
import { approvedPlans, currentPlan, planTitle, renderPlan } from "./plan.ts";
import { addComment, useReview, useViewing, viewPlan } from "./review.ts";

interface Draft {
	start: number;
	end: number;
	quote: string;
	/** 评论框挂在选区左下角，滚动时跟着那段字挪。 */
	at: { x: number; y: number };
}

interface Mark {
	id: string;
	n: number;
	x: number;
	y: number;
}

const EMPTY: never[] = [];

/**
 * 这段字最后一个字的右上角，相对正文左上角：序号像脚注一样挂在那里，圆心落在这一行的上沿。
 * 挂在下划线末端会压住下一个字的下半截，句读整个被盖住。
 */
function markAt(body: HTMLElement, start: number, end: number): Pick<Mark, "x" | "y"> | null {
	const rects = rangeIn(body, start, end)?.getClientRects();
	const last = rects && [...rects].reverse().find((rect) => rect.width > 0);
	if (!last) return null;
	const origin = body.getBoundingClientRect();
	return { x: Math.round(last.right - origin.left - 2), y: Math.round(last.top - origin.top + 1) };
}

function atOf(range: Range): Draft["at"] {
	const rect = range.getBoundingClientRect();
	return { x: rect.left, y: rect.bottom };
}

export function planPanel(ui: UiContext) {
	return function PlanPanel({ session }: PanelProps) {
		const t = MESSAGES[useI18n().resolvedLocale];
		const sessionId = session?.summary.id;
		const messages = session?.messages ?? EMPTY;
		const review = useReview(sessionId);
		const pending = Boolean(review && session?.approval?.toolCallId === review.requestId);
		const comments = pending && review ? review.comments : EMPTY;
		const current = useMemo(() => currentPlan(messages), [messages]);
		const plans = useMemo(() => approvedPlans(messages), [messages]);
		const viewing = useViewing(sessionId);
		const picked = pending ? undefined : plans.find((plan) => plan.approvedAt === viewing);
		const approved = current?.status === "approved";
		const text = pending && review ? review.text : picked ? renderPlan(picked.plan, picked.notes) : (current?.plan ?? null);
		// 摊开的是哪一份批准的计划：挑过的那份；没挑过而最后交的那份批准了，它就是列表里最后一份。
		const shownAt = picked?.approvedAt ?? (approved ? plans.at(-1)?.approvedAt : undefined);
		const switchable = !pending && plans.some((plan) => plan.approvedAt !== shownAt);
		const menu = usePopover();
		const bodyRef = useRef<HTMLDivElement>(null);
		const scrollRef = useRef<HTMLDivElement>(null);
		const [owner] = useState(() => Symbol("plan-panel"));
		const [draft, setDraft] = useState<Draft | null>(null);
		const [note, setNote] = useState("");
		const [marks, setMarks] = useState<Mark[]>([]);

		// 已经评论过的那几段一直标着；换了一份计划或者审批结束，标记跟着评论一起没了。
		useEffect(() => {
			const body = bodyRef.current;
			const ranges = body ? comments.flatMap((comment) => rangeIn(body, comment.start, comment.end) ?? []) : [];
			paint(owner, "plume-plan-comment", ranges);
			if (!body || comments.length === 0) {
				setMarks([]);
				return;
			}
			// 序号跟着正文折行：面板变宽变窄时重新量。
			const place = () =>
				setMarks(
					comments.flatMap((comment, index) => {
						const at = markAt(body, comment.start, comment.end);
						return at ? [{ id: comment.id, n: index + 1, ...at }] : [];
					}),
				);
			place();
			const watch = new ResizeObserver(place);
			watch.observe(body);
			return () => watch.disconnect();
		}, [owner, comments, text]);

		// 正在写评论的那一段：焦点进了评论框，原生选区就没了，得另外标着人才知道在评哪儿。
		const start = draft?.start;
		const end = draft?.end;
		useEffect(() => {
			const body = bodyRef.current;
			const range = body && start !== undefined && end !== undefined ? rangeIn(body, start, end) : null;
			paint(owner, "plume-plan-draft", range ? [range] : []);
		}, [owner, start, end]);

		useEffect(
			() => () => {
				paint(owner, "plume-plan-comment", []);
				paint(owner, "plume-plan-draft", []);
			},
			[owner],
		);

		// 审批结束时手上那条没写完的评论没处可去了，收起来。
		useEffect(() => {
			if (!pending) setDraft(null);
		}, [pending]);

		useEffect(() => {
			const box = scrollRef.current;
			if (!box || start === undefined || end === undefined) return;
			let frame = 0;
			const onScroll = () => {
				if (frame) return;
				frame = requestAnimationFrame(() => {
					frame = 0;
					const body = bodyRef.current;
					const range = body ? rangeIn(body, start, end) : null;
					if (range) setDraft((was) => (was ? { ...was, at: atOf(range) } : was));
				});
			};
			box.addEventListener("scroll", onScroll, { passive: true });
			return () => {
				cancelAnimationFrame(frame);
				box.removeEventListener("scroll", onScroll);
			};
		}, [start, end]);

		if (!sessionId || text === null) return <PanelEmpty icon={ListOrdered} title={t.none} />;

		const pick = () => {
			const body = bodyRef.current;
			const selection = window.getSelection();
			if (!pending || !body || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
			const chosen = selectedText(selection.getRangeAt(0));
			if (!body.contains(chosen.startContainer) || !body.contains(chosen.endContainer)) return;
			const quote = chosen.toString().trim();
			if (!quote) return;
			setNote("");
			setDraft({
				start: offsetIn(body, chosen.startContainer, chosen.startOffset),
				end: offsetIn(body, chosen.endContainer, chosen.endOffset),
				quote,
				at: atOf(chosen),
			});
		};

		const commit = () => {
			if (!draft || !note.trim()) return;
			addComment(sessionId, { quote: draft.quote, start: draft.start, end: draft.end, text: note.trim() });
			window.getSelection()?.removeAllRanges();
			setDraft(null);
		};

		return (
			<>
				<Scroller className="plume-plan-panel" contentClassName="plume-plan-body" scrollRef={scrollRef}>
					{pending ? (
						<Text as="p" size="caption" tone="faint" className="plume-plan-status" data-plan-hint="">
							<MessageSquare size={13} strokeWidth={1.8} aria-hidden />
							{t.commentHint}
						</Text>
					) : (
						<div className="plume-plan-status">
							<Text size="caption" tone={picked || approved ? "accent" : "faint"} className="plume-plan-grow" data-plan-status="">
								{picked || approved ? t.approved : t.declined}
							</Text>
							{switchable && (
								<Button size="xs" variant="subtle" menu={menu.open} onClick={menu.toggle} data-plan-switch="">
									{t.approvedCount(plans.length)}
									<Caret open={menu.open} />
								</Button>
							)}
						</div>
					)}
					{/* 松开鼠标时取选区：双击、三击选词选段也是松开之后才定。 */}
					<div className="plume-plan-anchor">
						<div
							ref={bodyRef}
							onMouseUp={(event) => {
								if (event.button === 0) requestAnimationFrame(pick);
							}}
							data-plan-body=""
						>
							<ui.Markdown text={text} sessionId={sessionId} />
						</div>
						{/* 每条评论那段字的末尾一枚序号，和审批卡上那条评论前面的数一样。不接鼠标：挡着它就划不了后面的字。 */}
						{marks.map((mark) => (
							<MarkNumber key={mark.id} n={mark.n} className="plume-plan-mark" data-plan-mark={mark.n} style={{ left: mark.x, top: mark.y }} />
						))}
					</div>
				</Scroller>
				{menu.open && (
					<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="wide">
						<MenuBody>
							{plans.map((plan) => (
								<MenuItem
									key={plan.approvedAt}
									selected={plan.approvedAt === shownAt}
									detail={`${relativeTime(new Date(plan.approvedAt).toISOString())}${plan.handoff ? ` · ${t.handedOff}` : ""}`}
									onClick={() => {
										viewPlan(sessionId, plan.approvedAt);
										menu.close();
									}}
								>
									{planTitle(plan.plan)}
								</MenuItem>
							))}
						</MenuBody>
					</Popover>
				)}
				{draft && (
					<Popover
						anchor={draft.at}
						onClose={() => setDraft(null)}
						placement="bottom"
						align="start"
						width={320}
						surface="panel"
						role="dialog"
						label={t.commentPlaceholder}
					>
						<form
							className="plume-plan-comment-form"
							onSubmit={(event) => {
								event.preventDefault();
								commit();
							}}
						>
							<Textarea
								autoFocus
								rows={2}
								value={note}
								placeholder={t.commentPlaceholder}
								onChange={(event) => setNote(event.target.value)}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										commit();
									} else if (event.key === "Escape") {
										event.stopPropagation();
										setDraft(null);
									}
								}}
								className={`plume-plan-textarea ${textarea}`}
								data-plan-comment-input=""
							/>
							<IconButton size="sm" icon={<ArrowUp size={14} />} onClick={commit} label={t.commentSubmit} disabled={!note.trim()} />
						</form>
					</Popover>
				)}
			</>
		);
	};
}
