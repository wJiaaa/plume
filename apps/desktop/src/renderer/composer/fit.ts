/**
 * 输入框底下那一排放不下时让出什么：量出来，不按宽度猜。
 *
 * 这一排装的东西不总放得下：权限、计划模式、上下文用量、模型、思考档位、发送。放不下时总得让出点什么，问题是怎么知道放不下了。
 * 按输入框的宽度定（宽度低于多少就藏掉什么）答不了这个问题：放不放得下取决于模型名有多长，从 `gpt-5` 到
 * `claude-opus-4-6-thinking` 都有；一个固定的断点也看不见自己让出来的宽度有没有人用。
 *
 * 所以按固定的顺序一步一步让，第一步放得下就停。「放得下」见下面的 `tight`。
 */

/**
 * 能让出的东西，按让出的顺序。高的一级包括低的。
 *
 * 顺序是这一排「是干什么的」的排名。上下文用量和模型名回答的是关于这一问的事——还剩多少地方、谁来答——每一轮都可能变。
 * 「完全访问」是设一次就一直放着的模式，图标是红的、悬停提示照样说那几个字，所以它旁边的字是这一排最便宜的东西，最先让。
 */
export const FIT_LEVELS = {
	/** 全画出来。 */
	all: 0,
	/** 权限签、模式开关只留图标，字收起来。 */
	noAccessLabel: 1,
	/** 上下文用量也让出去：它是看一眼的读数，名字认不出来更要紧。 */
	noMeter: 2,
} as const;

export const MAX_FIT_LEVEL = FIT_LEVELS.noMeter;

/** 会让位的那一个元素的抓手：`ComposerShell` 在这一排里找它。 */
export const FIT_PROBE = "plume-fit-probe";

/**
 * 模型名窄到多少时这一排才开始让别的东西。
 *
 * 不是「截断时」。名字截断很平常、几乎不要钱——末尾是省略号，悬停提示里有全名——把截掉第一个像素当成急事，是花真东西去换不要钱的东西：
 * 一个 424px 的输入框全画出来时 `claude-opus-4-6-thinking` 被截掉 4px，为此收起「完全访问」的字，还回来的是 58px 的空白。
 *
 * 88px 大约放得下十来个字符（`claude-opus-4…`、`gemini-3.7-f…`），一眼认得出是哪个模型。再窄名字就认不出了，地方不如给旁边的记号。
 */
export const MIN_NAME_WIDTH = 88;

/**
 * 从那个会让位的元素上读：这一排是不是放不下了。
 *
 * 这一排里除了模型名都不收缩，模型名会截断——所以缺地方都表现在名字上，这也是唯一不必知道这一排还有什么的读法。
 *
 * 两半都要：只看截断，差 4px 就触发；只看窄，`gpt-5` 的名字只有 40px 宽（它只要这么宽）也会触发。合起来才是本来的意思：
 * 名字被截了，而且截到认不出。留一个像素的余量给小数像素的排版——正好放得下的名字可能量出 171.3 对 171，在两种状态之间来回闪比哪一种都糟。
 */
export function tight(probe: { scrollWidth: number; clientWidth: number } | null | undefined): boolean {
	if (!probe) return false;
	const truncated = probe.scrollWidth > probe.clientWidth + 1;
	return truncated && probe.clientWidth < MIN_NAME_WIDTH;
}

/** 下一级，没得再让时是 `null`：最光秃的一排也放不下那个名字时停在 `MAX_FIT_LEVEL`，不一直数下去。 */
export function nextLevel(level: number, isTight: boolean): number | null {
	if (!isTight) return null;
	if (level >= MAX_FIT_LEVEL) return null;
	return level + 1;
}

/**
 * 从「全画出来」往上走，停在第一个放得下的级别。
 *
 * `measureAt` 拿到一个级别，把这一排摆成那样，答还是不是放不下：调用方读真实的 DOM，测试是一张表。
 * 总是从 `all` 开始，不从上次停的地方调：级别是在某个宽度下做的决定，宽度一变就作废——让出上下文用量腾出的地方，只有重新走一遍才还得回去。
 */
export function settle(measureAt: (level: number) => boolean): number {
	let level: number = FIT_LEVELS.all;
	for (;;) {
		const step = nextLevel(level, measureAt(level));
		if (step === null) return level;
		level = step;
	}
}
