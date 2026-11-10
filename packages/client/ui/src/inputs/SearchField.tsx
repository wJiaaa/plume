import { translate } from "../i18n/translate.ts";
import { Input } from "./NativeField.tsx";
import { Search, X } from "../icons/index.ts";
import { useEffect, useRef } from "react";
import { composingKey } from "../keyboard.ts";

/**
 * 搜索框。
 *
 * 侧栏的会话搜索、审阅面板的文件筛选、文件树的筛选共用这一个。各写各的话，每个都有自己的高度、
 * 自己的描边、自己对放大镜在框里还是框旁的看法——一个只有一个答案的问题，得到三个答案。
 *
 * 两种尺寸，因为两种场合确实不同：独占一行的框（`comfortable`），和塞进面板标题行、周围的行都很矮
 * 的框（`compact`）。
 */
export function SearchField({
	value,
	onChange,
	placeholder,
	size = "compact",
	autoFocus,
	onEscape,
	onEnter,
	className = "",
}: {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	size?: "compact" | "comfortable";
	autoFocus?: boolean;
	/** Esc 先清空，已经空了才关闭，筛选框要的就是这样。 */
	onEscape?: () => void;
	/** 输入法组字结束后的 Enter——上屏候选词的那个 Enter 不算。 */
	onEnter?: () => void;
	className?: string;
}) {
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (autoFocus) input.current?.focus();
	}, [autoFocus]);

	const comfortable = size === "comfortable";

	return (
		<div data-plume-field="" className={`plume-field min-w-0 gap-1.5 ${comfortable ? "" : "plume-field-compact"} ${className}`}>
			<Search size={comfortable ? 13 : 12} strokeWidth={1.9} className="shrink-0 text-ink-faint" />
			<Input
				ref={input}
				aria-label={placeholder || translate("common.search")}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && onEnter && !composingKey(event.nativeEvent)) {
						event.preventDefault();
						onEnter();
						return;
					}
					if (event.key !== "Escape") return;
					event.stopPropagation();
					if (value) onChange("");
					else onEscape?.();
				}}
				placeholder={placeholder}
				className={`min-w-0 flex-1 bg-transparent text-ink placeholder:text-ink-faint ${comfortable ? "text-label" : "text-detail"}`}
			/>
			{value && (
				<button
					type="button"
					data-plume-tip={translate("common.clear")}
					aria-label={translate("common.clearSearch")}
					onClick={() => {
						onChange("");
						input.current?.focus();
					}}
					className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-card-hover hover:text-ink"
				>
					<X size={10.5} strokeWidth={2.2} />
				</button>
			)}
		</div>
	);
}
