/**
 * 工具卡片里只会出现两种代码：一条 shell 命令，一段 JSON 参数。各配一个小扫描器上色。
 *
 * 不用回复里代码块的那套语法：那是按需加载的 CodeMirror 语法，shell 还是 legacy 模式，展开一张卡片就要等一次异步加载，
 * 而一条二十个字的命令一个同步的小扫描器就能准确地切开。
 *
 * 分类故意少。一条命令值得读的只有四样：跑的是什么、传了什么、哪些是字面量、一条命令在哪里结束下一条从哪里开始。
 * 再多就是装饰，诊断界面里的装饰是噪音。颜色取代码块用的 `--plume-syntax-*`，同一条命令在这里和在回复里读起来一样。
 */

export type TokenKind =
	/** 跑的程序和它的子命令。 */
	| "command"
	/** `-f`、`--force=x`。 */
	| "flag"
	| "string"
	| "number"
	/** `&&`、`|`、`;`、`>`，以及 JSON 的括号和冒号。 */
	| "operator"
	/** `$HOME`、`${x}`。 */
	| "variable"
	/** JSON 的键。 */
	| "key"
	| "comment"
	| "plain";

export interface Token {
	text: string;
	kind: TokenKind;
}

/** 每种一个类，定义在 `detail.css`。 */
export const TOKEN_CLASS: Record<TokenKind, string> = {
	command: "tool-tok-command",
	flag: "tool-tok-flag",
	string: "tool-tok-string",
	number: "tool-tok-number",
	operator: "tool-tok-operator",
	variable: "tool-tok-variable",
	key: "tool-tok-key",
	comment: "tool-tok-comment",
	plain: "",
};

/**
 * 一条命令在哪里结束、下一条从哪里开始。下面的正则里引号写成 `\x27`、`\x22`：字面的引号在正则里落单，文案检查会把它
 * 当成一个没关上的字符串，后面的注释全被算成界面文案。
 */
const SHELL_OPERATOR = /^(\|\||&&|;|\||>>|>|<|&)/;

/**
 * 扫一行命令。
 *
 * 唯一的状态是下一个裸词是不是程序名：开头和每个运算符之后是，读过一个东西之后不是。就这一条，`cd x && npm run build`
 * 才只给 `cd` 和 `npm` 上色。
 */
export function tokenizeShell(input: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;
	let expectCommand = true;
	const push = (text: string, kind: TokenKind) => {
		if (text) tokens.push({ text, kind });
	};

	while (at < input.length) {
		const rest = input.slice(at);

		const space = /^\s+/.exec(rest);
		if (space) {
			push(space[0], "plain");
			at += space[0].length;
			continue;
		}

		if (rest.startsWith("#") && (at === 0 || /\s/.test(input[at - 1] ?? ""))) {
			const end = rest.indexOf("\n");
			const text = end < 0 ? rest : rest.slice(0, end);
			push(text, "comment");
			at += text.length;
			continue;
		}

		const operator = SHELL_OPERATOR.exec(rest);
		if (operator) {
			push(operator[0], "operator");
			at += operator[0].length;
			expectCommand = true;
			continue;
		}

		const quoted = /^\x27[^\x27]*\x27?|^\x22(?:[^\x22\\]|\\.)*\x22?/.exec(rest);
		if (quoted) {
			push(quoted[0], "string");
			at += quoted[0].length;
			expectCommand = false;
			continue;
		}

		const variable = /^\$\{[^}]*\}|^\$[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
		if (variable) {
			push(variable[0], "variable");
			at += variable[0].length;
			expectCommand = false;
			continue;
		}

		const word = /^[^\s\x27\x22|&;<>#]+/.exec(rest);
		if (!word) {
			push(rest[0] ?? "", "plain");
			at += 1;
			continue;
		}

		if (word[0].startsWith("-")) push(word[0], "flag");
		else if (expectCommand) {
			push(word[0], "command");
			expectCommand = false;
		} else if (/^-?\d+(\.\d+)?$/.test(word[0])) push(word[0], "number");
		else push(word[0], "plain");
		at += word[0].length;
	}

	return tokens;
}

/**
 * 扫 JSON。键是后面跟着冒号的字符串，这是唯一值得往前看一眼的东西，也正是让一个参数对象一眼读得清的那个区别。
 */
export function tokenizeJson(input: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;

	while (at < input.length) {
		const rest = input.slice(at);

		const space = /^\s+/.exec(rest);
		if (space) {
			tokens.push({ text: space[0], kind: "plain" });
			at += space[0].length;
			continue;
		}

		const string = /^\x22(?:[^\x22\\]|\\.)*\x22?/.exec(rest);
		if (string) {
			const after = rest.slice(string[0].length);
			tokens.push({ text: string[0], kind: /^\s*:/.test(after) ? "key" : "string" });
			at += string[0].length;
			continue;
		}

		const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
		if (number) {
			tokens.push({ text: number[0], kind: "number" });
			at += number[0].length;
			continue;
		}

		const literal = /^(true|false|null)\b/.exec(rest);
		if (literal) {
			tokens.push({ text: literal[0], kind: "number" });
			at += literal[0].length;
			continue;
		}

		const char = rest[0] ?? "";
		tokens.push({ text: char, kind: "{}[],:".includes(char) ? "operator" : "plain" });
		at += 1;
	}

	return tokens;
}
