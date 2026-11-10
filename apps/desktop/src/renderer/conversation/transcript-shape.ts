/**
 * 转录的形状——行（`runs`）、块（`turnBlocks`）——每拍只重算最后一轮。
 *
 * 流式时消息每拍换一个数组，而变的只有最后一条。从头算一遍是整个会话的量，每拍一次，会话越长越重。这里在最后一轮开头留一个
 * 检查点（`RunsCheckpoint`），前面那几轮的消息对象一个不差（按引用比）就从检查点接着算；结果和从头算逐项相同，
 * `transcript-shape.test.ts` 拿随机转录对拍。前面几轮的行对象也就一拍一拍原样沿用，下游按引用比的 memo 不会白白重画。
 *
 * 认不出来的时候一律从头算，宁可慢一拍：重新读了会话（前面的消息换了对象）、压缩或连接记录换了一份、插件登记的卡片变了。
 */

import type { Message } from "@plume/contract";
import { type Run, type RunMark, runMarks, type RunsCheckpoint, type RunsOptions, walkRuns } from "./grouping.ts";
import { type BlockStart, blocksFrom, opensBlock, type TurnBlock, withoutThinking } from "./turn-blocks.ts";
import { opensTurn, resumesTurn } from "./turns.ts";

/** 最后一轮从哪一条开始；没有就是 -1。第 0 条开的那一轮不留检查点：从它接着走就是从头走。 */
function lastTurnStart(messages: readonly Message[]): number {
	for (let at = messages.length - 1; at > 0; at--) {
		if (opensTurn(messages[at]!) && !resumesTurn(messages, at)) return at;
	}
	return -1;
}

/** `messages` 的 `[0, through]` 和 `kept` 是不是同一批对象。 */
function samePrefix(messages: readonly Message[], kept: readonly Message[], through: number): boolean {
	if (messages.length <= through || kept.length <= through) return false;
	for (let at = 0; at <= through; at++) if (messages[at] !== kept[at]) return false;
	return true;
}

/** 检查点之前消费掉的标记还是同一批，而且排在后面的那一个还在检查点或之后。 */
function sameMarks(sorted: RunMark[], kept: RunMark[], at: number): boolean {
	for (let i = 0; i < kept.length; i++) if (sorted[i]?.source !== kept[i]!.source) return false;
	const next = sorted[kept.length];
	return next === undefined || next.at >= at;
}

/** `runs(messages, options)`，推理不画时再过一遍 `withoutThinking`。 */
export class RunsCache {
	private mark: RunsCheckpoint | null = null;
	private kept: readonly Message[] = [];
	/** 检查点那一刻插件登记的卡片：变了，哪些调用单独成行跟着变，前面的行也作废。 */
	private revision: unknown;
	/** 检查点之前那几行过一遍 `withoutThinking` 的结果，跟着检查点走：它给拿掉推理的行换新对象，每拍重做就每拍都是新的。 */
	private thin: { mark: RunsCheckpoint; rows: Run[] } | null = null;

	runs(messages: readonly Message[], options: RunsOptions, showThinking: boolean, revision: unknown): Run[] {
		const marks = runMarks(options);
		const turnAt = lastTurnStart(messages);
		const from =
			this.mark &&
			revision === this.revision &&
			turnAt >= this.mark.at &&
			samePrefix(messages, this.kept, this.mark.at) &&
			sameMarks(marks, this.mark.marks, this.mark.at)
				? this.mark
				: null;
		if (!from) this.forget(revision);
		// 检查点没挪就不再留一个：留一次要把前面的行复制一遍。
		const walked = walkRuns(messages, { ...options, marks, from: from ?? undefined, mark: turnAt > 0 && turnAt !== from?.at ? turnAt : undefined });
		if (walked.mark) {
			this.mark = walked.mark;
			this.kept = messages;
		}
		const mark = walked.mark ?? from;
		if (showThinking) return walked.rows;
		if (!mark) return withoutThinking(walked.rows);
		if (this.thin?.mark !== mark) this.thin = { mark, rows: withoutThinking(mark.rows) };
		return this.thin.rows.concat(withoutThinking(walked.rows.slice(mark.rows.length)));
	}

	private forget(revision: unknown): void {
		this.mark = null;
		this.kept = [];
		this.thin = null;
		this.revision = revision;
	}
}

/**
 * `turnBlocks(list, live)`。
 *
 * 和上一次的 `list` 从头比，前面一段是同一批行对象，就从那一段里最后一个开轮处接着分：块只在开轮处断，之前的块与后面无关
 * （见 `blocksFrom`）。
 */
export class TurnBlocksCache {
	private list: Run[] = [];
	private blocks: TurnBlock[] = [];
	private starts: BlockStart[] = [];

	turnBlocks(list: Run[], live: boolean): TurnBlock[] {
		let same = 0;
		const limit = Math.min(list.length, this.list.length);
		while (same < limit && list[same] === this.list[same]) same++;
		/*
		 * 开轮那一行之前的行都没变，它之前的块就不变。那一行本身可以是新对象（最后一轮的行每拍都是新算的），只要它还开轮。
		 * `live` 只管末尾那一块，从最后一轮开头接着分就照顾到了。
		 */
		let from: BlockStart | undefined;
		for (let i = this.starts.length - 1; i >= 0; i--) {
			const at = this.starts[i]!.at;
			if (at < same || (at === same && at < list.length && opensBlock(list[at]!))) {
				from = this.starts[i];
				break;
			}
		}
		const next = blocksFrom(list, live, from, this.blocks);
		const kept = from ? this.starts.slice(0, this.starts.indexOf(from)) : [];
		this.list = list;
		this.blocks = next.blocks;
		this.starts = kept.concat(next.starts);
		return next.blocks;
	}
}
