import { MarkNumber, OverlayScrollbar, Text } from "@plume/ui";
import { useRef } from "react";
import type { ChangeHunk } from "@plume/contract";
import { useDiffCommenting, type DiffCommenting } from "./DiffComments.tsx";
import { useT, type Translate } from "./i18n.ts";

/**
 * 统一 diff：左边一栏行号，加的行一条绿色竖条，删的行一条红色，代码在底下。
 *
 * 长行横着滚，这就是分层的原因：行铺在和最长那行一样宽的一层上，底色和分隔线跟着整行走，不在折叠处断掉；
 * 行号和竖条钉在左边，行长到要横着滚的时候正是最想知道在哪一行的时候。hunk 头、截断提示这些不是代码的东西也钉住。
 */
export function DiffView({ hunks, path, showPath = false, maxLines = 600 }: { hunks: ChangeHunk[]; path?: string; showPath?: boolean; maxLines?: number }) {
	const t = useT();
	let emitted = 0;
	const scroller = useRef<HTMLDivElement>(null);
	// 只有改动视图能评论，别处行号还是一段字。
	const commenting = useDiffCommenting();

	return (
		<div className="plume-scroll-host git-diff-host">
			{/* 代码字号，不是界面字号：这里是代码，跟着「代码字号」走（见 diff.css）。 */}
			<div ref={scroller} className="git-diff-scroll">
				<div className="git-diff-sheet">
					{showPath && path && (
						<Text as="div" size="caption" tone="faint" className="git-diff-note git-diff-path">
							{path}
						</Text>
					)}

					{hunks.map((hunk, hunkIndex) => (
						<div key={hunkIndex} className="git-diff-hunk">
							{hunkIndex > 0 && (
								<Text as="div" size="caption" tone="faint" className="git-diff-hunk-head">
									@@ -{hunk.oldStart} +{hunk.newStart} @@
								</Text>
							)}

							{hunk.lines.map((line, lineIndex) => {
								if (emitted >= maxLines) return null;
								emitted += 1;
								const added = line.type === "add";
								const removed = line.type === "remove";
								return (
									<div key={lineIndex} className={`git-diff-line ${added ? "git-diff-add" : removed ? "git-diff-remove" : ""}`}>
										{commenting && path ? (
											<DiffGutterButton t={t} commenting={commenting} path={path} hunk={hunk} lineIndex={lineIndex} />
										) : (
											<span className="git-diff-gutter">{line.newLine ?? line.oldLine ?? ""}</span>
										)}
										<span className="git-diff-rail" />
										<span className="git-diff-code">{line.text || " "}</span>
									</div>
								);
							})}
						</div>
					))}

					{emitted >= maxLines && (
						<Text as="div" size="caption" tone="faint" className="git-diff-note">
							{t("diffView.truncated")}
						</Text>
					)}
				</div>
			</div>

			{/* 画出来而不用原生的：macOS 把滚动条藏到有东西动才出来，一行字跑出右边又没有滑块，读起来像被截断了。 */}
			<OverlayScrollbar viewport={scroller} orientation="horizontal" placement="sticky" />
		</div>
	);
}

/**
 * 行号就是在这一行留评论的地方，见 `DiffCommentsProvider`。
 *
 * 不进 Tab 顺序：一个 diff 有几百个行号，一个个 Tab 过去才到下一个文件，比用键盘够不着它们更糟。
 */
function DiffGutterButton({
	t,
	commenting,
	path,
	hunk,
	lineIndex,
}: {
	t: Translate;
	commenting: DiffCommenting;
	path: string;
	hunk: ChangeHunk;
	lineIndex: number;
}) {
	const line = hunk.lines[lineIndex]!;
	const number = line.newLine ?? line.oldLine ?? "";
	const note = commenting.noteOf(path, line);
	return (
		<button
			type="button"
			tabIndex={-1}
			aria-label={t("diffComment.pick", { line: number })}
			data-diff-note={note ? (note.draft ? "draft" : "saved") : undefined}
			className="git-diff-gutter git-diff-pick"
			onMouseDown={(event) => {
				if (event.button !== 0) return;
				// 在这里拖或 Shift 点是在挑行，不拦的话旁边的代码也会被选上。
				event.preventDefault();
				commenting.press({ path, hunk, lineIndex }, event.currentTarget, event.shiftKey);
			}}
			onMouseEnter={(event) => commenting.enter({ path, hunk, lineIndex }, event.currentTarget)}
		>
			{note?.last ? <MarkNumber n={note.n} className="git-diff-mark" /> : number}
		</button>
	);
}
