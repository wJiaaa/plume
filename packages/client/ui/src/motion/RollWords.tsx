import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useRolled } from "./RollingText.tsx";
import { GLIDE, useTickedAnimations } from "./ticked.ts";

/**
 * 一行流水行里换掉的那句话：新的从一道缝里落进来，词框的宽度跟着平滑地变。
 *
 * 只滚字、不管宽的话，一句短的换成一句长的那一帧，后面的箭头、+N -M 直接被顶出去一截——字在滚，
 * 行尾在跳，看上去比不滚还生硬。宽度在换的那一下钉成像素：量出新宽，先钉回旧宽、再设新宽，过渡走完
 * 就放回 auto。一直钉着的话，网页字体晚到、改字号之后词框还是旧的宽度，字会被截掉。
 *
 * 扫光（`glide`）挂在字自己身上，不挂在外层：滚进来的那层带着 transform 被单独合成，外层的
 * `background-clip: text` 裁不到它，滚动那一下字会整个消失。所以用它的行，外层不要再挂一道扫光。
 *
 * 只是往后长的一句（`text` 变了、`rollKey` 没变）不滚，只缓宽度：前面的字原地不动，新接上的那截随着框
 * 变宽从句尾露出来。
 */
export function RollWords({
	rollKey,
	text,
	from,
	glide,
	enter,
	children,
}: {
	/** 换了它才算换了一句；同一句里参数还在流进来，不重新滚。 */
	rollKey: string;
	/** 这句话现在的字。给了它，字变了也缓宽度，但不滚。 */
	text?: string;
	/** 挂上时从这个宽度缓过来：这一行接替了原地另一行的字（比如一列步骤里后一步接替前一步那一行）。 */
	from?: number;
	glide?: boolean;
	/** 挂上的时候也滚：这一行接替了原地的另一行。 */
	enter?: boolean;
	children: ReactNode;
}) {
	const rolls = useRolled(rollKey) || enter;
	const box = useRef<HTMLSpanElement>(null);
	const width = useRef<number | null>(from ?? null);
	useTickedAnimations(box, GLIDE, Boolean(glide));

	useLayoutEffect(() => {
		const element = box.current;
		if (!element) return;
		const from = width.current;
		if (from === null) {
			// 头一次只记下宽度，不写样式：转录里每一行挂上时都走这里，写一次就让下一行的读重新排版。
			width.current = element.offsetWidth;
			return;
		}
		element.style.width = "";
		const to = element.offsetWidth;
		width.current = to;
		if (from === to) return;
		element.style.width = `${from}px`;
		void element.offsetWidth;
		element.style.width = `${to}px`;
	}, [rollKey, text]);

	return (
		<span
			ref={box}
			className="plume-roll-words"
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget) event.currentTarget.style.width = "";
			}}
		>
			<span key={rollKey} className={`inline-block ${rolls ? "plume-roll-soft" : ""}`}>
				<span className={glide ? "plume-glide" : undefined}>{children}</span>
			</span>
		</span>
	);
}
