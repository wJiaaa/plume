/**
 * 把 `/review src/foo.ts` 展开成它代表的那段话。
 *
 * 参数放哪由模板定：`$1`、`$2` 一个一个取，`$ARGUMENTS`（或 `$@`）取整段原文。模板里一个占位都没写时参数接在末尾：
 * 否则命令后面打的字被悄悄丢掉，读起来是命令坏了。
 */

/**
 * 像 shell 那样切参数，只留这里用得上的：引号把几个词括成一个，其余按空白切。没有反斜杠转义——这里打的是路径和
 * 句子，`C:\Users\x` 被吃掉分隔符比引号要多打一遍更糟。
 */
export function splitArguments(rest: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let started = false;
	for (const character of rest) {
		if (quote) {
			if (character === quote) quote = null;
			else current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started || current) out.push(current);
			current = "";
			started = false;
			continue;
		}
		current += character;
	}
	if (started || current) out.push(current);
	return out;
}

const PLACEHOLDER = /\$(ARGUMENTS\b|@|\d+)/g;

/** 一遍替换：插进去的参数里就算有 `$2` 也不会再被换一次。 */
export function expandTemplate(content: string, rest: string): string {
	const args = splitArguments(rest);
	let used = false;
	const body = content.replace(PLACEHOLDER, (_match, token: string) => {
		used = true;
		if (token === "@" || token.startsWith("ARGUMENTS")) return rest;
		return args[Number.parseInt(token, 10) - 1] ?? "";
	});
	if (!used && rest) return `${body.trim()}\n\n${rest}`;
	return body.trim();
}
