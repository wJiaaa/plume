import { useState } from "react";

/**
 * 轨道和把手自己画的滑块。原生 range 叠在最上面、完全透明，拖动、点轨道跳过去、方向键都是浏览器自己的，
 * 画出来的部分只跟着 value 走。
 */
export function Slider({
	value,
	onChange,
	min = 0,
	max = 100,
	step = 1,
	label,
	width = 180,
}: {
	value: number;
	onChange: (value: number) => void;
	min?: number;
	max?: number;
	step?: number;
	label: string;
	width?: number | string;
}) {
	const [dragging, setDragging] = useState(false);
	const ratio = max === min ? 0 : (value - min) / (max - min);
	// 拖动时不缓动：手每一帧都给新位置，把手却每一帧都从头爬一段曲线，永远停在光标后面，感觉是“黏”。
	const glide = (property: string) => (dragging ? "none" : `${property} var(--plume-t-quick) var(--plume-e-out)`);
	return (
		<div className="relative h-4.5" style={{ width }}>
			<div className="absolute top-1/2 h-0.75 w-full -translate-y-1/2 overflow-hidden rounded-full bg-line">
				<div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%`, transition: glide("width") }} />
			</div>
			{/* 往里缩半个把手，让把手的中心落在轨道两端，而不是边缘挂出去。 */}
			<div
				className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line-float bg-knob"
				style={{ left: `calc(7px + ${ratio} * (100% - 14px))`, transition: glide("left") }}
			/>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				aria-label={label}
				onChange={(event) => onChange(Number(event.target.value))}
				onPointerDown={() => setDragging(true)}
				onPointerUp={() => setDragging(false)}
				onPointerCancel={() => setDragging(false)}
				className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
			/>
		</div>
	);
}
