/**
 * 把系统 emoji 从别处写来的文字里拿掉。
 *
 * 界面上画的都是同一粗细的线性图标、几种墨色之一。一个彩色 emoji 落在中间就像一张小照片：它由系统用另一种
 * 字体画，粗细不同，颜色不来自任何配色，在 macOS 上还是亮面的。回复里一个 `🤖` 就是屏幕上最吵的东西，而且
 * 是无意中吵的。
 *
 * 所以画出来时拿掉。只处理别处写来的文字（模型的回复）里的普通文字，界面自己从不写 emoji。
 *
 * `Extended_Pictographic` 这个属性的意思就是「画成一张图」，正是这里要问的。它有意不匹配界面特意用的排版
 * 符号——`→`、`✓`、`✕`、`↵` 是正文字体里的箭头和记号，不是图，它们留着。
 *
 * 整串一起匹配。一个 emoji 可以是基字加肤色、加变体选择符，再由零宽连接符连上更多同类——`👨‍👩‍👧‍👦` 是
 * 七个码点。一个一个拿掉会把连接符剩下，而落单的 ZWJ 是个看不见的字符，会让周围的文字没法搜索。
 */

const EMOJI_WITH_TRAILING_SPACE =
	/(\p{Extended_Pictographic}|\p{Regional_Indicator})(\p{Emoji_Modifier}|️|︎|\p{Regional_Indicator})*(‍(\p{Extended_Pictographic}|\p{Regional_Indicator})(\p{Emoji_Modifier}|️|︎)*)*[^\S\n]*/gu;

/**
 * 拿掉图形字符之后的同一段文字。
 *
 * 在 Markdown 解析之后、只对普通文字跑（`Markdown.tsx` 画 `text` 那一种时）：行内代码、链接地址、围栏里的原文
 * 都是原样的数据，不清理。换行原样保留。
 */
export function stripEmoji(text: string): string {
	if (!text) return text;

	return (
		text
			/*
			 * 图带着它后面的空格一起走。
			 *
			 * `🤖 Generated with…` 应该变成 `Generated with…`，而不是 ` Generated with…`。
			 */
			.replace(EMOJI_WITH_TRAILING_SPACE, "")
			/*
			 * emoji 原来在行尾时剩下的空白。只收换行前的：这段字的末尾后面可能紧跟着行内代码或链接，
			 * 收掉那里的空格会把两边粘在一起。
			 */
			.replace(/[^\S\n]+(?=\n)/g, "")
	);
}
