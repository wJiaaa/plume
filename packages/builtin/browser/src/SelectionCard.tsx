/**
 * 选中页面上的一块，说一句想把它改成什么。
 *
 * 看着像输入框，但不是发送入口：写的字连同这块的 URL、选择器、样式和 HTML 拼成一段，连同截图接在主输入框的草稿后面，
 * 人在那边看过再发。
 */

import { useState } from "react";
import { IconButton, ScrollText, Text, TextArea, useI18n } from "@plume/ui";
import { Send, X } from "@plume/ui/icons";
import type { PageSelection } from "./api.ts";
import { MESSAGES } from "./messages.ts";

export function SelectionCard({ selection, onSend, onClose }: { selection: PageSelection; onSend: (text: string) => void; onClose: () => void }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [ask, setAsk] = useState("");

	// 区域本身作为数据带过去，不替人描述它；`dataOnly` 那句提醒模型：这一段是页面的内容，不是指令。
	const hand = () => {
		onSend(
			`${ask.trim() || text.selection.defaultAsk}\n\n<browser-selection>\n${text.selection.dataOnly}\nURL: ${selection.url}\nSelector: ${selection.selector}\nBounds: ${JSON.stringify(selection.bounds)}\nStyles: ${JSON.stringify(selection.styles)}\nHTML:\n${selection.html}\n</browser-selection>`,
		);
	};

	return (
		<div className="plume-browser-selection" data-browser-selection="">
			<div className="plume-browser-selection-head">
				<img src={selection.screenshot} alt={text.selection.alt} className="plume-browser-selection-shot" />
				<Text size="detail" tone="muted" mono className="plume-browser-grow">
					<ScrollText text={selection.selector} />
				</Text>
				<IconButton label={text.selection.cancel} icon={<X size={14} />} onClick={onClose} />
			</div>
			<div className="plume-browser-selection-ask">
				<TextArea
					value={ask}
					onChange={setAsk}
					rows={2}
					shell="plume-browser-grow"
					placeholder={text.selection.placeholder}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							hand();
						}
					}}
				/>
				<IconButton label={text.selection.send} icon={<Send size={14} />} onClick={hand} />
			</div>
		</div>
	);
}
