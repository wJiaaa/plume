/**
 * 命令输出给模型看的那一份：对**原始的累计输出**只截一次。
 *
 * 以前每来一段就对「上次截过的结果 + 新的一段」再截一次：摘录标记一层套一层（实测 82 层），
 * 第一条错误被重复 83 次、后面的错误反而挤没了，「22 characters omitted」实际丢了约 44 万字符——
 * 数的是这一段比上限多出来的那点，不是真正省略的。
 *
 * 现在累计输出放在 `OutputBuffer` 里：不超过 `KEEP` 时整份留着，渲染就是对整份截一次；超过以后
 * 头部冻结、尾部滚动，中间只留字符数、行号和错误行摘录（错误行在流过时就摘出来）。两种情况下
 * 省略的字符数和行号都是精确的，行号对应完整日志文件，模型可以拿去 `read`。
 *
 * 截断按整行切：头部取尽量多的整行、尾部同理，中间整段省略。单行超过 `MAX_LINE_CHARS` 的留头留尾，
 * 标出行号和 `char_offset`。
 */

import { MAX_LINE_CHARS } from "./long-line.ts";

const ERROR_LINE = /✖|✗|× failing|FAIL(?:ING|ED)?\b|AssertionError|Error:|error TS\d+|ELIFECYCLE|oxlint|not ok\b|failed\b/i;
/** 错误行前后各带几行上下文。 */
const CONTEXT = 8;
/** 内存里最多留多少原始字符；超过就只留头尾各一半。 */
const KEEP = 200_000;
/** 标记本身预留的字符数。 */
const MARKER_ROOM = 240;

/** 文本起点在完整输出里的位置：1 起的行号，0 起的列。 */
interface Origin {
	line: number;
	column: number;
}

function newlines(text: string): number {
	let count = 0;
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++;
	return count;
}

function advance(origin: Origin, text: string): Origin {
	const last = text.lastIndexOf("\n");
	if (last === -1) return { line: origin.line, column: origin.column + text.length };
	return { line: origin.line + newlines(text), column: text.length - last - 1 };
}

/** 一行太长时留头留尾；标出的行号与 `char_offset` 对应完整日志，给 `read` 用。 */
function capLine(line: string, lineNo: number, column: number): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	const tail = Math.max(1, Math.floor(MAX_LINE_CHARS / 3));
	const head = MAX_LINE_CHARS - tail;
	return `${line.slice(0, head)} … [${line.length - MAX_LINE_CHARS} characters omitted; line ${lineNo} char_offset=${column + head + 1}] … ${line.slice(-tail)}`;
}

/** 按行流式摘错误行：命中行前后各 `CONTEXT` 行，相邻的并成一段，超出预算就停。 */
class ErrorScanner {
	private readonly budget: number;
	private readonly blocks: string[] = [];
	private used = 0;
	private full = false;
	private block: string[] | null = null;
	private gap: string[] = [];
	private after = 0;

	constructor(budget: number) {
		this.budget = budget;
	}

	line(text: string): void {
		if (this.full) return;
		if (ERROR_LINE.test(text)) {
			this.block = [...(this.block ?? []), ...this.gap, text];
			this.gap = [];
			this.after = CONTEXT;
			return;
		}
		if (this.block && this.after > 0) {
			this.block.push(text);
			this.after--;
			return;
		}
		this.gap.push(text);
		if (this.gap.length > CONTEXT) {
			// 下一个命中的上文够不着这一段了，它可以定稿。
			if (this.block) this.close(this.block);
			this.block = null;
			this.gap.shift();
		}
	}

	private close(lines: string[]): void {
		const chunk = lines.join("\n");
		if (this.used + chunk.length + 8 > this.budget) {
			const room = this.budget - this.used - 8;
			if (room > 80) this.blocks.push(chunk.slice(0, room));
			this.full = true;
			return;
		}
		this.blocks.push(chunk);
		this.used += chunk.length + 8;
	}

	/** 到目前为止的摘录，包括还开着的那一段；不改变状态。 */
	excerpt(): string {
		const blocks = [...this.blocks];
		if (this.block && !this.full) {
			const chunk = this.block.join("\n");
			const room = this.budget - this.used - 8;
			if (chunk.length <= room) blocks.push(chunk);
			else if (room > 80) blocks.push(chunk.slice(0, room));
		}
		return blocks.join("\n\n…\n\n");
	}
}

function scan(lines: string[], origin: Origin, budget: number): string {
	const scanner = new ErrorScanner(budget);
	lines.forEach((line, index) => scanner.line(capLine(line, origin.line + index, index === 0 ? origin.column : 0)));
	return scanner.excerpt();
}

/** 头部能放下的整行数：从前往后累加截过的长度，直到超出预算。 */
function fitFromStart(capped: string[], budget: number): number {
	let used = 0;
	let count = 0;
	while (count < capped.length && used + capped[count]!.length + 1 <= budget) used += capped[count++]!.length + 1;
	return count;
}

/** 尾部能放下的整行数，不越过 `floor`（整份都在内存时，头部已经取走的行）。 */
function fitFromEnd(capped: string[], budget: number, floor: number): number {
	let used = 0;
	let count = 0;
	for (let index = capped.length - 1; index >= floor && used + capped[index]!.length + 1 <= budget; index--) {
		used += capped[index]!.length + 1;
		count++;
	}
	return count;
}

function chars(lines: string[]): number {
	return lines.reduce((sum, line) => sum + line.length, 0);
}

function errorBudget(max: number): number {
	return Math.min(24_000, Math.floor(max * 0.45));
}

/** 一段文本按行拆开，连同每行截过的样子。 */
interface Piece {
	lines: string[];
	capped: string[];
	origin: Origin;
}

function piece(text: string, origin: Origin): Piece {
	const lines = text.split("\n");
	return { lines, capped: lines.map((line, index) => capLine(line, origin.line + index, index === 0 ? origin.column : 0)), origin };
}

export class OutputBuffer {
	private readonly origin: Origin;
	/** 未溢出时是全部输出；溢出后是冻结的头部。 */
	private head = "";
	/** 溢出后才有：滚动的尾部与它的起点、被挤出内存的中段。 */
	private tail = "";
	private tailOrigin: Origin | null = null;
	private middleScanner: ErrorScanner | null = null;
	private middlePartial = "";
	private middleLine = 0;
	private total = 0;
	private lineBreaks = 0;
	private endAt: Origin;
	private cache: { max: number; text: string; clipped: boolean } | null = null;

	/** `origin` 是这份输出在完整日志里的起点——`bash_output` 从上次读到的地方接着数行号。 */
	constructor(origin: Origin = { line: 1, column: 0 }) {
		this.origin = origin;
		this.endAt = origin;
	}

	/** 下一个字符在完整日志里的位置。 */
	get end(): Origin {
		return this.endAt;
	}

	/** 收到过多少个字符。 */
	get size(): number {
		return this.total;
	}

	append(chunk: string): void {
		if (!chunk) return;
		this.cache = null;
		this.total += chunk.length;
		this.lineBreaks += newlines(chunk);
		this.endAt = advance(this.endAt, chunk);
		if (!this.tailOrigin) {
			this.head += chunk;
			if (this.head.length <= KEEP) return;
			let split = KEEP / 2;
			if (/[\uD800-\uDBFF]/.test(this.head[split - 1] ?? "")) split -= 1;
			this.tail = this.head.slice(split);
			this.head = this.head.slice(0, split);
			this.tailOrigin = advance(this.origin, this.head);
			this.middleLine = this.tailOrigin.line;
			this.middleScanner = new ErrorScanner(24_000);
		} else {
			this.tail += chunk;
		}
		// 留一点余量再挪，免得每来一小段都切一次字符串。
		if (this.tail.length > (KEEP / 2) * 1.25) this.spill(this.tail.length - KEEP / 2);
	}

	/** 把尾部最前面的 `count` 个字符挪进中段：只留行号和错误行摘录。 */
	private spill(count: number): void {
		if (/[\uD800-\uDBFF]/.test(this.tail[count - 1] ?? "")) count += 1;
		const moved = this.tail.slice(0, count);
		this.tail = this.tail.slice(count);
		this.tailOrigin = advance(this.tailOrigin!, moved);
		const lines = (this.middlePartial + moved).split("\n");
		this.middlePartial = lines.pop() ?? "";
		// 一行没完就一直攒着；太长时只留够判断和展示的头尾。
		if (this.middlePartial.length > MAX_LINE_CHARS * 4) {
			this.middlePartial = `${this.middlePartial.slice(0, MAX_LINE_CHARS * 2)}${this.middlePartial.slice(-MAX_LINE_CHARS * 2)}`;
		}
		for (const line of lines) this.middleScanner!.line(capLine(line, this.middleLine++, 0));
	}

	/** 按 `max` 渲染时是否省略了内容（整段或长行里的一截）。 */
	clipped(max: number): boolean {
		this.render(max);
		return this.cache!.clipped;
	}

	/** 给模型的那一份：对全部累计输出只截一次。 */
	render(max: number): string {
		if (this.cache?.max === max) return this.cache.text;
		const result = this.compute(max);
		this.cache = { max, ...result };
		return result.text;
	}

	private compute(max: number): { text: string; clipped: boolean } {
		const head = piece(this.head, this.origin);
		if (!this.tailOrigin) {
			const whole = head.capped.join("\n");
			if (whole.length <= max) return { text: whole, clipped: whole.length !== this.head.length };
		}
		// 整份都在内存时，头尾取自同一组行，尾部不能越过头部。
		const tail = this.tailOrigin ? piece(this.tail, this.tailOrigin) : head;
		const budget = errorBudget(max);
		const layout = (reserve: number) => {
			const half = Math.floor((max - reserve - MARKER_ROOM) / 2);
			const shownHead = fitFromStart(head.capped, half);
			return { shownHead, shownTail: fitFromEnd(tail.capped, half, this.tailOrigin ? 0 : shownHead) };
		};
		const excerpt = (shown: { shownHead: number; shownTail: number }) => {
			const headOrigin = { line: this.origin.line + shown.shownHead, column: shown.shownHead === 0 ? this.origin.column : 0 };
			if (!this.tailOrigin) return scan(head.lines.slice(shown.shownHead, head.lines.length - shown.shownTail), headOrigin, budget);
			return [
				scan(head.lines.slice(shown.shownHead), headOrigin, budget),
				this.middleScanner!.excerpt(),
				scan(tail.lines.slice(0, tail.lines.length - shown.shownTail), tail.origin, budget),
			]
				.filter(Boolean)
				.join("\n\n…\n\n")
				.slice(0, budget);
		};
		// 先按留出摘录预算的布局找错误行；没有错误就把预算还给头尾（省略的范围只会更小，也不会有错误）。
		let shown = layout(budget);
		const errors = excerpt(shown);
		if (!errors) shown = layout(0);
		/*
		 * 头部取的是开头若干整行，每行后面的换行算已显示——除非取到了这一段的最后一个片段（溢出后头部
		 * 停在行中间）。尾部对称。省略的字符与行号都由此精确算出。
		 */
		const headBreaks = Math.min(shown.shownHead, head.lines.length - 1);
		const tailBreaks = Math.min(shown.shownTail, tail.lines.length - 1);
		const headLines = head.lines.slice(0, shown.shownHead);
		const tailLines = tail.lines.slice(tail.lines.length - shown.shownTail);
		const omitted = this.total - chars(headLines) - headBreaks - chars(tailLines) - tailBreaks;
		const from = this.origin.line + headBreaks;
		const to = this.origin.line + this.lineBreaks - tailBreaks;
		const range = from === to ? `line ${from}` : `lines ${from}-${to}`;
		const marker = errors
			? `\n\n… [${omitted} characters omitted, ${range}; error lines among them:]\n\n${errors}\n\n…\n\n`
			: `\n\n… [${omitted} characters omitted, ${range}] …\n\n`;
		const text = `${head.capped.slice(0, shown.shownHead).join("\n")}${marker}${tail.capped.slice(tail.capped.length - shown.shownTail).join("\n")}`;
		return { text, clipped: true };
	}
}

/** 一次性截一段完整输出。 */
export function clipOutput(text: string, maxTotal: number): string {
	const buffer = new OutputBuffer();
	buffer.append(text);
	return buffer.render(maxTotal);
}
