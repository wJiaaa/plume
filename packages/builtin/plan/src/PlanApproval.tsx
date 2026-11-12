/**
 * 计划模式交上来的计划，等人拍板的那张卡（`ui.requestCard`）：一行标题、一排动作；有评论时评论按序号列在卡上，下面接一个补充框。
 *
 * 计划本身在右栏的计划面板里读、划线评论（`PlanPanel.tsx`），评论落在这张卡上——序号和面板里那段字末尾的那枚一样，对得上号。
 * 四个动作各是一个按钮，键盘直达：Esc 修改，⌘↵ 主按钮，⇧⌘↵ 接受。窄窗口的面板区一次只摆一格，开面板会盖住这张卡，
 * 所以那时正文画在卡里。右栏开着时卡只有四百多像素宽：接受的那一组（接受和主按钮）连在一起换行、靠右，不把主按钮单独挤下去；
 * 再窄就收起键帽（快捷键照样能用），见 `plan.css` 的 `.plume-plan-actions`。
 *
 * 回答经 `answer` 交回 `run.request`（`PlanReply`）：接受连同评论，修改是带着意见的拒绝，回给模型改；什么都没说的拒绝是
 * `decline`，让这一轮停下。「在新会话里执行」也是接受，多一个 `handoff`（连同卡上给新会话挑的模型），逻辑入口开新会话、让这一轮停下。
 */

import type { Remote, RequestCardProps, UiContext } from "@plume/contract/ui";
import { ApprovalExpiry, Button, IconButton, macKeyboard, MarkNumber, Scroller, shortcutLabel, Text, Textarea, useI18n } from "@plume/ui";
import { MessageCircle, X } from "@plume/ui/icons";
import { text as textStyles, textarea } from "@plume/styles";
import { useEffect, useRef, useState } from "react";
import type { PlanApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { planFeedback, type PlanReply } from "./plan.ts";
import { removeComment, showPlan, useReview } from "./review.ts";

const EMPTY: never[] = [];

/** 一个键一枚键帽：「⇧ ⌘ ↩」挤在一个框里读不出是三个键。非 Mac 键盘写成一串「Ctrl+Shift+Enter」，那是一个词，放一枚。 */
function Keys({ keys }: { keys: string[] }) {
	// `\uFE0E` 要文字字形：不加的话 macOS 把 ↩ 画成一枚蓝底 emoji。
	const caps = macKeyboard() ? keys.map((key) => `${key}\uFE0E`) : [shortcutLabel(keys.join(""))];
	return (
		<span className="plume-plan-keys" aria-hidden>
			{caps.map((key) => (
				<Text key={key} size="caption" className="plume-plan-key">
					{key}
				</Text>
			))}
		</span>
	);
}

export function planApproval(ui: UiContext, api: Remote<PlanApi>, panel: string) {
	return function PlanApproval({ request, sessionId, answer: reply, decline, permission, allowAuto, compact, queued, fallback }: RequestCardProps) {
		const plan = typeof request.payload === "string" ? request.payload : "";
		const t = MESSAGES[useI18n().resolvedLocale];
		const review = useReview(sessionId);
		const comments = review?.requestId === request.toolCallId ? review.comments : EMPTY;
		const [revising, setRevising] = useState(false);
		const [said, setSaid] = useState("");
		const [pending, setPending] = useState(false);
		const cardRef = useRef<HTMLDivElement>(null);
		const busy = useRef(false);
		// 交给新会话时它用的模型；空着就是默认模型，逻辑入口那边不给 `model`，`launch` 用的也是默认模型。
		const [handoffModel, setHandoffModel] = useState("");
		const [models, setModels] = useState<{ id: string; name: string }[]>([]);
		const { defaultModel } = ui.useModelDefaults();
		useEffect(() => {
			if (!handoffModel) return;
			let alive = true;
			void api.models().then(
				(list) => {
					if (alive) setModels(list);
				},
				() => undefined,
			);
			return () => {
				alive = false;
			};
		}, [handoffModel]);

		// 每份计划交上来时替人打开一次面板；人关了不追。窄窗口开面板会盖住这张卡，不开。
		useEffect(() => {
			if (showPlan(sessionId, request.toolCallId, plan) && !compact) ui.openPanel(panel, sessionId);
			// oxlint-disable-next-line react-hooks/exhaustive-deps -- 每份计划交上来时只开一次面板，plan、compact 变了不追
		}, [sessionId, request.toolCallId]);
		// 卡片一出来焦点就在它身上，快捷键不用先点一下。
		useEffect(() => cardRef.current?.focus(), []);

		if (!plan.trim()) return <>{fallback}</>;

		/*
		 * 「接受并开启自动模式」只在请求批准档时给：已经是帮我批准或完全访问，这颗按钮要么什么也不改，要么把完全访问降回去——
		 * 都不是人点它时想要的。
		 */
		const offerAuto = permission === "ask";

		/** `undefined` 是什么都没说的拒绝。 */
		async function answer(value: PlanReply | undefined, before?: () => Promise<void>) {
			if (busy.current) return;
			busy.current = true;
			setPending(true);
			try {
				await before?.();
				await (value ? reply(value) : decline());
			} catch (error) {
				busy.current = false;
				setPending(false);
				ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		}
		/*
		 * 有评论时接受，评论作为执行时的注意事项随批准一起交出去，计划不重写：多数评论是「做的时候注意」，为它重写一整份计划是白花一轮。
		 * 要按评论改计划，走「修订」。
		 */
		const notes = planFeedback(comments);
		const approval = { accept: true as const, ...(notes ? { note: notes } : {}) };
		const notesTip = comments.length > 0 ? t.notesOnAccept(comments.length) : undefined;
		const accept = () => void answer(approval);
		// 先换档再放行：批准那一刻 agent 就接着往下跑，第一步的工具调用该已经按帮我批准判。
		const acceptAuto = () => void answer(approval, allowAuto);
		const reject = () => void answer(undefined);
		// 评论照样随着交出去：它们写进计划文件末尾的「执行时注意」，新会话读得到。
		const handoff = () => void answer({ ...approval, handoff: handoffModel ? { model: handoffModel } : {} });
		/*
		 * 模型选择是贴着这颗按钮的一枚箭头：选的只是新会话的模型，接受、原地执行不受它影响，当前会话的模型也不动。
		 * 不做成带名字的选择框，是因为右栏开着时卡片只有四百多像素宽，那一格会把「接受」挤到第二行；挑了别的模型，
		 * 按钮自己说用哪个，不挑就是默认模型，悬停在箭头上看全名。
		 */
		const handoffName = handoffModel ? models.find((model) => model.id === handoffModel)?.name : undefined;
		const handoffButton = (
			<span className="plume-plan-handoff">
				<Button variant="soft" disabled={pending} onClick={handoff} label={t.handoffTip} data-plan-action="handoff">
					{handoffName ? t.handoffWith(handoffName) : t.handoff}
				</Button>
				<ui.ModelSelect
					compact
					ariaLabel={t.handoffModel}
					value={handoffModel}
					onChange={setHandoffModel}
					disabled={pending}
					inheritLabel={t.followDefaultModel}
					inheritDetail={t.handoffModelDetail}
					{...(defaultModel ? { inheritedModelId: defaultModel } : {})}
				/>
			</span>
		);
		// 有评论就是在改：评论列在卡上，下面接着写，主按钮是「修订」。没有评论时按 Esc 也进这一态。
		const editing = revising || comments.length > 0;
		const feedback = planFeedback(comments, said);
		const revise = () => {
			if (feedback) void answer({ accept: false, feedback });
		};
		const cancelRevise = () => {
			setRevising(false);
			setSaid("");
			cardRef.current?.focus();
		};

		function onKey(event: React.KeyboardEvent<HTMLDivElement>) {
			if (event.nativeEvent.isComposing || event.target instanceof HTMLTextAreaElement) return;
			if (event.key === "Escape") {
				event.preventDefault();
				if (!editing) setRevising(true);
			} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				if (event.shiftKey || !offerAuto) accept();
				else acceptAuto();
			}
		}

		return (
			<div ref={cardRef} tabIndex={-1} onKeyDown={onKey} aria-busy={pending} data-approval-card="" data-approval-plan="" className="plume-plan-card">
				<div className="plume-plan-card-head">
					<Text size="body" weight="medium" className="plume-plan-card-title" data-approval-title="">
						{t.approvalTitle}
					</Text>
					{request.expiresAt !== undefined && <ApprovalExpiry at={request.expiresAt} />}
					{queued > 0 && (
						<Text size="caption" tone="faint" data-approval-queued="">
							+{queued}
						</Text>
					)}
					<button type="button" onClick={() => ui.openPanel(panel, sessionId)} className={`plume-plan-link ${textStyles.link}`} data-approval-open-plan="">
						<Text size="detail" tone="accent">
							{t.open}
						</Text>
					</button>
				</div>
				{compact && (
					<Scroller className="plume-plan-card-body">
						<ui.Markdown text={plan} sessionId={sessionId} />
					</Scroller>
				)}
				{editing ? (
					<form
						className="plume-plan-revise"
						onSubmit={(event) => {
							event.preventDefault();
							revise();
						}}
					>
						{comments.length > 0 && (
							<Scroller className="plume-plan-comments">
								<ol className="plume-plan-comment-list" data-plan-comment-list="">
									{comments.map((comment, index) => (
										<li key={comment.id} className="plume-plan-comment" data-plan-comment-chip="">
											<MarkNumber n={index + 1} className="plume-plan-comment-mark" />
											<div className="plume-plan-comment-main">
												<Text as="p" size="caption" tone="faint" className="plume-plan-comment-quote">
													<MessageCircle size={12} strokeWidth={1.8} aria-hidden />
													<span>{comment.quote.replace(/\s+/g, " ")}</span>
												</Text>
												<Text as="p" size="label" className="plume-plan-comment-text">
													{comment.text}
												</Text>
											</div>
											<IconButton
												size="sm"
												icon={<X size={13} strokeWidth={1.9} />}
												label={t.deleteComment}
												onClick={() => removeComment(sessionId, comment.id)}
											/>
										</li>
									))}
								</ol>
							</Scroller>
						)}
						<div className="plume-plan-input">
							<Textarea
								autoFocus={revising}
								rows={2}
								value={said}
								disabled={pending}
								placeholder={comments.length > 0 ? t.addMore : t.revisePlaceholder}
								aria-label={t.revise}
								onChange={(event) => setSaid(event.target.value)}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
										event.preventDefault();
										accept();
									} else if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										revise();
									} else if (event.key === "Escape") {
										event.preventDefault();
										event.stopPropagation();
										cancelRevise();
									}
								}}
								className={`plume-plan-textarea ${textarea}`}
								data-plan-revise-input=""
							/>
						</div>
						<div className="plume-plan-actions" data-approval-plan-actions="">
							{/* 有评论时这一排仍然能拒绝、能接受：评论只是把「修订」顶成主按钮，别的路一条不少。 */}
							{comments.length > 0 ? (
								<Button variant="soft" disabled={pending} onClick={reject} data-plan-action="reject">
									{t.reject}
								</Button>
							) : (
								<Button variant="soft" disabled={pending} onClick={cancelRevise}>
									{t.cancel}
									<Keys keys={["Esc"]} />
								</Button>
							)}
							<span className="plume-plan-spacer" />
							{handoffButton}
							<span className="plume-plan-main">
								<Button variant="soft" disabled={pending} onClick={accept} {...(notesTip ? { label: notesTip } : {})} data-plan-action="accept">
									{t.accept}
									<Keys keys={["⌘", "↩"]} />
								</Button>
								<Button type="submit" variant="primary" disabled={pending || !feedback} data-plan-send-revision="">
									{t.sendRevision}
									<Keys keys={["↩"]} />
								</Button>
							</span>
						</div>
					</form>
				) : (
					<div className="plume-plan-actions" data-approval-plan-actions="">
						<Button variant="soft" disabled={pending} onClick={reject} data-plan-action="reject">
							{t.reject}
						</Button>
						<Button variant="soft" disabled={pending} onClick={() => setRevising(true)} data-plan-action="revise">
							{t.revise}
							<Keys keys={["Esc"]} />
						</Button>
						<span className="plume-plan-spacer" />
						{handoffButton}
						<span className="plume-plan-main">
							<Button variant={offerAuto ? "soft" : "primary"} disabled={pending} onClick={accept} data-plan-action="accept">
								{t.accept}
								<Keys keys={offerAuto ? ["⇧", "⌘", "↩"] : ["⌘", "↩"]} />
							</Button>
							{offerAuto && (
								<Button variant="primary" disabled={pending} onClick={acceptAuto} data-plan-action="accept-auto">
									{t.acceptAuto}
									<Keys keys={["⌘", "↩"]} />
								</Button>
							)}
						</span>
					</div>
				)}
			</div>
		);
	};
}
