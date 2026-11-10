/**
 * `.gitignore` 以及所有长得像它的文件（`.dockerignore`、`.npmignore`……）的语法。
 *
 * 语法很小，每一部分都值得看清：
 *
 *     # 注释              这条规则为什么存在
 *     !not-this-one       取反，任何 ignore 文件里最容易读错的一行
 *     build/              结尾的斜杠表示只管目录
 *     *.log  src/**\/*.ts  通配，决定一条规则实际网住多少
 *
 * 取反不显眼，就是不该提交的文件被提交上去的原因。按行的格式，所以是 `StreamLanguage`；记号用标准的高亮标签命名，
 * 跟其他语言一起按应用的配色上色。
 */

import { StreamLanguage, type StreamParser } from "@codemirror/language";

interface IgnoreState {
	/** 这一行是不是以 `!` 开头：整行的意思都反过来。 */
	negated: boolean;
}

const parser: StreamParser<IgnoreState> = {
	name: "gitignore",
	startState: () => ({ negated: false }),

	token(stream, state) {
		if (stream.sol()) state.negated = false;

		if (stream.eatSpace()) return null;

		// `#` 只有在行首才是注释。
		if (stream.sol() || stream.column() === 0) {
			if (stream.peek() === "#") {
				stream.skipToEnd();
				return "comment";
			}
			if (stream.eat("!")) {
				state.negated = true;
				// 单独一个标签：「这条是例外」正是要找的东西。
				return "keyword";
			}
		}

		// 通配：决定一条规则网住什么。
		if (stream.peek() === "*" || stream.peek() === "?") {
			while (stream.eat("*") || stream.eat("?")) {
				// `**` 和 `*` 各是一个记号，一起吃掉让这一段连着。
			}
			return "operator";
		}

		// 字符类 `[Dd]ebug` 是一个整体。
		if (stream.eat("[")) {
			stream.eatWhile((char: string) => char !== "]");
			stream.eat("]");
			return "operator";
		}

		// 分隔符，在行尾表示「只管目录」。
		if (stream.eat("/")) return "punctuation";

		// 其余都是字面的路径段。
		stream.eatWhile((char: string) => !"*?[/# \t".includes(char));
		if (stream.current().length === 0) {
			// 什么都没吃到，往前走一个字，免得原地打转。
			stream.next();
			return null;
		}
		return state.negated ? "string" : "variableName";
	},

	languageData: {
		commentTokens: { line: "#" },
	},
};

export const ignoreLanguage = StreamLanguage.define(parser);
