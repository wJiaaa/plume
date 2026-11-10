/**
 * 往里打字的控件。
 *
 * 从单子里选一个在 `@plume/ui` 的 `Select`；这里的文字框、密钥框和它是一家子，看起来不该是三种东西。
 */

import { IconButton, Input, useI18n } from "@plume/ui";
import { Eye, EyeOff } from "@plume/ui/icons";
import { useState } from "react";

export function TextInput({
	value,
	onChange,
	placeholder,
	mono,
	invalid,
	className = "",
	...rest
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	mono?: boolean;
	invalid?: boolean;
	className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className">) {
	return (
		<Input
			{...rest}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			aria-invalid={invalid || undefined}
			data-plume-field=""
			className={`plume-field ${invalid ? "plume-field-invalid" : ""} ${mono ? "font-mono" : ""} ${numericClass(rest.inputMode)} ${className || "w-full"}`}
		/>
	);
}

/**
 * 装数字的框，字站在框的中间：数字是看一眼知道多大，两边留白不一样宽时一列这样的框看着像没对齐。
 * 判断依据用 `inputMode`：只输数字的地方本来就得写它（软键盘要用），再加一个同义的开关迟早有字段只写了一个。
 */
function numericClass(inputMode: React.HTMLAttributes<HTMLElement>["inputMode"]): string {
	return inputMode === "numeric" || inputMode === "decimal" ? "text-center tabular-nums" : "";
}

/**
 * 填密钥的框。
 *
 * 已经存下的 key 不出 agent 进程，所以 `value` 只是这次新填的那段（一开始是空的），存过没有由 `saved` 说；
 * 存过且没填时占位字说明「留空不改」。眼睛按钮只显示自己刚打的字，看不到已存的 key。
 */
export function SecretInput({
	id,
	value,
	onChange,
	onBlur,
	placeholder,
	saved = false,
}: {
	/** 给外面的 `<label htmlFor>` 认。 */
	id?: string;
	value: string;
	onChange: (value: string) => void;
	/**
	 * 失焦时的那一次，带着当前文本。给防抖提交用：改完就切走的那次修改等不到防抖的定时器。
	 * 传的是值不是事件，跟 `onChange` 同一种形状。
	 */
	onBlur?: (value: string) => void;
	placeholder?: string;
	/** 已经存过 key。 */
	saved?: boolean;
}) {
	const { t } = useI18n();
	const [visible, setVisible] = useState(false);
	return (
		/*
		 * 眼睛是这一行里的一件东西，不是浮在上面的：两者是同一条 flex 的两个孩子，位置由排版算出来，长 key 的圆点不会盖住它。
		 * 负的右外边距把它从 16px 的内衬里拉回一点。
		 */
		<div className="plume-field w-full gap-1.5" data-plume-field="">
			<Input
				id={id}
				type={visible ? "text" : "password"}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur ? (e) => onBlur(e.target.value) : undefined}
				placeholder={saved ? t("secretInput.saved") : placeholder}
				spellCheck={false}
				autoComplete="off"
				data-secret-input=""
				className="h-full min-w-0 flex-1 bg-transparent tracking-wide text-ink placeholder:text-ink-faint"
			/>
			{value && (
				<IconButton
					label={t(visible ? "common.hide" : "common.show")}
					data-secret-toggle=""
					onClick={() => setVisible((v) => !v)}
					className="-mr-1.5"
					icon={visible ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
				/>
			)}
		</div>
	);
}
