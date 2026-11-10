/**
 * `.env` 的语法。properties 语法把 `KEY=value` 两半都标成定义，名字和值一个颜色，中间的 `=` 没颜色——而这正是
 * 最需要把两者分开的文件：打开它就是为了看哪个变量设成了什么。
 *
 * 值得看清的几样：
 *
 *     # 注释               通常写着值从哪来
 *     KEY                  名字，要找的就是它
 *     =                    分隔，值里带 `=` 也不会读错
 *     "带引号的值"          引号有意义：保住空格和 `#`
 *     ${OTHER}             插值，好几种加载器支持，不是字面量
 *
 * 按行的格式，不需要树，所以是 `StreamLanguage`。
 */

import { StreamLanguage, type StreamParser } from "@codemirror/language";

interface State {
	/** 一行第一个 `=` 之后都是值，不管后面还有几个 `=`。 */
	inValue: boolean;
}

const parser: StreamParser<State> = {
	name: "dotenv",
	startState: () => ({ inValue: false }),

	token(stream, state) {
		if (stream.sol()) state.inValue = false;
		if (stream.eatSpace()) return null;

		// 注释只在行首，或值里空格之后——`PASSWORD=a#b` 是带井号的密码，不是注释。
		if (!state.inValue && stream.peek() === "#") {
			stream.skipToEnd();
			return "comment";
		}

		if (!state.inValue) {
			// 给 source 用的文件里 `export FOO=bar` 很常见。
			if (stream.match(/^export\b/)) return "keyword";
			if (stream.match(/^[A-Za-z_][\w.]*/)) return "propertyName";
			if (stream.peek() === "=") {
				stream.next();
				state.inValue = true;
				return "operator";
			}
			stream.next();
			return null;
		}

		// 插值是引用不是文字，值得单独看出来。
		if (stream.match(/^\$\{[^}]*\}/) || stream.match(/^\$[A-Za-z_]\w*/)) return "variableName";

		const quote = stream.peek();
		if (quote === '"' || quote === "'") {
			stream.next();
			let escaped = false;
			while (!stream.eol()) {
				const ch = stream.next();
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === "\\") escaped = true;
				else if (ch === quote) break;
			}
			return "string";
		}

		/*
		 * 不带引号的值一直到注释或行尾。
		 *
		 * 「空格加井号」才是行尾注释的开头，各家加载器都这么认；没有空格的 `#` 属于值，URL 的片段、颜色值靠这个保住。
		 */
		while (!stream.eol()) {
			if (stream.peek() === "$") break;
			const next = stream.next();
			if (next === " " && stream.peek() === "#") {
				stream.backUp(1);
				break;
			}
		}
		return "string";
	},
};

export const dotenvLanguage = StreamLanguage.define(parser);
