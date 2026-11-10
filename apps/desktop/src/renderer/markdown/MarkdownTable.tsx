/**
 * 回复里的一张表，以及标记本身给不了它的两样东西。
 *
 * 单元格不换行（`white-space: nowrap`）——为了省八个像素把「一键新机」拆成两行，比横着滚一下更难读——
 * 所以列数多到超过阅读栏宽度的表会比它的框宽。外层本来就会横滚，缺的是告诉人它能滚：原生滚动条全局
 * 关掉了，溢出是无声的，一张在词中间断掉的表看上去就像表到那儿结束了。
 *
 * 所以：底边画一条应用自己的滑块（悬停时出现），再给一个开关，让宁愿一次读完、不愿拖着看的人把不换行
 * 关掉。换行只对这一张表、不记住——它和横滚一样，是看**这一张**的一种方式。
 */

import { CornerDownLeft, MoveHorizontal } from "@plume/ui/icons";
import { IconButton, OverlayScrollbar, useI18n } from "@plume/ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import type { Block } from "./blocks.ts";

type TableBlock = Extract<Block, { kind: "table" }>;

export function MarkdownTable({
	block,
	inline,
}: {
	block: TableBlock;
	/**
	 * 单元格的字怎么画成元素，由调用方传进来而不是在这里 import。
	 *
	 * 它在 `Markdown.tsx` 里，而画这张表的正是那里——反过来 import 就成了循环；单元格里的强调、链接怎么画，
	 * 也是渲染器才知道的事。
	 */
	inline: (text: string) => ReactNode;
}) {
	const { t } = useI18n();
	const viewport = useRef<HTMLDivElement>(null);
	const [wrap, setWrap] = useState(false);
	const [overflow, setOverflow] = useState(false);

	/*
	 * 右边有没有被藏住的部分，一直盯着而不是量一次。
	 *
	 * 改变它的两件事都不是这个组件的重画：窗格变窄，以及——还在输出的回复里——新到的行把某一列撑宽。
	 * 除了框，表本身也要观察：框是宽度由外面版面决定的块，内容变了它不会跟着变尺寸。
	 */
	useLayoutEffect(() => {
		const el = viewport.current;
		if (!el) return;
		const measure = () => setOverflow(el.scrollWidth - el.clientWidth > 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		for (const child of el.children) observer.observe(child);
		return () => observer.disconnect();
	}, []);

	const control = overflow || wrap;
	const label = t(wrap ? "markdown.tableNowrap" : "markdown.tableWrap");

	return (
		<div className="markdown-table plume-hscroll-own group relative" data-wrap={wrap ? "true" : "false"} data-control={control ? "true" : undefined}>
			{/*
			 * 和代码块的复制按钮坐同一个位置：框的右上角，不占版面。单独留一条、或者在旁边加一列，都会改变
			 * 表的比例。角上那块渐变底让表头的字不会压在图标底下。
			 */}
			{control && (
				<span className="markdown-table-corner">
					<IconButton
						size="xs"
						label={label}
						active={wrap}
						className="markdown-table-toggle"
						icon={wrap ? <MoveHorizontal size={13} strokeWidth={1.9} /> : <CornerDownLeft size={13} strokeWidth={1.9} />}
						onClick={() => setWrap((on) => !on)}
					/>
				</span>
			)}
			<div ref={viewport} className="markdown-table-scroll">
				<table>
					<thead>
						<tr>
							{block.header.map((cell, index) => (
								<th key={index} style={{ textAlign: block.align[index] ?? "left" }}>
									{inline(cell)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{block.rows.map((row, rowIndex) => (
							<tr key={rowIndex}>
								{row.map((cell, cellIndex) => (
									<td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? "left" }}>
										{inline(cell)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<OverlayScrollbar viewport={viewport} orientation="horizontal" />
		</div>
	);
}
