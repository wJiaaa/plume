/**
 * 一个字符串一个字一个字地改写成另一个。
 *
 * 一段对话在运行时读完第一条消息之前，标题是「新对话」，之后真标题才落下来。一帧之内直接替换，是侧栏里
 * 唯一一处「行变了，却和你刚做的事无关」的时刻；硬切的话读起来像列表在指针底下自己重排了一次。改写一遍
 * 传达的是同一件事，只是成了一个看得见过程的事件。
 *
 * 共同前缀保留不删，于是「查一下依赖」→「查一下依赖为什么装不上」不会先退回到空，而是只打出尾巴。
 * 这种情况很常见：存下的标题是从提示词里取的，它和替换它的那个往往开头一样。
 *
 * 按码点而不是 UTF-16 单元：`[...text]` 让 emoji 和其他星际字符保持完整，`slice` 会把代理对切成两半，
 * 有一帧画出替换字形。
 */

/**
 * 改写最多走几步。
 *
 * 一个 60 字的标题一个字形一个字形地删了再打，要一百多帧——侧栏一行翻腾三秒，那已经不是反馈，而是一段
 * 让人盯着看的动画。超过这么多步，每帧就多挪几个字，长标题和短标题用时差不多，都在一秒以内。
 */
const MAX_FRAMES = 26;

/**
 * `from` 到 `to` 之间的每个中间字符串，按顺序，最后一个是 `to`。
 *
 * 没什么可演的时候是空的——两个字符串相同，或者原来没有值、第一个值刚到——调用方读作「不演，直接画」。
 */
export function typingFrames(from: string, to: string, maxFrames: number = MAX_FRAMES): string[] {
	if (from === to) return [];

	const before = [...from];
	const after = [...to];

	let shared = 0;
	while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared += 1;

	const deletions = before.length - shared;
	const additions = after.length - shared;
	// 向上取整，步长至少是一，下面的循环一定会结束。
	const step = Math.max(1, Math.ceil((deletions + additions) / maxFrames));

	const frames: string[] = [];
	for (let length = before.length - step; length > shared; length -= step) frames.push(before.slice(0, length).join(""));
	if (deletions > 0) frames.push(before.slice(0, shared).join(""));
	for (let length = shared + step; length < after.length; length += step) frames.push(after.slice(0, length).join(""));
	frames.push(to);

	// 删到共同前缀时可能正好落在目标上——把一个标题删成开头相同的更短的那个。重复的一帧是什么都没发生的一帧。
	return frames.filter((frame, index) => index === 0 || frame !== frames[index - 1]);
}
