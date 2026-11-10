/**
 * GraphQL 的语法。
 *
 * 当 JavaScript 解析的话大括号和字段名看着还行，错在最要紧的一处：GraphQL 的注释以 `#` 开头，查询里的每条注释
 * 都成了正文，而注释往往是唯一说明这条查询干什么的一行。
 *
 * 就上色而言整个语言很小：注释、字符串、数字、关键字、`$变量`、`@指令`、类型（按惯例大写开头）和字段名。按行
 * 过一遍就够，所以是 `StreamLanguage`。
 */

import { StreamLanguage, type StreamParser } from "@codemirror/language";

/**
 * 开启或命名一个定义的词。
 *
 * `on` 也在里面：它让片段读得通（`... on User`），读成字段名是唯一会改变查询看起来在干什么的错误。
 */
const KEYWORDS = new Set([
	"query",
	"mutation",
	"subscription",
	"fragment",
	"on",
	"type",
	"input",
	"enum",
	"interface",
	"union",
	"scalar",
	"schema",
	"directive",
	"extend",
	"implements",
	"repeatable",
	"true",
	"false",
	"null",
]);

interface State {
	/** 在跨行的 `"""块字符串"""` 里面。 */
	block: boolean;
}

const parser: StreamParser<State> = {
	name: "graphql",
	startState: () => ({ block: false }),

	token(stream, state) {
		if (state.block) {
			// 一直吃到三引号收口；这一行没有就吃到行尾。
			while (!stream.eol()) {
				if (stream.match('"""')) {
					state.block = false;
					return "string";
				}
				stream.next();
			}
			return "string";
		}

		if (stream.eatSpace()) return null;

		if (stream.peek() === "#") {
			stream.skipToEnd();
			return "comment";
		}

		if (stream.match('"""')) {
			state.block = true;
			return "string";
		}

		if (stream.peek() === '"') {
			stream.next();
			let escaped = false;
			while (!stream.eol()) {
				const ch = stream.next();
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === "\\") escaped = true;
				else if (ch === '"') break;
			}
			return "string";
		}

		// `$id`：变量，真正传进来的东西。
		if (stream.match(/^\$[A-Za-z_][\w]*/)) return "variableName";
		// `@include`：指令。
		if (stream.match(/^@[A-Za-z_][\w]*/)) return "meta";
		if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return "number";
		// `...` 展开一个片段；不单独认的话读成三个点。
		if (stream.match("...")) return "punctuation";

		// 正则的 `match` 返回数组、字符串的返回 `true`，这里收窄后才拿得到匹配的字。
		const word = stream.match(/^[A-Za-z_][\w]*/);
		if (word && word !== true) {
			const text = word[0];
			if (KEYWORDS.has(text)) return "keyword";
			// 大写开头就是类型：规范里没有这条，但整个生态都这么写，`... on User` 的 `User` 因此读成类型而不是字段。
			return /^[A-Z]/.test(text) ? "typeName" : "propertyName";
		}

		if (stream.match(/^[[\]{}()!:=|&,]/)) return "punctuation";
		stream.next();
		return null;
	},
};

export const graphqlLanguage = StreamLanguage.define(parser);
