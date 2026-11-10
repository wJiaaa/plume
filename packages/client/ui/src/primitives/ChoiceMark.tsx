import { Check } from "../icons/index.ts";

/**
 * 自己画的选中标记。
 *
 * 原生复选框带着宿主系统的样子：macOS 上是 Aqua，Windows 上是 Fluent，哪个都和周围 ink / accent 的
 * 卡片对不上。一个标记，两种形状。
 */
export function ChoiceMark({
	checked,
	kind,
	indeterminate = false,
	className = "",
}: {
	checked: boolean;
	kind: "checkbox" | "radio";
	indeterminate?: boolean;
	className?: string;
}) {
	const on = checked || indeterminate;
	if (kind === "radio") {
		return (
			<span
				aria-hidden
				data-plume-choice={on ? "on" : "off"}
				data-plume-choice-kind="radio"
				className={`grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-[var(--plume-t-quick)] ${on ? "border-accent" : "border-ink-faint/55 group-hover:border-ink-muted"} ${className}`}
			>
				<span
					className={`rounded-full bg-accent transition-transform duration-[var(--plume-t-quick)] ease-out ${on ? "size-2 scale-100" : "size-2 scale-0"}`}
				/>
			</span>
		);
	}
	return (
		<span
			aria-hidden
			data-plume-choice={indeterminate ? "mixed" : on ? "on" : "off"}
			data-plume-choice-kind="checkbox"
			className={`grid size-4 shrink-0 place-items-center rounded-sm border transition-colors duration-[var(--plume-t-quick)] ${on ? "border-accent bg-accent text-shell" : "border-ink-faint/55 bg-card group-hover:border-ink-muted"} ${className}`}
		>
			{indeterminate ? (
				<span className="h-0.5 w-2 rounded-full bg-shell" />
			) : (
				<Check size={11} strokeWidth={2.6} className={`transition-opacity duration-[var(--plume-t-quick)] ${checked ? "opacity-100" : "opacity-0"}`} />
			)}
		</span>
	);
}
