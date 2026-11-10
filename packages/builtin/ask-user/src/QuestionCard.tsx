/**
 * `ask_user` 的提问卡，画在输入框上方的审批卡位置（`ui.approvalCard`）。外框和产品的审批卡是同一个（`ApprovalFrame`）：
 * 收放的标题栏、倒计时、+N；里面是问题、选项、「其他」一行自己写，底下跳过、取消、确认。
 *
 * 回答先经 `answer` 交给逻辑入口，再 `respond("once")`；取消是 `respond("reject")`，什么都不交。
 * 键盘：1–9 选第几项，0 去「其他」那一行写，Esc 跳过（允许跳过时），回车确认。
 */

import type { ApprovalCardProps, Remote } from "@plume/contract/ui";
import { ApprovalFrame, Button, Input, Scroller, Text, useI18n } from "@plume/ui";
import { Check, MessageCircle, SkipForward, X } from "@plume/ui/icons";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { AskUserApi } from "./api.ts";
import { type Messages, MESSAGES } from "./messages.ts";
import { type Question, type QuestionReply, readQuestion } from "./question.ts";

export function questionCard(api: Remote<AskUserApi>) {
	return function QuestionCard({ request, queued, from, respond, fallback }: ApprovalCardProps) {
		const text = MESSAGES[useI18n().resolvedLocale];
		const question = readQuestion(request.detail);
		if (!question) return <>{fallback}</>;
		return (
			<ApprovalFrame
				requestId={request.toolCallId}
				icon={<MessageCircle size={15} strokeWidth={1.8} className="plume-ask-icon" />}
				title={text.title}
				expiresAt={request.expiresAt}
				queued={queued}
			>
				<Text as="p" size="caption" tone="muted" className="plume-ask-note">
					{text.fullAccessNote}
				</Text>
				<QuestionChoices
					key={request.toolCallId}
					question={question}
					text={text}
					answer={async (reply) => {
						if (reply === "reject") return respond("reject");
						await api.answer(question.id, reply);
						await respond("once");
					}}
				>
					{from !== undefined && (
						<Text as="p" size="caption" tone="faint" className="plume-ask-from" data-approval-from="">
							{text.fromChild(from || text.childUntitled)}
						</Text>
					)}
					<Text as="p" size="label" className="plume-ask-question" data-ask-question="">
						{question.question}
					</Text>
				</QuestionChoices>
			</ApprovalFrame>
		);
	};
}

function QuestionChoices({
	question,
	text,
	children,
	answer,
}: {
	question: Question;
	text: Messages;
	children: ReactNode;
	answer(reply: QuestionReply | "reject"): Promise<void>;
}) {
	const { options, selectionMode, allowCustomInput, allowSkip, defaultOptionIndex } = question;
	const choices = options.map((option) => (typeof option === "string" ? { label: option } : option));
	const multi = selectionMode === "multi";
	// 有默认项时先选上它：回车就是接受默认。
	const [selected, setSelected] = useState<number[]>(defaultOptionIndex !== undefined ? [defaultOptionIndex] : []);
	const [typed, setTyped] = useState("");
	// 没有选项时只能自己写，「其他」那一行一开始就是选中的。
	const [otherOn, setOtherOn] = useState(options.length === 0);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const submitting = useRef(false);
	const composing = useRef(false);
	const formRef = useRef<HTMLFormElement>(null);
	const customRef = useRef<HTMLInputElement>(null);
	const values = [
		...selected.map((index) => choices[index]?.label).filter((label): label is string => label !== undefined),
		...(otherOn && typed.trim() ? [typed.trim()] : []),
	];
	const canSubmit = values.length > 0 && (!otherOn || Boolean(typed.trim()));
	const kind = multi ? "checkbox" : "radio";

	// 卡片一出来焦点就在它身上，数字键、Esc 不用先点一下。
	useEffect(() => formRef.current?.focus(), []);

	function pick(index: number) {
		setSelected((current) => (multi ? (current.includes(index) ? current.filter((value) => value !== index) : [...current, index]) : [index]));
		if (!multi) setOtherOn(false);
	}
	function selectOther() {
		setOtherOn(true);
		if (!multi) setSelected([]);
	}
	/**
	 * 答一次：答出去之前按钮全灰，再按也不会发第二遍；没送到就把错误摆出来，按钮放开让人再答。
	 * 挡第二遍靠 ref 不靠 state：一次双击的两下落在同一帧里。输入法还在组字时的回车是选字，不是答题。
	 */
	async function submit(reply: QuestionReply | "reject") {
		if (composing.current || submitting.current) return;
		submitting.current = true;
		setPending(true);
		setError("");
		try {
			await answer(reply);
		} catch (failure) {
			submitting.current = false;
			setPending(false);
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}
	function onFormKey(event: KeyboardEvent<HTMLFormElement>) {
		if (event.nativeEvent.isComposing || composing.current) return;
		if (event.key === "Escape" && allowSkip) {
			event.preventDefault();
			void submit({ skip: true });
			return;
		}
		const target = event.target;
		if (target instanceof HTMLInputElement && target.type !== "radio" && target.type !== "checkbox") return;
		if (target instanceof HTMLTextAreaElement) return;
		if (event.key >= "1" && event.key <= "9") {
			const index = Number(event.key) - 1;
			if (index < choices.length) {
				event.preventDefault();
				pick(index);
			}
			return;
		}
		if (event.key === "0" && allowCustomInput) {
			event.preventDefault();
			selectOther();
			customRef.current?.focus();
		}
	}
	return (
		// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc 和数字键作用于整张表里的每个控件。
		<form
			ref={formRef}
			tabIndex={-1}
			data-ask-form=""
			data-ask-mode={selectionMode}
			className="plume-ask-form"
			aria-busy={pending}
			onSubmit={(event) => {
				event.preventDefault();
				if (canSubmit) void submit({ answer: multi ? values : values[0]! });
			}}
			onKeyDown={onFormKey}
		>
			<Scroller className="plume-ask-scroll" contentClassName="plume-ask-body">
				{children}
				<fieldset disabled={pending} className="plume-ask-options">
					<legend className="plume-ask-sr-only">{multi ? text.selectMany : text.selectOne}</legend>
					{choices.map((option, index) => {
						const on = selected.includes(index);
						return (
							<label key={option.label} data-ask-option="" data-on={on || undefined} className="plume-ask-choice">
								<input type={kind} name="ask-choice" checked={on} className="plume-ask-sr-only" onChange={() => pick(index)} />
								<span className="plume-ask-choice-text">
									<Text size="label" className="plume-ask-label">
										{option.label}
									</Text>
									{option.description && (
										<Text size="caption" tone="muted" className="plume-ask-description">
											{option.description}
										</Text>
									)}
								</span>
								{option.recommended && (
									<Text size="caption" tone="accent" className="plume-ask-recommended" data-ask-recommended="">
										{text.recommended}
									</Text>
								)}
							</label>
						);
					})}
				</fieldset>
			</Scroller>
			{allowCustomInput && (
				<div className="plume-ask-other-row">
					<label data-ask-other="" data-on={otherOn || undefined} className="plume-ask-choice">
						<input
							type={kind}
							name="ask-choice"
							checked={otherOn}
							className="plume-ask-sr-only"
							onChange={() => {
								selectOther();
								customRef.current?.focus();
							}}
						/>
						<Text size="label" className="plume-ask-other-label">
							{text.other}
						</Text>
						<Text size="label" className="plume-ask-custom-wrap">
							<Input
								ref={customRef}
								aria-label={text.custom}
								placeholder={text.customPlaceholder}
								value={typed}
								disabled={pending}
								onChange={(event) => {
									setTyped(event.target.value);
									selectOther();
								}}
								onFocus={selectOther}
								onCompositionStart={() => {
									composing.current = true;
								}}
								onCompositionEnd={() => {
									composing.current = false;
								}}
								className="plume-ask-custom"
								data-ask-custom=""
							/>
						</Text>
					</label>
				</div>
			)}
			<div className="plume-ask-footer">
				<div className="plume-ask-actions">
					{allowSkip && (
						<span className="plume-ask-skip">
							<Button variant="subtle" disabled={pending} onClick={() => void submit({ skip: true })} icon={<SkipForward size={14} />} data-ask-action="skip">
								{text.skip}
							</Button>
						</span>
					)}
					<Button variant="subtle" disabled={pending} onClick={() => void submit("reject")} icon={<X size={14} />} data-ask-action="cancel">
						{text.cancel}
					</Button>
					<Button type="submit" variant="primary" disabled={pending || !canSubmit} icon={<Check size={14} />} data-ask-action="submit">
						{otherOn ? text.sendAnswer : text.confirm}
					</Button>
				</div>
				{defaultOptionIndex !== undefined && allowSkip && (
					<Text as="p" size="caption" tone="muted" className="plume-ask-hint">
						{text.skipDefault(choices[defaultOptionIndex]?.label ?? "")}
					</Text>
				)}
				{error && (
					<Text as="p" size="caption" tone="danger" className="plume-ask-hint" role="alert">
						{error}
					</Text>
				)}
			</div>
		</form>
	);
}
