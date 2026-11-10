/**
 * `toLocaleString(locale, options)`，但把格式器留着。
 *
 * 每次带选项调用都会新建一个 `Intl.DateTimeFormat`——大约 30µs，复用一个只要 7µs。一次不算什么；可侧栏
 * 渲染时几十行每行都要格式化一次提示，对话记录里每条消息的说明也一样，加起来就是一次渲染的大头。
 * 按语言和格式分别留着，两者都只有寥寥几种取值。
 */

const formats = new Map<string, Intl.DateTimeFormat>();

export function formatDate(at: Date | number, locale: string, options: Intl.DateTimeFormatOptions): string {
	const key = `${locale}|${JSON.stringify(options)}`;
	let format = formats.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat(locale, options);
		formats.set(key, format);
	}
	return format.format(at);
}
