/**
 * 设置页「新建」弹窗里共用的几样：字段，和让回车能提交的那颗隐藏按钮。
 *
 * 各个弹窗各写一份标签和说明的话，过不了多久就是几种字号、几种间距。
 */

import { useI18n } from "@plume/ui";

/**
 * 标题、控件、底下一行字。
 *
 * 那行字平时是说明，出错时换成错误，位置不动——说明和错误各占一行的话，框会随着打字一高一矮。
 * `disabled` 只淡掉整块，控件照样在：跟当前选择无关的字段说清为什么用不了，而不是藏起来。
 */
export function DialogField({
	label,
	htmlFor,
	optional,
	hint,
	error,
	disabled,
	children,
}: {
	label: React.ReactNode;
	htmlFor?: string;
	optional?: boolean;
	hint?: React.ReactNode;
	error?: string | null;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	const { t } = useI18n();
	const Label = htmlFor ? "label" : "div";
	return (
		<div data-dialog-field="" className={disabled ? "opacity-50" : undefined}>
			<Label htmlFor={htmlFor} className="mb-1.5 flex items-baseline gap-1.5 text-detail font-medium text-ink">
				{label}
				{optional && <span className="font-normal text-ink-faint">{t("settingsDialog.optional")}</span>}
			</Label>
			{children}
			{error ? (
				<p role="alert" className="mt-1.5 text-caption text-danger">
					{error}
				</p>
			) : hint ? (
				<p className="mt-1.5 text-caption text-ink-faint">{hint}</p>
			) : null}
		</div>
	);
}

/**
 * 表单里看不见的提交钮：有它，单行框里按回车才会提交。弹窗的主按钮在表单外面的底栏里，浏览器不认它是这个表单的。
 */
export function EnterSubmits() {
	return <button type="submit" className="hidden" tabIndex={-1} aria-hidden />;
}
