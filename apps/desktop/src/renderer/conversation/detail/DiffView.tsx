import { OverlayScrollbar, translate } from "@plume/ui";
import { useRef } from "react";
import { type DiffHunk, useDiffHighlight } from "./diff-highlight.ts";

/**
 * 统一 diff：左边一栏行号，加的行一条绿色竖条、删的行一条红色，代码在底下照语法上色。
 *
 * 长行横着滚，这就是分层的原因：行铺在和最长那行一样宽的一层上，底色和分隔线跟着整行走，不在折叠处断掉；行号和竖条钉在
 * 左边，行长到要横着滚的时候正是最想知道在哪一行的时候。hunk 头、截断提示这些不是代码的东西也钉住，横滚走了谁也帮不上。
 */
export function DiffView({
	hunks,
	path,
	showPath = false,
	maxLines = 600,
}: {
	hunks: DiffHunk[];
	/** 是哪个文件：语法按扩展名定，没有路径就只能画纯文本。画不画在上面是 `showPath` 的事。 */
	path?: string;
	showPath?: boolean;
	maxLines?: number;
}) {
	let emitted = 0;
	const scroller = useRef<HTMLDivElement>(null);
	// 语法加载完之前、认不出的文件都是 null：行退回纯文本，diff 从不等解析器才读得了。
	const coloured = useDiffHighlight(hunks, path);

	return (
		<div className="plume-scroll-host relative">
			{/* 代码字号，不是界面字号：这里是代码，跟着「代码字号」走。 */}
			<div ref={scroller} className="tool-diff-scroll overflow-x-auto font-mono text-code">
				<div className="w-max min-w-full">
					{showPath && path && <div className="sticky left-0 w-max border-b border-line-soft px-3 py-1.5 text-caption text-ink-faint">{path}</div>}
					{hunks.map((hunk, hunkIndex) => (
						<div key={hunkIndex} className="border-b border-line-soft last:border-b-0">
							{hunkIndex > 0 && (
								<div className="sticky left-0 w-max bg-shell/60 px-3 py-0.5 text-caption text-ink-faint">
									@@ -{hunk.oldStart} +{hunk.newStart} @@
								</div>
							)}
							{hunk.lines.map((line, lineIndex) => {
								if (emitted >= maxLines) return null;
								// 配色和这些行按同一个次序生成，数到第几行就是第几份配色。
								const tokens = coloured?.[emitted];
								emitted += 1;
								const kind = line.type === "add" ? "tool-diff-add" : line.type === "remove" ? "tool-diff-remove" : "";
								return (
									<div key={lineIndex} className={`flex ${kind}`}>
										{/* 钉住的两栏要有不透明的底：行的底色是半透明的，代码横滚时会从数字中间穿过去。 */}
										<span className="tool-diff-gutter sticky left-0 z-[1] w-[42px] shrink-0 pr-2 text-right select-none">
											{line.newLine ?? line.oldLine ?? ""}
										</span>
										<span className="tool-diff-rail sticky left-[42px] z-[1] w-[3px] shrink-0" />
										{/* 语法没加载完时底色和竖条已经说了改动，字先用中性色，不闪一下整片绿或整片红。 */}
										<span className="shrink-0 px-2.5 whitespace-pre text-ink">
											{tokens?.length
												? tokens.map((token, index) => (
														<span key={index} className={token.className}>
															{token.text}
														</span>
													))
												: line.text || " "}
										</span>
									</div>
								);
							})}
						</div>
					))}
					{emitted >= maxLines && <div className="sticky left-0 w-max px-3 py-1.5 text-caption text-ink-faint">{translate("diffView.truncated")}</div>}
				</div>
			</div>
			{/* 画出来而不用原生的：macOS 把滚动条藏到有东西动才出来，一行字跑出右边又没有滑块，读起来像被截断了。 */}
			<OverlayScrollbar viewport={scroller} orientation="horizontal" placement="sticky" />
		</div>
	);
}
