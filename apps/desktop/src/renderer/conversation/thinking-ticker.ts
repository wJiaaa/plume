/**
 * 还在写的推理，点开以后框里留哪一段。和组件分开，好按「进去一段字、出来一截尾巴」单独测。
 */

/** 还在写的推理，框里最多留这么多字。 */
const LIVE_TAIL = 16_000;

/** 尾巴的起点一次挪这么多。 */
const TAIL_STEP = 4_000;

/**
 * 还在写的推理的尾巴，以及它前面还有多少字。
 *
 * 只留尾巴：整段摊开的话每来一个 token 都要把整段重排一遍，几分钟的推理能把窗口拖到每秒几帧。写完以后换回全文。
 *
 * 起点按步挪，不跟着每个 token 走：框顶和上面那个字数几千字才变一次，不是每帧都变。附近有换行就挪到换行后面，
 * 框不会从半个词开始。人往上翻着的时候起点由 `ThinkingBody` 按住。
 */
export function thinkingTail(text: string, limit = LIVE_TAIL): { tail: string; hidden: number } {
	if (text.length <= limit) return { tail: text, hidden: 0 };
	let start = Math.ceil((text.length - limit) / TAIL_STEP) * TAIL_STEP;
	const lineEnd = text.indexOf("\n", start);
	if (lineEnd !== -1 && lineEnd - start < 200) start = lineEnd + 1;
	return { tail: text.slice(start), hidden: start };
}
