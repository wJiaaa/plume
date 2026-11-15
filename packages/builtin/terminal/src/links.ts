/**
 * 终端里哪些字点得开：网址，和会话里的文件路径。
 *
 * `pnpm dev` 印出 `http://localhost:5173`，构建失败印出 `src/app.ts:42:7`，原来只能选中了再粘到别处。现在 ⌘ 点
 * （Mac 以外 Ctrl 点）打开它们：要按修饰键，因为在终端里单点是开始选字。
 *
 * 网址开在回复里网址开的地方（`ui.openLink`），Shift 照旧交给系统浏览器。路径在文件面板里打开，只认
 * `ui.findFile` 答得出的：它只认会话文件边界里的文件，shell 印出来的路径打不开文件面板不肯开的文件。相对路径
 * 拼不上时按结尾找：`pnpm --filter desktop typecheck` 印的路径相对的是 `packages/desktop`，不是终端所在的目录。
 */

import { macKeyboard } from "@plume/ui";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

export interface LinkActions {
	/** 这条路径指的那个文件（绝对路径），没有就是 null；没有会话时什么都不认。 */
	find(path: string): Promise<string | null>;
	openUrl(url: string, external: boolean): void;
	openFile(path: string): void;
}

/** Mac 上 ⌘，别处 Ctrl：按着它点链接才打开。 */
export function opensLink(event: MouseEvent, platform = navigator.platform): boolean {
	return macKeyboard(platform) ? event.metaKey : event.ctrlKey;
}

/**
 * 编译器、测试、调用栈印路径的样子，可以带行号列号：`src/a.ts:12:3`、`./b.js`、`/abs/c.py:7`、`C:\x\d.cs(12,3)`，或者裸的 `e.go:9`。
 *
 * 前面不能紧挨着会让它成为网址尾巴、长单词一部分的字。带分隔符的必须以扩展名结尾，这样文件夹不算（文件面板开的是
 * 文件）；裸名字只有后面跟着行号才算，句子里单独一个 `index.ts` 是话，不是引用。
 */
const PATH =
	/(?<![\w:/\\.~@+-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])+[\w@+-][\w.@+-]*\.[A-Za-z0-9]+|[\w@+-][\w.@+-]*\.[A-Za-z0-9]+(?=:\d))(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))?/g;

export interface PathMatch {
	/** 整段匹配，含行号：画下划线的那一段。 */
	text: string;
	/** 只是路径。 */
	path: string;
	start: number;
	line?: number;
}

export function pathsIn(text: string): PathMatch[] {
	const found: PathMatch[] = [];
	for (const match of text.matchAll(PATH)) {
		const line = match[2] ?? match[4];
		found.push({ text: match[0], path: match[1]!, start: match.index ?? 0, ...(line ? { line: Number(line) } : {}) });
		if (found.length >= 20) break;
	}
	return found;
}

/**
 * 缓冲区的一行，连同每个字在第几格。
 *
 * `translateToString` 丢了后者：一个汉字是一个字、占两格，汉字后面的路径下划线会往左偏一格。
 */
function readLine(line: IBufferLine): { text: string; cellAt: number[] } {
	let text = "";
	const cellAt: number[] = [];
	for (let x = 0; x < line.length; x++) {
		const cell = line.getCell(x);
		if (!cell || cell.getWidth() === 0) continue;
		const chars = cell.getChars() || " ";
		for (let i = 0; i < chars.length; i++) cellAt.push(x);
		text += chars;
	}
	return { text, cellAt };
}

/** `find` 的回答信多久：指针扫过一行，那一行的每条路径都要问一遍。 */
const FIND_TTL = 5_000;

export function fileLinks(terminal: Terminal, actions: LinkActions): ILinkProvider {
	const known = new Map<string, { found: Promise<string | null>; at: number }>();
	const find = (path: string) => {
		const cached = known.get(path);
		if (cached && Date.now() - cached.at < FIND_TTL) return cached.found;
		const found = actions.find(path).catch(() => null);
		known.set(path, { found, at: Date.now() });
		return found;
	};
	return {
		provideLinks(y, callback) {
			const line = terminal.buffer.active.getLine(y - 1);
			if (!line) return callback(undefined);
			const { text, cellAt } = readLine(line);
			const matches = pathsIn(text);
			if (matches.length === 0) return callback(undefined);
			void Promise.all(matches.map((match) => find(match.path))).then((targets) => {
				const links: ILink[] = matches.flatMap((match, i) => {
					const path = targets[i];
					if (!path) return [];
					return [
						{
							text: match.text,
							range: {
								start: { x: cellAt[match.start]! + 1, y },
								end: { x: cellAt[match.start + match.text.length - 1]! + 1, y },
							},
							activate: (event: MouseEvent) => {
								if (opensLink(event)) actions.openFile(path);
							},
						},
					];
				});
				callback(links.length > 0 ? links : undefined);
			});
		},
	};
}

/** 两种都挂到一个终端上。 */
export function linkify(terminal: Terminal, actions: LinkActions): void {
	terminal.loadAddon(
		new WebLinksAddon((event, uri) => {
			if (opensLink(event)) actions.openUrl(uri, event.shiftKey);
		}),
	);
	terminal.registerLinkProvider(fileLinks(terminal, actions));
}
