/**
 * `monitor` 的输出送给模型前怎么收拾：一行在终端里最后的样子、一次送达放得下的最新那些行。
 *
 * 单独一个文件，因为送 monitor 输出的有两处：跑着的时候分批送（`monitor.ts`），命令自己结束时那一次由 bash 送（`bash.ts` 的 `reportEnd`）。
 * 两处都得照这里的上限和清洗来，结束那次不能因为走的是另一条路就把几万字带颜色码的原样输出送进历史。
 */

/**
 * 一次送达最多带多少字；超了留最新的行、只数一下其余的。
 *
 * 送达留在历史里，之后每一轮都重发。4000 字约一千 token，放得下一整个带栈的错误，又小到一个用满行数上限的 monitor 不会让上下文翻倍。
 * 留最新的，因为监视的东西最新的状态才是现在为真的；更早的在磁盘上的完整日志里。
 */
export const DELIVERY_MAX_CHARS = 4_000;
/** 单行截在这里：打成一行的压缩包不能独自占满一次送达。 */
const LINE_MAX_CHARS = 1_000;

// oxlint-disable-next-line no-control-regex -- 要匹配的就是终端转义序列
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// oxlint-disable-next-line no-control-regex -- 转义序列去掉以后剩下的控制字符
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** 一行在终端里最后留下的样子：颜色去掉，用 `\r` 重画的行（进度条、转圈）只留最后一次——不然每次重画都是一行。 */
export function cleanLine(raw: string): string {
	const line = raw
		.slice(raw.lastIndexOf("\r", raw.length - 2) + 1)
		.replace(ESCAPES, "")
		.replace(CONTROLS, "")
		.trimEnd();
	return line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line;
}

/** 一批里放得进一次送达的最新那些行，和更早的放不下的有几行。 */
export function newestLines(lines: string[]): { text: string; lines: number; dropped: number } {
	let size = 0;
	let from = lines.length;
	while (from > 0 && size + lines[from - 1]!.length + 1 <= DELIVERY_MAX_CHARS) size += lines[--from]!.length + 1;
	return { text: lines.slice(from).join("\n"), lines: lines.length, dropped: from };
}
