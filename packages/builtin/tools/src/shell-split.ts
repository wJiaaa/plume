/**
 * 把一行 bash 命令拆开，给只读判断一条一条地看。
 *
 * `&&`、`||`、`;`、`|` 和换行各起一条新命令；`$( )`、反引号、`<( )` 一层套一层。这里不判断任何东西，
 * 只负责拆：一串命令的危险程度等于其中最危险的那一条，判断的人得能一条一条看。
 *
 * 扫描器在「一条命令到哪结束」上必须和 bash 一致，每一处不一致都是绕过判断的路。下面每一条都曾被判成
 * 无害，而 bash 实际跑了 `rm -rf ~`：
 *
 *   echo \"; rm -rf ~                  —— 没认反斜杠，`"` 被当成开了引号
 *   echo $'it\'s'; rm -rf ~            —— ANSI-C 引号里 `\'` 不结束字符串
 *   # it's fine⏎rm -rf ~               —— 注释里的撇号开了引号
 *   cat <<EOF⏎it's done⏎EOF⏎rm -rf ~   —— 同上，出现在 heredoc 正文里
 *
 * 所以这里的规矩是：可能和 bash 读法不同的地方，照 bash 读；读不准的地方，宁可多看，不能跳过 bash 会执行的文字。
 * 只读判断（`literalWords`、`sequence`）只按 bash（zsh 同）的语法读；判读了哪些文件的 `splitCommands`、`splitWords`
 * 还能按 PowerShell 读，见 `Dialect`。
 */

/**
 * 按哪种语法读这一行。
 *
 * `posix` 是 bash 和 zsh：几乎所有地方 agent 的 shell 都是它，Windows 上的 Git Bash 也是。`powershell` 是 Windows 上
 * 受约束的命令跑的 shell（没装 Git 时什么命令都在它里面跑），而它在这里最要紧的那个字符上和 bash 不一致：`\` 是路径
 * 分隔符，不是转义，转义是反引号。按 bash 的规矩读，`cat C:\Users\me\.ssh\id_rsa` 丢了反斜杠，读权限的判断就看不到
 * PowerShell 要打开的那个路径。
 */
export type Dialect = "posix" | "powershell";

/** 扫描器栈上的一帧：当前在什么里面。 */
type Frame =
	/** `'…'`：什么都不特殊。 */
	| { kind: "'" }
	/** `$'…'`：ANSI-C 引号，反斜杠转义，包括 `\'`。 */
	| { kind: "$'" }
	/** `"…"`：反斜杠转义，替换照样是替换。 */
	| { kind: '"' }
	/** `$( … )`：命令替换；`parens` 数里面的 `(`，让 `)` 配得上对。 */
	| { kind: "$("; parens: number }
	/** `` `…` ``：命令替换的旧写法。 */
	| { kind: "`" }
	/** `<( … )` 或 `>( … )`：进程替换，一样会跑命令。 */
	| { kind: "<("; parens: number }
	/** `( … )`：子 shell。里面的命令就是这一行的命令，这一帧只用来配 `)`。 */
	| { kind: "(" }
	/**
	 * `$(( … ))` 或 `(( … ))`：算术，里面的 `;`、`<<` 和命令无关。
	 * `expansion` 是带 `$` 的那种，嵌在一个词里；不带 `$` 的自己就是一条命令。
	 */
	| { kind: "(("; parens: number; expansion: boolean }
	/** heredoc 正文。分隔符带了引号时 `expands` 为 false，正文就是纯数据。 */
	| { kind: "heredoc"; delimiter: string; stripTabs: boolean; expands: boolean };

type HeredocFrame = Extract<Frame, { kind: "heredoc" }>;

/**
 * 一段文字是被什么结束的，好把命令重新拼起来。
 *
 * `sub` 是一段中间开了一个替换；`close` 是一个替换结束，也结束了在它里面跑的那条命令。
 */
type Separator = ";" | "|" | "&" | "&&" | "||" | "\n" | "sub" | "close" | "end";

interface Piece {
	text: string;
	after: Separator;
	/** 文字在几层替换（或 heredoc 正文）里面，0 是这一行本身。 */
	depth: number;
	/** 文字是 heredoc 正文：数据，不是命令。 */
	body: boolean;
}

/** 会开出新一层命令的帧；引号、子 shell、算术不算。 */
const NESTING = new Set<Frame["kind"]>(["$(", "`", "<(", "heredoc"]);

/** heredoc 分隔符在哪结束。 */
const DELIMITER_END = /[\s;&|<>()]/;

/**
 * 把命令行拆成一段段文字和它们之间的分隔符。
 *
 * 替换（`$(…)`、一对反引号、`<(…)`）会结束它打断的那一段，里面的内容深一层、自成几段。这样摊平是有意的：
 * 替换先于包着它的命令执行，就「这一行跑了什么」而言它是兄弟而不是孩子。`depth` 留着，给需要外层命令
 * 完整原貌的地方拼回去。
 */
function scan(command: string, dialect: Dialect = "posix"): Piece[] {
	const posix = dialect === "posix";
	/** 把下一个字符拿出语法的那个字符：bash 里是反斜杠，PowerShell 里是反引号。 */
	const escape = posix ? "\\" : "`";
	const pieces: Piece[] = [];
	const stack: Frame[] = [];
	const heredocs: HeredocFrame[] = [];
	let current = "";
	/** 下一个字符是否在一个词的开头：只有这里的 `#` 才开始注释。 */
	let wordStart = true;
	/** 扫描器正站在 heredoc 正文某一行的第一个字符上。 */
	let lineStart = false;
	let i = 0;

	const top = (): Frame | undefined => stack[stack.length - 1];
	const depth = (): number => stack.reduce((n, frame) => (NESTING.has(frame.kind) ? n + 1 : n), 0);
	const flush = (after: Separator) => {
		pieces.push({ text: current, after, depth: depth(), body: top()?.kind === "heredoc" });
		current = "";
	};
	/** 开一个替换：之前的文字属于外层。 */
	const open = (frame: Frame) => {
		flush("sub");
		stack.push(frame);
		wordStart = true;
	};
	/** 关一个替换：之前的文字属于里层，并在这里结束。 */
	const close = () => {
		flush("close");
		stack.pop();
		// `$(date)#x` 是一个词，里面的 `#` 不是注释。
		wordStart = false;
	};
	/** 分隔符结束一条命令，下一个字符是一个词的开头。 */
	const separate = (after: Separator, width: number) => {
		flush(after);
		i += width;
		wordStart = true;
	};
	/** bash 从操作符的下一行读 heredoc 正文，不管它嵌在什么里面。 */
	const startHeredoc = () => {
		const next = heredocs.shift();
		if (!next) return;
		stack.push(next);
		lineStart = true;
	};

	while (i < command.length) {
		const char = command[i]!;
		const next = command[i + 1];
		const frame = top();

		if (frame?.kind === "heredoc") {
			if (lineStart) {
				const end = command.indexOf("\n", i);
				const lineEnd = end === -1 ? command.length : end;
				const line = command.slice(i, lineEnd);
				if ((frame.stripTabs ? line.replace(/^\t+/, "") : line) === frame.delimiter) {
					flush("close");
					stack.pop();
					i = lineEnd + 1;
					lineStart = false;
					wordStart = true;
					startHeredoc();
					continue;
				}
				lineStart = false;
				// 分隔符带引号时整个正文都是数据：整行跳过。
				if (!frame.expands) {
					i = lineEnd + 1;
					lineStart = true;
					continue;
				}
			}
			// 不带引号的正文按双引号字符串展开，只是 `"` 不特殊：里面的替换会跑，别的都不是命令。
			if (char === "\\") {
				i += 2;
				continue;
			}
			if (char === "$" && next === "(" && command[i + 2] === "(") {
				stack.push({ kind: "((", parens: 0, expansion: true });
				i += 3;
				continue;
			}
			if (char === "$" && next === "(") {
				open({ kind: "$(", parens: 0 });
				i += 2;
				continue;
			}
			if (char === "`") {
				open({ kind: "`" });
				i++;
				continue;
			}
			if (char === "\n") lineStart = true;
			i++;
			continue;
		}

		// 单引号里什么都不特殊。
		if (frame?.kind === "'") {
			if (char === "'") stack.pop();
			current += char;
			i++;
			continue;
		}

		// ANSI-C 引号：`$'it\'s'` 是一个字符串，其中的 `\'` 不结束它。
		if (frame?.kind === "$'") {
			if (char === "\\") {
				current += char + (next ?? "");
				i += 2;
				continue;
			}
			if (char === "'") stack.pop();
			current += char;
			i++;
			continue;
		}

		/*
		 * 双引号里只有替换特殊，而且真的会跑：`echo "$(rm -rf ~)"` 里的命令必须被拆出来看，
		 * 不能因为整段在引号里就当成 `echo` 的一个参数。
		 *
		 * 反斜杠转义下一个字符：`"say \"hi\""` 是一个字符串，`\$(` 是美元符和括号，不是命令。
		 */
		if (frame?.kind === '"') {
			if (char === escape) {
				current += char + (next ?? "");
				i += 2;
				continue;
			}
			if (char === '"') {
				stack.pop();
				current += char;
				i++;
				continue;
			}
			if (posix && char === "$" && next === "(" && command[i + 2] === "(") {
				stack.push({ kind: "((", parens: 0, expansion: true });
				current += "$((";
				i += 3;
				continue;
			}
			if (char === "$" && next === "(") {
				open({ kind: "$(", parens: 0 });
				i += 2;
				continue;
			}
			if (posix && char === "`") {
				open({ kind: "`" });
				i++;
				continue;
			}
			current += char;
			i++;
			continue;
		}

		/*
		 * 算术。`for ((i = 0; i < 3; i++))` 有两个分号却不跑命令；`(( x <<= 1 ))` 里的 `<<` 不开 heredoc，
		 * 当成 heredoc 会吞掉后面所有行去找一个叫 `=` 的分隔符。
		 */
		if (frame?.kind === "((") {
			if (char === "\\") {
				current += char + (next ?? "");
				i += 2;
				continue;
			}
			if (char === "(") frame.parens++;
			if (char === ")") {
				if (frame.parens > 0) frame.parens--;
				else if (next === ")") {
					stack.pop();
					current += "))";
					i += 2;
					// `$((1))#x` 是一个词；裸的 `(( ))` 之后是新词。
					wordStart = !frame.expansion;
					continue;
				}
			}
			if (char === "$" && next === "(" && command[i + 2] !== "(") {
				open({ kind: "$(", parens: 0 });
				i += 2;
				continue;
			}
			if (char === "`") {
				open({ kind: "`" });
				i++;
				continue;
			}
			current += char;
			i++;
			continue;
		}

		// 代码：顶层、替换里面或子 shell 里面。

		/*
		 * 反斜杠把下一个字符拿出语法：`\;` 是参数，`\"` 是引号字符而不是引号。反斜杠加换行会连同换行一起去掉，
		 * 把两行接成一行（长的 `docker run \` 都这么写），中间什么都不留，和 bash 一样：`r\⏎m` 就是 `rm`。
		 */
		if (char === escape) {
			if (next !== "\n") {
				current += char + (next ?? "");
				wordStart = false;
			}
			i += 2;
			continue;
		}

		/*
		 * 注释到行尾，里面的东西都不是代码。
		 *
		 * `#` 只在词首开始注释：`a#b` 是一个词，`${#x}` 是取长度。换行留给下面的分隔符处理。
		 */
		if (char === "#" && wordStart) {
			const end = command.indexOf("\n", i);
			i = end === -1 ? command.length : end;
			continue;
		}

		if (char === "'") {
			stack.push({ kind: "'" });
			current += char;
			i++;
			wordStart = false;
			continue;
		}
		if (posix && char === "$" && next === "'") {
			stack.push({ kind: "$'" });
			current += "$'";
			i += 2;
			wordStart = false;
			continue;
		}
		if (char === '"') {
			stack.push({ kind: '"' });
			current += char;
			i++;
			wordStart = false;
			continue;
		}
		if (posix && char === "$" && next === "(" && command[i + 2] === "(") {
			stack.push({ kind: "((", parens: 0, expansion: true });
			current += "$((";
			i += 3;
			continue;
		}
		if (posix && char === "(" && next === "(" && wordStart) {
			stack.push({ kind: "((", parens: 0, expansion: false });
			current += "((";
			i += 2;
			continue;
		}
		if (char === "$" && next === "(") {
			open({ kind: "$(", parens: 0 });
			i += 2;
			continue;
		}
		if (posix && (char === "<" || char === ">") && next === "(") {
			open({ kind: "<(", parens: 0 });
			i += 2;
			continue;
		}
		if (posix && char === "`") {
			if (frame?.kind === "`") close();
			else open({ kind: "`" });
			i++;
			continue;
		}
		if (char === "(" && wordStart) {
			stack.push({ kind: "(" });
			current += char;
			i++;
			continue;
		}
		if (char === ")" && frame?.kind === "(") {
			stack.pop();
			current += char;
			i++;
			wordStart = true;
			continue;
		}
		if (frame?.kind === "$(" || frame?.kind === "<(") {
			if (char === "(") frame.parens++;
			if (char === ")") {
				if (frame.parens > 0) frame.parens--;
				else {
					close();
					i++;
					continue;
				}
			}
		}

		// heredoc：操作符留在它的命令里，正文（下一行起到分隔符）当数据读。`<<<` 是 here-string，只是个词。
		if (posix && char === "<" && next === "<" && command[i + 2] !== "<") {
			const heredoc = readHeredocOperator(command, i);
			if (heredoc) {
				heredocs.push(heredoc.frame);
				current += command.slice(i, heredoc.end);
				i = heredoc.end;
				wordStart = false;
				continue;
			}
		}

		if (char === "\n") {
			separate("\n", 1);
			startHeredoc();
			continue;
		}
		if (char === ";") {
			separate(";", 1);
			continue;
		}
		if (char === "&" && next === "&") {
			separate("&&", 2);
			continue;
		}
		if (char === "|" && next === "|") {
			separate("||", 2);
			continue;
		}
		// `|&` 把 stderr 一起接过去，还是同一条管道。
		if (char === "|" && next === "&") {
			separate("|", 2);
			continue;
		}
		if (char === "|") {
			// `>|` 是无视 noclobber 的重定向，不是管道。
			if (current.endsWith(">")) {
				current += char;
				i++;
			} else separate("|", 1);
			continue;
		}
		if (char === "&") {
			// `&>`、`&>>`、`>&2`、`2>&1` 是重定向，不是放进后台。
			if (next === ">" || current.endsWith(">") || current.endsWith("<")) {
				current += char;
				i++;
				wordStart = false;
			} else separate("&", 1);
			continue;
		}
		current += char;
		i++;
		wordStart = /\s/.test(char);
	}
	flush("end");
	return pieces;
}

/**
 * `<<WORD`、`<<-WORD`、`<<'WORD'`、`<< "WORD"`、`<<\WORD`：读出分隔符，以及它带没带引号。
 *
 * 带任何引号正文都是字面的（bash 的规则），这正是要知道它的原因：字面的正文什么都跑不了，
 * 不带引号的正文里每个 `$(…)` 都会跑。
 */
function readHeredocOperator(command: string, at: number): { frame: HeredocFrame; end: number } | null {
	let i = at + 2;
	const stripTabs = command[i] === "-";
	if (stripTabs) i++;
	while (command[i] === " " || command[i] === "\t") i++;
	let delimiter = "";
	let quoted = false;
	let quote: "'" | '"' | null = null;
	for (; i < command.length; i++) {
		const char = command[i]!;
		if (quote) {
			if (char === quote) quote = null;
			else delimiter += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			quoted = true;
			continue;
		}
		if (char === "\\" && i + 1 < command.length) {
			quoted = true;
			delimiter += command[++i]!;
			continue;
		}
		if (DELIMITER_END.test(char)) break;
		delimiter += char;
	}
	if (!delimiter) return null;
	return { frame: { kind: "heredoc", delimiter, stripTabs, expands: !quoted }, end: i };
}

/** 拼回来的一条命令，以及跟在它后面的分隔符。 */
interface Rebuilt {
	text: string;
	after: Separator;
	depth: number;
}

/**
 * 把各段拼回完整的命令。
 *
 * 替换打断了它所在的命令；需要那条命令完整原貌的地方，打断处折成 `…`，替换自己的命令在关闭时单独出来。
 *
 * 空的一段连同它的分隔符一起丢掉，这也是 bash 的读法：`|`、`&&`、`||` 之后的换行会被跳过，
 * `curl u |⏎sh` 是一条管道，不能拆成两条。
 */
function rebuild(command: string, dialect: Dialect = "posix"): Rebuilt[] {
	const out: Rebuilt[] = [];
	const open: string[] = [];
	for (const piece of scan(command, dialect)) {
		if (piece.body) continue;
		const joined = (open[piece.depth] ?? "") + piece.text;
		if (piece.after === "sub") {
			open[piece.depth] = joined + "…";
			continue;
		}
		open[piece.depth] = "";
		const text = joined.trim();
		if (text) out.push({ text, after: piece.after, depth: piece.depth });
	}
	return out;
}

/** 这一行自己的一条命令，以及跟在它后面的操作符。 */
export interface SequenceEntry {
	/** 命令本身，其中的替换显示成 `…`。 */
	text: string;
	/** 后面跟的是什么：`;`、`|`、`&`、`&&`、`||`、换行，或者什么都没有（`end`）。 */
	after: ";" | "|" | "&" | "&&" | "||" | "\n" | "end";
}

/**
 * 这一行自己的命令，按顺序，带上它们之间的操作符。
 *
 * 替换折进它所在的命令，heredoc 正文去掉。这是「按 bash 的跑法看这一行」的视角：替换是它那条命令的一部分，
 * 不是这一行的一条命令。
 */
export function sequence(command: string): SequenceEntry[] {
	return rebuild(command)
		.filter((entry) => entry.depth === 0)
		.map((entry) => ({ text: entry.text, after: entry.after === "sub" || entry.after === "close" ? "end" : entry.after }));
}

/**
 * 这一行是否跑了不属于它自己那几条命令的东西：替换（`$(…)`、一对反引号、`<(…)`）或 heredoc。
 * `sequence` 把这些折成了 `…`，看不出来。
 */
export function nests(command: string): boolean {
	return scan(command).some((piece) => piece.depth > 0 || piece.body || piece.after === "sub" || piece.after === "close");
}

/** shell 原样传下去的一个词：引号和转义已经去掉。 */
export interface LiteralWord {
	text: string;
	/** `text` 里第一个没被引起来的 `*`、`?` 或 `[` 在哪，没有为 -1。从这里起 shell 可能换成文件名。 */
	glob: number;
}

/**
 * 一条命令的词，前提是 shell 会把每个词都原样传下去；否则为 `null`：有变量或替换（`$`、反引号）、
 * 重定向、子 shell 或命令组、花括号展开、注释，或者还接着别的命令。
 *
 * 只在这种时候给出词，判断才看得到程序真正收到的参数；看不准的一律交回去按写处理。
 */
export function literalWords(command: string): LiteralWord[] | null {
	const words: LiteralWord[] = [];
	let text = "";
	let glob = -1;
	let started = false;
	let quote: "'" | '"' | null = null;
	const end = () => {
		if (started) words.push({ text, glob });
		text = "";
		glob = -1;
		started = false;
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		const next = command[i + 1];
		if (quote === "'") {
			if (char === "'") quote = null;
			else text += char;
			continue;
		}
		if (quote === '"') {
			if (char === "$" || char === "`") return null;
			// \x60 就是反引号：直接写的话，文案检查会把正则里的它当成模板字符串的开头。
			if (char === "\\" && next !== undefined && /[$\x60\x22\\]/.test(next)) {
				text += next;
				i++;
			} else if (char === '"') quote = null;
			else text += char;
			continue;
		}
		if (/\s/.test(char)) {
			end();
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (char === "\\") {
			if (next === undefined || next === "\n") return null;
			text += next;
			i++;
			started = true;
			continue;
		}
		// 井号只在词首开始注释：issue#12 是一个词。
		if ("$`()<>{}|&;".includes(char) || (char === "#" && !started)) return null;
		if (glob === -1 && (char === "*" || char === "?" || char === "[")) glob = text.length;
		text += char;
		started = true;
	}
	if (quote) return null;
	end();
	return words;
}

/**
 * 一行拆成它要跑的每一条命令：`&&`、`||`、`;`、`|`、换行各起一条，`$( )`、反引号里的单独出来，heredoc 正文去掉。
 * 给按路径判读用：一串命令读到的东西是每一条读到的总和。
 */
export function splitCommands(command: string, dialect: Dialect = "posix"): string[] {
	return scan(command, dialect)
		.filter((piece) => !piece.body)
		.map((piece) => piece.text.trim())
		.filter(Boolean);
}

/**
 * 一条命令的词，按 bash 的规矩认引号和转义，再去掉它们。
 *
 * 反斜杠照 bash 的方式解：留着反斜杠的词是另一个路径，`cat ~/.ss\h/id_rsa` 读的是 `~/.ssh/id_rsa`，而密钥规则只认后一种写法。
 * 引号外反斜杠转义任何字符；双引号里只转义 `$`、反引号、`"`、`\` 和换行；单引号里什么都不转义。
 */
export function splitWords(command: string, dialect: Dialect = "posix"): string[] {
	if (dialect === "powershell") return splitPowerShellWords(command);
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | "$'" | null = null;
	let started = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		const next = command[i + 1];
		if (quote === "'") {
			if (char === "'") quote = null;
			else current += char;
			continue;
		}
		if (quote === "$'") {
			if (char === "\\" && next !== undefined) {
				current += ANSI_ESCAPES[next] ?? next;
				i++;
			} else if (char === "'") quote = null;
			else current += char;
			continue;
		}
		if (quote === '"') {
			// \x60 就是反引号：直接写的话，文案检查会把正则里的它当成模板字符串的开头。
			if (char === "\\" && next !== undefined && /[$\x60\x22\\\n]/.test(next)) {
				if (next !== "\n") current += next;
				i++;
			} else if (char === '"') quote = null;
			else current += char;
			continue;
		}
		if (char === "\\" && next !== undefined) {
			i++;
			if (next === "\n") continue;
			current += next;
			started = true;
			continue;
		}
		if (char === "$" && next === "'") {
			quote = "$'";
			started = true;
			i++;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			// 空的引号也是一个词：`--message ""` 有两个词。
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (current || started) words.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
	}
	if (current || started) words.push(current);
	return words;
}

/** `$'…'` 里对读词有影响的转义；其余的代表它自己。 */
const ANSI_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };

/**
 * PowerShell 的词：`\` 是词的一部分，反引号转义，单引号里的 `''` 是一个引号。`C:\Users\me\.ssh\id_rsa` 还是
 * PowerShell 要打开的那个路径。
 */
function splitPowerShellWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let started = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		const next = command[i + 1];
		if (quote === "'") {
			if (char === "'" && next === "'") {
				current += "'";
				i++;
			} else if (char === "'") quote = null;
			else current += char;
			continue;
		}
		if (char === "`" && next !== undefined) {
			i++;
			if (next !== "\n") current += next;
			started = true;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (current || started) words.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
	}
	if (current || started) words.push(current);
	return words;
}
