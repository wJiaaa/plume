/**
 * 一条自己发出去的消息，气泡里那部分正文。
 *
 * **两种画法，按有没有附件标记分。**
 *
 * - **没有标记**：整段交给 Markdown。一条以 `# 需求1` 开头的消息，人写的时候就是当标题写的，画成一行井号是把他的意思丢了。
 * - **有标记**：保持行内纯文本。Markdown 是块级的，`看这张 【图片 1】 再看那张` 交给它会切成「段落、标签、段落」三块竖着排，
 *   一句话被拆成三行。带附件的消息几乎都是短句，这一支够用。
 *
 * **太长的折起来。** 一段两万字的 JSON 贴进来，气泡能把整屏占满好几遍，回复被顶到很远的地方。超过 `FOLD_AT` 行只露出 `FOLD_TO`
 * 行、底下化开，留一颗按钮展开。两个数不一样，是为了不出现「折起来只藏了一两行」：点开什么也没多看到。
 */

import { Button, useI18n } from "@plume/ui";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { placeAttachments } from "../composer/attachments/placeholders.ts";
import { Markdown } from "../markdown/Markdown.tsx";

/** 超过这么多行才折。 */
const FOLD_AT = 14;
/** 折起来露出这么多行。 */
const FOLD_TO = 10;

export function BubbleText<File extends { name: string; label?: string }>({
	text,
	files,
	renderFile,
	className = "",
}: {
	/** 人打的那些字，`【图片 1】` 这样的标记留在里面。 */
	text: string;
	/** 这条消息带的附件，用来认出文中的标记。 */
	files: File[];
	/** 一枚标记画成什么，由调用方给：点了以后做什么只有它知道。 */
	renderFile: (file: File, at: number) => ReactNode;
	className?: string;
}) {
	const { t } = useI18n();
	const segments = useMemo(() => placeAttachments(text, files).segments, [text, files]);
	const hasFiles = segments.some((segment) => segment.kind === "file");
	const box = useRef<HTMLDivElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const [foldable, setFoldable] = useState(false);
	const [open, setOpen] = useState(false);

	/*
	 * 量里面那层的自然高度，不量外面那层：外面那层折起来以后被 `max-height` 压住，量它永远「不超」，折一次就再也认不出自己该折。
	 * layout effect 里量，第一帧画出来就已经是折好的样子；宽度一变行数就变，所以盯着它。
	 */
	useLayoutEffect(() => {
		const inner = body.current;
		const outer = box.current;
		if (!inner || !outer) return;
		const measure = () => {
			const line = Number.parseFloat(getComputedStyle(outer).lineHeight);
			setFoldable(Number.isFinite(line) && line > 0 && inner.offsetHeight > line * FOLD_AT);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(inner);
		return () => observer.disconnect();
	}, [text]);

	const folded = foldable && !open;

	return (
		<div className={className}>
			<div ref={box} className="plume-bubble-fold" data-folded={folded ? "" : undefined} style={folded ? { maxHeight: `${FOLD_TO}lh` } : undefined}>
				<div ref={body}>
					{hasFiles ? (
						<p className="break-words whitespace-pre-wrap">
							{segments.map((segment, at) => (segment.kind === "text" ? segment.text : renderFile(segment.file, at)))}
						</p>
					) : (
						<Markdown text={text} />
					)}
				</div>
			</div>
			{foldable && (
				<Button
					variant="subtle"
					size="xs"
					expanded={open}
					data-plume-bubble-fold-toggle=""
					className="mt-1.5 -ml-1.5 font-medium"
					onClick={() => {
						setOpen(!open);
						// 展开后读到了底再收起，气泡一下子矮回十行，人就落在它下面很远的地方：把它拉回视野里。
						if (open) requestAnimationFrame(() => box.current?.scrollIntoView({ block: "nearest" }));
					}}
				>
					{open ? t("userMessage.showLess") : t("userMessage.showMore")}
				</Button>
			)}
		</div>
	);
}
