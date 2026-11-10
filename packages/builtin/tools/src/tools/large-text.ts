/**
 * 大到不该整个读进来的文件，取其中一段行。
 *
 * 整个 `readFile` 再 `split` 的话，2 GB 的日志先是 2 GB 的缓冲，再是两倍大的字符串，再是每一行的数组，
 * 而给模型看的最多 `OUTPUT_BUDGET` 个字。超过 `STREAM_ABOVE_BYTES` 的改为流式读：每个换行都数，
 * 「第 a-b 行，共 N 行」照样准，只有窗口里的行才解码。
 */

import { createReadStream } from "node:fs";
import { MAX_LINE_CHARS } from "./long-line.ts";
import { looksBinary } from "./paths.ts";

/**
 * 远超大纲帮得上忙的源码文件（大纲得放进一条结果），又小到整个读进来最多几十 MB 内存。
 */
export const STREAM_ABOVE_BYTES = 8 * 1024 * 1024;

/**
 * 一行最多留多少。压缩过的打包文件、JSON 导出可能整个文件就一行；超过这里 `char_offset` 够不到，结果里会说。
 */
export const LINE_KEEP_BYTES = 1024 * 1024;

export interface LineWindowRead {
	/** 第一块里有 NUL，和 `looksBinary` 对小文件的判断一样。 */
	binary: boolean;
	totalLines: number;
	/** 从 `offset` 起的行，`limit` 和输出额度放得下多少就有多少。 */
	lines: string[];
	/** 在 `LINE_KEEP_BYTES` 处被截断的行号，从 1 数。 */
	cut: number[];
}

/**
 * 从第 `offset` 行（从 1 数）起，按 `decodeText` 读小文件的方式读：没有 BOM、换行是 `\n`、末尾的换行不算新的一行。
 * 每行 `\n` 前的 `\r` 逐行去掉——全是 CRLF 的文件正好等于 `decodeText`；混合换行的显示时丢了 `\r`，
 * 那本来也只有磁盘上的字节看得出。
 *
 * 估计要画的行肯定超出 `budget` 时就不再收：调用方的渲染总是先用完额度、再用完行，才能说从哪里接着读。
 */
export async function readLineWindow(
	path: string,
	offset: number,
	limit: number,
	charStart: number,
	budget: number,
	signal?: AbortSignal,
): Promise<LineWindowRead> {
	const from = offset - 1;
	const to = from + limit;
	const lines: string[] = [];
	const cut: number[] = [];
	let line = 0;
	let parts: Buffer[] = [];
	let kept = 0;
	let overflow = false;
	let collecting = true;
	let used = 0;
	let first = true;
	let endsWithNewline = false;

	const wanted = () => collecting && line >= from && line < to;
	const endLine = () => {
		if (wanted()) {
			let text = Buffer.concat(parts).toString("utf8");
			if (line === 0 && text.startsWith("\uFEFF")) text = text.slice(1);
			if (text.endsWith("\r")) text = text.slice(0, -1);
			lines.push(text);
			if (overflow) cut.push(line + 1);
			/*
			 * 至少是 `renderLines` 要花的：这一行加 `→`，或者它的一个字符窗口。取下限，先用完额度的总是渲染那边，
			 * 它说的「输出到上限了」才是真的。
			 */
			const inline = text.length <= MAX_LINE_CHARS && charStart <= 0;
			used += inline ? text.length + 2 : Math.max(0, Math.min(MAX_LINE_CHARS, text.length - charStart) - 1);
			if (used > budget) collecting = false;
		}
		parts = [];
		kept = 0;
		overflow = false;
		line += 1;
	};

	const stream = createReadStream(path, { highWaterMark: 1024 * 1024, signal });
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		if (first) {
			first = false;
			if (looksBinary(chunk)) {
				stream.destroy();
				return { binary: true, totalLines: 0, lines: [], cut: [] };
			}
		}
		let pos = 0;
		while (pos < chunk.length) {
			const newline = chunk.indexOf(10, pos);
			const end = newline === -1 ? chunk.length : newline;
			if (wanted() && end > pos) {
				const room = LINE_KEEP_BYTES - kept;
				if (end - pos > room) overflow = true;
				if (room > 0) {
					// 复制一份：视图会为了几个字节把整块 1 MB 留在内存里。
					const piece = Buffer.from(chunk.subarray(pos, Math.min(end, pos + room)));
					parts.push(piece);
					kept += piece.length;
				}
			}
			if (newline === -1) break;
			endLine();
			pos = newline + 1;
		}
		endsWithNewline = chunk.length > 0 && chunk[chunk.length - 1] === 10;
	}
	// 最后一行，除非文件以换行结尾——和 `split` 后丢掉末尾的 "" 一样。
	if (!endsWithNewline || line === 0) endLine();
	return { binary: false, totalLines: line, lines, cut };
}
