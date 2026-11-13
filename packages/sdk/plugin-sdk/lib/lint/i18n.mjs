/**
 * 硬编码中文：界面上给人读的文字要走 i18n，不能直接写在代码里。插件检查（`plume-plugin check`）和 Plume 自己的
 * `pnpm check:i18n` 用的是这同一份。
 *
 * 算一条的：字符串字面量或 JSX 文本里有汉字或中文标点。不算的：注释（注释本来就用中文写）、
 * 日志调用的参数（`console.*` 和 Plume 的 log，写给调试的人看的）、紧跟在 `i18n-exempt` 注释后面、到下一个空行为止的几行
 * （给人读但不能翻译的字：发给模型的提示词、和存量数据比对的固定字符串……注释里写明原因）。
 *
 * 中文标点单独算：词都翻译完以后剩下的就是 `parts.join("、")`、`${name}：${message}` 这种，
 * 只查汉字会放过它们，而它们在英文界面里会夹出中文标点。
 *
 * 插件的文案：自带中英两份，放在 src/messages.ts（不查）；界面入口用 `@plume/ui` 的 useI18n() 取当前语言，逻辑入口用 ctx.locale()。
 */

/** 汉字，和中文句子用的标点（分隔、括号、句读；不是全部全角字符）。 */
const CHINESE = /[一-鿿、，：；（）「」『』。！？]/;

/**
 * 去掉注释，换行保留（块注释里的也一个换一个），行号才对得上，`i18n-exempt` 也按行认。
 * 认得字符串：示例 URL 里的 `//` 不是注释，当成注释会把那一行后面的文字都跳过去。
 * 认得正则字面量：`/"/g` 里的引号不是字符串的开头，当成字符串会把后面的注释吞进去、报成文案。
 * 模板字符串会嵌套，`${…}` 里又可以有字符串和注释，所以用一个栈。
 */
function stripComments(src) {
	let out = "";
	const stack = [];
	const inside = () => stack[stack.length - 1];

	for (let i = 0; i < src.length;) {
		const char = src[i];
		const two = src.slice(i, i + 2);
		const state = inside();

		if (state === "'" || state === '"' || state === "`") {
			if (char === "\\") {
				out += two;
				i += 2;
				continue;
			}
			if (char === state) stack.pop();
			else if (state === "`" && two === "${") {
				stack.push("{");
				out += two;
				i += 2;
				continue;
			}
			out += char;
			i += 1;
			continue;
		}

		// 代码，或者 `${…}` 里面：这里的注释都是注释。
		if (two === "//") {
			// 停在换行前，让循环自己把换行抄过去；这里再补一个，后面的行号都会错一行。
			const end = src.indexOf("\n", i);
			i = end === -1 ? src.length : end;
			continue;
		}
		if (two === "/*") {
			const end = src.indexOf("*/", i + 2);
			const body = src.slice(i, end === -1 ? src.length : end + 2);
			i = end === -1 ? src.length : end + 2;
			out += body.replace(/[^\n]/g, "");
			continue;
		}
		if (char === "/" && regexMayStart(out)) {
			const end = regexEnd(src, i);
			if (end !== -1) {
				// 正则不是给人读的字，内容遮成空格，后面认字符串时也不会再被里面的引号带偏。
				out += `/${src.slice(i + 1, end).replace(/[^\n]/g, " ")}/`;
				i = end + 1;
				continue;
			}
		}
		if (char === "'" || char === '"' || char === "`") stack.push(char);
		else if (char === "{") stack.push("{");
		else if (char === "}" && state === "{") stack.pop();
		out += char;
		i += 1;
	}
	return out;
}

/** 斜杠前面是这些词时，它开始的是正则，不是除号（`return /x/.test(s)`）。 */
const BEFORE_REGEX_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * 代码里的 `/` 是不是正则的开头：看前一个有意义的字符。跟在值后面（标识符、数字、`)`、`]`、`}`）是除号，跟在运算符、
 * 括号、逗号后面是正则。`<` 不算（`</p>` 是 JSX 的结束标签），`>` 只认箭头函数的 `=>`（`<p>/路径</p>` 里的是 JSX 文本）。
 */
function regexMayStart(out) {
	const code = out.trimEnd();
	const last = code.at(-1);
	if (last === undefined) return true;
	if (last === ">") return code.at(-2) === "=";
	if (/[\w$]/.test(last)) return BEFORE_REGEX_WORDS.has(/[\w$]+$/.exec(code)[0]);
	return "(,=:[!&|?{};+-*%~^".includes(last);
}

/** 从 `start` 的 `/` 起，正则收尾那个 `/` 的位置：认得转义和字符类 `[/]`；同一行里收不了尾就不是正则，返回 -1。 */
function regexEnd(src, start) {
	let inClass = false;
	for (let i = start + 1; i < src.length; i++) {
		const char = src[i];
		if (char === "\n") return -1;
		if (char === "\\") i += 1;
		else if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) return i;
	}
	return -1;
}

/** 只进日志的调用：`console.*`，和 Plume 自己的日志函数（`log(…)`、`this.options.log(…)`、`ctx.log.warn(…)`）。 */
const LOG_CALL = /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|trace)|(?:\w+\s*\.\s*)*log(?:\s*\.\s*(?:info|warn|error))?)\s*\(/g;

/**
 * 把日志调用的参数整段抹掉（换行保留）：只进日志的不算。
 * 找调用时先把字符串内容遮住，字符串里恰好有 `console.log(` 不会被当成调用，日志字符串里的括号也不会提前结束它。
 */
function stripLogs(stripped) {
	const masked = stripped.replace(
		/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
		(literal) => literal[0] + literal.slice(1, -1).replace(/[^\n]/g, " ") + literal.at(-1),
	);
	let out = stripped;
	for (const call of masked.matchAll(LOG_CALL)) {
		const open = call.index + call[0].length - 1;
		let close = masked.length;
		for (let i = open, depth = 0; i < masked.length; i++) {
			if (masked[i] === "(") depth += 1;
			else if (masked[i] === ")" && --depth === 0) {
				close = i;
				break;
			}
		}
		out = out.slice(0, open + 1) + out.slice(open + 1, close).replace(/[^\n]/g, " ") + out.slice(close);
	}
	return out;
}

/**
 * `i18n-exempt` 注释管到的行：从下一行到第一个空行。
 *
 * 给有这样一种字留的：人读不到、也不能跟着语言变的固定字符串（发给模型的提示词、和存量数据比对的词）。
 * 整个文件豁免太宽（同一个文件里往往还有真正的界面文案），所以豁免写在它管的那几行上面，原因写在注释里。
 * 一条注释管到空行为止，一张表只要写一次。
 */
function exemptLines(source) {
	const lines = source.split("\n");
	const exempt = new Set();
	for (let i = 0; i < lines.length; i++) {
		if (!/i18n-exempt\b/.test(lines[i])) continue;
		for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) exempt.add(j + 1);
	}
	return exempt;
}

/**
 * 一个文件里所有给人读的中文，`{ line, text }`。
 *
 * 先认字符串字面量，再把它们的内容遮住：剩下还有中文的，只能是 JSX 文本（`.tsx` 里标签之间的字，
 * 包括写在 `{cond && <p>…</p>}` 这种表达式里的）。不去配对标签和花括号：配对的写法会被箭头函数的 `>`
 * 和表达式里的 `n > 1` 带偏，整段跳过真正的文字。
 *
 * @param {string} source
 * @returns {{ line: number, text: string }[]}
 */
export function chineseFindings(source) {
	const stripped = stripLogs(stripComments(source));
	const spared = exemptLines(source);
	const found = [];
	const at = (index) => stripped.slice(0, index).split("\n").length;
	const keep = (line, text) => {
		if (!spared.has(line)) found.push({ line, text });
	};
	// 认得转义，`"他说 \"好\""` 是一条，不是两条。
	const literal = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
	for (const match of stripped.matchAll(literal)) {
		if (CHINESE.test(match[0])) keep(at(match.index), match[0].trim().slice(0, 80));
	}
	const masked = stripped.replace(literal, (text) => text.replace(/[^\n]/g, " "));
	masked.split("\n").forEach((line, index) => {
		if (CHINESE.test(line)) keep(index + 1, line.trim().replace(/\s+/g, " ").slice(0, 80));
	});
	return found;
}
