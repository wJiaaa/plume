/**
 * 在每个平台上都画得出中文的等宽字体栈。
 *
 * 等宽字体没有汉字，所以编辑器里的中文注释、终端里的中文行，是由排在它们后面的字体画的——字体栈一走到
 * 通用的 `monospace`，Windows 上的 Chromium 就拿新宋体来答汉字，代码中间冒出一段细线衬线体。默认字体栈
 * 正是为此把雅黑排在 `monospace` 前面（见 theme.css 的 `--plume-font-mono`）；可要是一个字体预设只写了
 * 苹方，Windows 上没有它，选了 Consolas、JetBrains Mono 之类，编辑器和终端里的中文就又落回宋体一族。
 *
 * 所以不管存下来的是哪个字体栈——预设、默认、手写的——缺了默认栈里的那几个中文字体，就补到 `monospace`
 * 前面。已经自己选了中文字体的栈，它的排在这些前面；它列出的任何一项都不挪。
 */

/** 默认栈里的中文字体，按它的顺序：Windows、macOS、Linux。 */
const HAN_FACES = ['"Microsoft YaHei UI"', '"Microsoft YaHei"', '"PingFang SC"', '"Noto Sans CJK SC"'];

const family = (entry: string) =>
	entry
		.trim()
		.replace(/^["']|["']$/g, "")
		.toLowerCase();

export function withHanFallback(stack: string): string {
	const entries = stack
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const present = new Set(entries.map(family));
	const missing = HAN_FACES.filter((face) => !present.has(family(face)));
	if (missing.length === 0) return stack;
	// 排在通用字体族前面，不然它会先答。
	const generic = entries.findIndex((entry) => family(entry) === "monospace");
	const at = generic === -1 ? entries.length : generic;
	return [...entries.slice(0, at), ...missing, ...entries.slice(at)].join(", ");
}
