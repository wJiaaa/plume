import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * 一排互斥的选项，选中的那个下面垫着一块会滑过去的底。
 *
 * 一块共用的底从这里滑到那里，滑动本身就说明这几个选项是同一排里的几个位置，不是几个开关。
 * 位置是量出来的，不按等分算：中英混排的标签不一样宽。量在 layout effect 里，赶在这一帧画出来之前——晚一帧的话，
 * 第一次渲染就能看见那块底从左上角飞过来。
 *
 * 圆角外框 8px、滑块和每一格 6px：内衬 2px，两道圆弧才同心。
 */
export function Segmented<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (value: T) => void;
	/**
	 * 给了 `icon` 这一格就画成图标，`label` 变成它的提示和无障碍名字。
	 * `label` 无论如何都要给：只有图标、没有名字的控件，读屏读不出，别人也猜不着。
	 */
	options: { value: T; label: string; icon?: ReactNode }[];
}) {
	const box = useRef<HTMLDivElement>(null);
	const [rail, setRail] = useState<{ left: number; width: number } | null>(null);

	useLayoutEffect(() => {
		// 遍历而不是拼属性选择器：值是调用方给的，转义它要 `CSS.escape`。
		const selected = Array.from(box.current?.children ?? []).find((node) => node.getAttribute("data-segment") === value);
		if (selected instanceof HTMLElement) setRail({ left: selected.offsetLeft, width: selected.offsetWidth });
	}, [value, options]);

	return (
		<div ref={box} data-segmented="" className="relative flex gap-0.5 rounded-lg bg-card p-0.5">
			{/* 量到之前不画。它一出现就已经在正确的位置上，不需要一段从零滑过来的开场。 */}
			{rail && (
				<span
					aria-hidden
					data-segment-rail=""
					className="absolute top-0.5 bottom-0.5 left-0 rounded-md bg-elevated transition-[transform,width] duration-[var(--plume-t-base)] ease-out"
					style={{ width: rail.width, transform: `translateX(${rail.left}px)` }}
				/>
			)}
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					data-segment={option.value}
					data-plume-tip={option.icon ? option.label : undefined}
					aria-label={option.icon ? option.label : undefined}
					aria-pressed={value === option.value}
					onClick={() => onChange(option.value)}
					// `relative` 把字提到那块底上面；没有它，滑过去的底会盖住它正要标出的那个词。
					className={`relative h-[26px] rounded-md text-label transition-colors duration-[var(--plume-t-quick)] ${
						// 图标要方的，字要两边留空。
						option.icon ? "grid w-[30px] place-items-center" : "px-3"
					} ${value === option.value ? "text-ink" : "text-ink-muted hover:text-ink"}`}
				>
					{option.icon ?? option.label}
				</button>
			))}
		</div>
	);
}
