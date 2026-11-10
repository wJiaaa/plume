/**
 * 输入框上方的对话引用：一段引文一枚签，指上去展开引文本身，签末尾的叉删掉它。
 *
 * 引文不放进框里的字：几百字的一段塞进去，框被撑满，要问的那句话被挤到看不见的地方，删也只能一个字一个字删。收成签，
 * 框里只剩人自己要说的话；要核对引了什么，指上去看。删除放在签上而不是卡片里：从签挪到卡片上才够得着的按钮，人找不到。
 * 样子跟会话引用签一致（8px 圆角的描边签），用户要求不用全圆角胶囊。
 */

import { Popover, useI18n } from "@plume/ui";
import { ClipboardPen, X } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { DraftQuote } from "../conversation/quote.ts";

/** 指上去稍等一下再开：从签上划过去打字的那一下不该弹出一张卡。 */
const OPEN_MS = 180;
/** 从签挪到卡片上要跨过中间那几 px 空档，关得太快就够不着卡片。 */
const CLOSE_MS = 160;

export function QuoteChip({ quotes, onRemove }: { quotes: readonly DraftQuote[]; onRemove: (id: string) => void }) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{quotes.map((quote) => (
				<OneQuote key={quote.id} quote={quote} onRemove={() => onRemove(quote.id)} />
			))}
		</div>
	);
}

function OneQuote({ quote, onRemove }: { quote: DraftQuote; onRemove: () => void }) {
	const { t } = useI18n();
	const chip = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const later = (next: boolean, delay: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setOpen(next), delay);
	};
	const close = () => {
		clearTimeout(timer.current);
		setOpen(false);
	};
	// 签上只放第一行：引文常常是一整段，签的宽度只够认出是哪一段。
	const excerpt = quote.text.split("\n").find((line) => line.trim()) ?? quote.text;

	return (
		<>
			<div
				ref={chip}
				data-plume-quote-chip=""
				className="flex h-8 max-w-[240px] items-center rounded-lg border border-line-soft bg-card text-caption text-ink-muted transition-colors hover:text-ink"
			>
				<button
					type="button"
					aria-expanded={open}
					aria-haspopup="dialog"
					onMouseEnter={() => later(true, OPEN_MS)}
					onMouseLeave={() => later(false, CLOSE_MS)}
					// 键盘和触控板轻点：不等，当场开合。
					onClick={() => {
						clearTimeout(timer.current);
						setOpen((was) => !was);
					}}
					className="flex h-full min-w-0 items-center gap-1.5 pl-2"
				>
					<ClipboardPen size={12} className="shrink-0" />
					<span className="min-w-0 truncate">{excerpt.trim()}</span>
				</button>
				<button
					type="button"
					aria-label={t("composer.removeQuote")}
					onClick={() => {
						close();
						onRemove();
					}}
					className="flex h-full shrink-0 items-center px-1.5 hover:text-ink"
				>
					<X size={12} />
				</button>
			</div>
			{open && (
				<Popover
					anchor={chip.current}
					onClose={close}
					placement="top"
					align="start"
					width="panel"
					surface="panel"
					role="dialog"
					label={t("composer.quotesTitle")}
					maxHeight={360}
					onMouseEnter={() => clearTimeout(timer.current)}
					onMouseLeave={() => later(false, CLOSE_MS)}
				>
					<div data-plume-quote-card="" className="px-3 py-2.5">
						<p className="line-clamp-6 text-label break-words whitespace-pre-wrap text-ink">{quote.text}</p>
						<p className="mt-1 text-caption text-ink-faint">{t(quote.from === "user" ? "composer.quoteFromUser" : "composer.quoteFromAssistant")}</p>
					</div>
				</Popover>
			)}
		</>
	);
}
