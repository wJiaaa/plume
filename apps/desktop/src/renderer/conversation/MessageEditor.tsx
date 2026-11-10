/**
 * 改一条已经发出去的消息。
 *
 * 外观和主输入框是一家：改一句话和写一句话是同一件事，长得像打字的那个框，不用标签也看得出能改。
 * 回车发送、Shift+回车换行、Esc 取消；输入法还在拼字时回车不算。
 */

import { Button, OverlayScrollbar, Textarea, translate, useFieldFade } from "@plume/ui";
import { Check, X } from "@plume/ui/icons";
import { useEffect, useRef } from "react";

/** 长到多高开始滚：长消息不该挤在三行的窗里改。 */
const MAX_HEIGHT = 320;

export function MessageEditor({
	value,
	onChange,
	onSubmit,
	onCancel,
	confirmLabel = translate("common.send"),
	maxHeight = MAX_HEIGHT,
}: {
	value: string;
	onChange: (next: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
	/** 确认那颗的字：侧边聊天里叫「重新提问」。 */
	confirmLabel?: string;
	/** 窄面板里矮一些。 */
	maxHeight?: number;
}) {
	const box = useRef<HTMLTextAreaElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	useFieldFade(box, scroller);

	// 跟着字长高。
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	}, [value, maxHeight]);

	return (
		<div className="plume-composer w-full rounded-2xl border border-line-soft bg-transparent px-[var(--plume-composer-x)] py-[var(--plume-composer-in)]">
			<div ref={scroller} className="plume-scroll-host relative">
				<Textarea
					ref={box}
					autoFocus
					value={value}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							// 拦下：外面的面板、弹层会把它当成「关掉我」。
							event.stopPropagation();
							onCancel();
						}
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							onSubmit();
						}
					}}
					rows={1}
					style={{ maxHeight }}
					className="plume-field-fade block w-full resize-none overflow-y-auto bg-transparent text-body leading-relaxed text-ink outline-none"
				/>
				<OverlayScrollbar viewport={box} orientation="vertical" />
			</div>
			{/* 一个叉一个勾；确认那颗是实心的，图标没看清，深浅也说明了哪颗是「就这么办」。 */}
			<div className="flex items-center justify-end gap-2 pt-2">
				<Button size="sm" label={translate("common.cancel")} onClick={onCancel} icon={<X size={13} strokeWidth={2} aria-hidden />} />
				<Button
					variant="primary"
					size="sm"
					label={confirmLabel}
					disabled={!value.trim()}
					onClick={onSubmit}
					icon={<Check size={13} strokeWidth={2.2} aria-hidden />}
				/>
			</div>
		</div>
	);
}
