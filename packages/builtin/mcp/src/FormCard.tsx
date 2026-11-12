/**
 * MCP 服务中途要人填的一张表（elicitation），画在输入框上方的审批卡位置（`ui.requestCard(FORM_KIND, …)`）。
 *
 * 三个出口对应协议的三种回答，不能并成两个：「拒绝提供」是人明确说不给（decline），「取消」是人没做决定就把它关了
 * （cancel）——服务据此决定是放弃还是过会儿再问。提交和「拒绝提供」经 `answer` 交回 `run.request`，「取消」是 `decline`。
 */

import type { RequestCardProps, UiContext } from "@plume/contract/ui";
import { ApprovalExpiry, Button, ChoiceMark, Input, Scroller, Text, useI18n } from "@plume/ui";
import { Check, X } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import { checkFormValues, type FormAnswer, type FormField, type FormProblem, initialValues, readFormRequest } from "./form.ts";
import { type Messages, MESSAGES } from "./messages.ts";

/** 输入框里留着人打的原样文字；交之前才换成表单要的类型，换不过去的交给检查去说「不是数字」。 */
type Draft = Record<string, string | boolean | number | undefined>;

function collect(fields: readonly FormField[], draft: Draft): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of fields) {
		const raw = draft[field.name];
		if (typeof raw !== "string") {
			values[field.name] = raw;
			continue;
		}
		const typed = raw.trim();
		if (!typed) continue;
		if (field.type === "number" || field.type === "integer") {
			const number = Number(typed);
			values[field.name] = Number.isFinite(number) ? number : typed;
		} else if (field.format === "date-time") {
			// `datetime-local` 给的是不带时区的本地时刻，规范要的是 RFC 3339：按本机时区换成 UTC。
			const at = new Date(typed);
			values[field.name] = Number.isNaN(at.getTime()) ? typed : at.toISOString();
		} else values[field.name] = raw;
	}
	return values;
}

function inputType(field: FormField): string {
	if (field.format === "email") return "email";
	if (field.format === "uri") return "url";
	if (field.format === "date") return "date";
	if (field.format === "date-time") return "datetime-local";
	return "text";
}

function problemText(field: FormField, problem: FormProblem, text: Messages): string {
	const said = text.formProblem;
	if (problem === "type") return said.type(text.formKind[field.type === "boolean" ? "string" : field.type]);
	if (problem === "format") return said.format(field.format ?? "");
	if (problem === "minLength") return said.minLength(field.minLength ?? 0);
	if (problem === "maxLength") return said.maxLength(field.maxLength ?? 0);
	if (problem === "minimum") return said.minimum(field.minimum ?? 0);
	if (problem === "maximum") return said.maximum(field.maximum ?? 0);
	return said[problem]();
}

export function formCard(ui: UiContext) {
	return function FormCard({ request, queued, answer: reply, decline, fallback }: RequestCardProps) {
		const text = MESSAGES[useI18n().resolvedLocale];
		const form = readFormRequest(request.payload);
		const fields = form?.fields ?? [];
		const [draft, setDraft] = useState<Draft>(() => initialValues(fields));
		const [tried, setTried] = useState(false);
		const [pending, setPending] = useState(false);
		const formRef = useRef<HTMLFormElement>(null);
		const busy = useRef(false);

		useEffect(() => formRef.current?.querySelector<HTMLElement>("input")?.focus(), []);

		if (!form) return <>{fallback}</>;

		const checked = checkFormValues(fields, collect(fields, draft));
		// 没点过提交之前不报错：一张刚弹出来的表满是红字，人还没开始填就像是填错了。
		const problems = tried && !checked.ok ? checked.problems : {};
		const set = (name: string, value: string | boolean | undefined) => setDraft((current) => ({ ...current, [name]: value }));

		/** `undefined` 是「取消」：没做决定，不交回答。 */
		async function answer(value: FormAnswer | undefined) {
			if (busy.current || !form) return;
			busy.current = true;
			setPending(true);
			try {
				await (value ? reply(value) : decline());
			} catch (error) {
				busy.current = false;
				setPending(false);
				ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		}

		return (
			<form
				ref={formRef}
				noValidate
				aria-busy={pending}
				data-approval-card=""
				data-mcp-form=""
				className="mcp-form-card"
				onSubmit={(event) => {
					event.preventDefault();
					setTried(true);
					if (checked.ok) void answer({ action: "accept", values: checked.values });
				}}
			>
				<div className="mcp-form-head">
					<Text size="body" weight="medium" className="mcp-form-title" data-approval-title="">
						{text.formTitle(request.title)}
					</Text>
					{request.expiresAt !== undefined && <ApprovalExpiry at={request.expiresAt} />}
					{queued > 0 && (
						<Text size="caption" tone="faint">
							+{queued}
						</Text>
					)}
				</div>
				<Scroller className="mcp-form-scroll" contentClassName="mcp-form-body">
					<Text as="p" size="label">
						{form.message}
					</Text>
					<Text as="p" size="caption" tone="faint">
						{text.formNote(request.title)}
					</Text>
					<fieldset disabled={pending} className="mcp-form-fields">
						{fields.map((field) => (
							<FieldRow
								key={field.name}
								field={field}
								value={draft[field.name]}
								problem={problems[field.name]}
								text={text}
								onChange={(value) => set(field.name, value)}
							/>
						))}
					</fieldset>
				</Scroller>
				<div className="mcp-form-actions">
					<Button variant="subtle" disabled={pending} icon={<X size={14} />} onClick={() => void answer({ action: "decline" })} data-mcp-form-action="decline">
						{text.formDecline}
					</Button>
					<span className="mcp-spacer" />
					<Button variant="subtle" disabled={pending} onClick={() => void answer(undefined)} data-mcp-form-action="cancel">
						{text.cancel}
					</Button>
					<Button type="submit" variant="primary" disabled={pending} icon={<Check size={14} />} data-mcp-form-action="submit">
						{text.formSubmit}
					</Button>
				</div>
			</form>
		);
	};
}

function FieldRow({
	field,
	value,
	problem,
	text,
	onChange,
}: {
	field: FormField;
	value: Draft[string];
	problem: FormProblem | undefined;
	text: Messages;
	onChange: (value: string | boolean | undefined) => void;
}) {
	const id = `mcp-form-${field.name}`;
	const label = (
		<span className="mcp-form-label">
			<Text size="label">{field.label}</Text>
			{field.required && (
				<Text size="caption" tone="faint">
					{text.formRequired}
				</Text>
			)}
		</span>
	);
	const hint = field.description && (
		<Text size="caption" tone="muted">
			{field.description}
		</Text>
	);
	const note = problem && (
		<Text size="caption" tone="danger" role="alert" data-mcp-form-problem={field.name}>
			{problemText(field, problem, text)}
		</Text>
	);

	if (field.type === "boolean") {
		const on = value === true;
		return (
			<div className="mcp-form-field" data-mcp-form-field={field.name}>
				<label className="mcp-choice" data-on={on}>
					<input type="checkbox" className="mcp-hidden-input" checked={on} onChange={(event) => onChange(event.target.checked)} />
					<ChoiceMark checked={on} kind="checkbox" />
					<span className="mcp-choice-text">
						{label}
						{hint}
					</span>
				</label>
				{note}
			</div>
		);
	}

	if (field.options) {
		return (
			<fieldset className="mcp-form-field" data-mcp-form-field={field.name}>
				<legend className="mcp-form-legend">
					{label}
					{hint}
				</legend>
				{field.options.map((option) => {
					const on = value === option.value;
					// 可选的单选再点一下就是不选：radio 本身退不回去，而「没填」对服务是另一种回答。
					return (
						<label key={option.value} className="mcp-choice" data-on={on} data-mcp-form-option={option.value}>
							<input
								type="radio"
								name={id}
								className="mcp-hidden-input"
								checked={on}
								onChange={() => onChange(option.value)}
								onClick={() => {
									if (on && !field.required) onChange(undefined);
								}}
							/>
							<ChoiceMark checked={on} kind="radio" />
							<Text size="label" className="mcp-choice-text">
								{option.label}
							</Text>
						</label>
					);
				})}
				{note}
			</fieldset>
		);
	}

	const numeric = field.type === "number" || field.type === "integer";
	return (
		<div className="mcp-form-field" data-mcp-form-field={field.name}>
			<label htmlFor={id} className="mcp-form-legend">
				{label}
				{hint}
			</label>
			<Text size="label">
				<Input
					id={id}
					type={numeric ? "text" : inputType(field)}
					inputMode={field.type === "integer" ? "numeric" : field.type === "number" ? "decimal" : undefined}
					value={value === undefined ? "" : String(value)}
					aria-invalid={problem ? true : undefined}
					onChange={(event) => onChange(event.target.value)}
					className="mcp-input"
				/>
			</Text>
			{note}
		</div>
	);
}
