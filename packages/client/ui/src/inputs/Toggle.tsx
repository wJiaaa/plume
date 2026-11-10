/**
 * 所有布尔设置用的开关。轨道两种状态都跟着主题和强调色；圆点用 `.plume-knob`，和外观页的滑块同一种处理：
 * 白底加细边和阴影，浅色轨道上也看得见，暗色下压暗一点不刺眼。
 */
export function Toggle({
	checked,
	onChange,
	ariaLabel,
	disabled,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	ariaLabel?: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			// 给旁边没有自己的标签、或标签在页面上不唯一的开关。
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-[var(--plume-t-base)] disabled:cursor-not-allowed disabled:opacity-45 ${
				checked ? "bg-accent" : "bg-line"
			}`}
		>
			{/*
			 * 圆点靠 transform 走，不靠 left：`left` 每一帧都要重新布局，`transform` 是合成器自己的事，忙的时候不掉帧。
			 * 缓动用 `ease-out`（即 `--plume-e-out`）：快起、末段收住，落下去是停稳。16px 是两端位置的差（19 − 3）。
			 */}
			<span
				className="plume-knob absolute top-[3px] left-[3px] h-4 w-4 rounded-full border transition-transform duration-[var(--plume-t-base)] ease-out"
				style={{ transform: checked ? "translateX(16px)" : "translateX(0)" }}
			/>
		</button>
	);
}
