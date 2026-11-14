/**
 * 回复里指着本机文件的链接：地址怎么拆成路径和行号、文件签上写什么、哪些行内代码算是路径。
 */

import type { LineRange } from "../files/open-file.ts";
import { isAbsolutePath } from "./assets.ts";

const LINE_SUFFIX = /:(\d+)(?:-(\d+))?$|#L(\d+)(?:-L?(\d+))?$/;
/** 文内锚点（`README.md#usage`）。只认最后一段里的 `#`，`src/C#/a.cs` 的目录名不是锚点。 */
const ANCHOR = /#[^/\\#]*$/;

/**
 * `src/a.ts:42`、`src/a.ts:42-50`、GitHub 写法的 `src/a.ts#L42-L50` 拆成路径和行号，其余锚点去掉。
 *
 * `:0` 不算行号，但照样从路径上去掉：留着它，`a.ts:0` 会被当成一个叫这个名字的文件去找。锚点同理：
 * `a.go#L224` 原样拿去目录里找，永远找不到，每次打开会话都为它再找一遍。
 */
export function splitLineSuffix(text: string): { path: string; lines: LineRange | null } {
	const match = LINE_SUFFIX.exec(text);
	if (!match) return { path: text.replace(ANCHOR, ""), lines: null };
	const path = text.slice(0, match.index);
	const from = Number(match[1] ?? match[3]);
	const to = Number(match[2] ?? match[4] ?? from);
	if (from < 1) return { path, lines: null };
	return { path, lines: { from: Math.min(from, to), to: Math.max(from, to) } };
}

/**
 * `file:///Users/a/b.ts:42` 里的本机路径，行号后缀照留；不是本机的 `file://` 地址时是 null。
 *
 * 模型引用本机文件时常写成这种地址。不转的话 `file:` 被当成一种协议，整条链接退成纯文字。
 * 带主机名的（`file://server/share/…`）是网络共享，不在这里转，交给 `resolveAsset` 照旧拒掉。
 * 也不在这里解码：`resolveAsset` 会解一次，解两次 `%2520` 就成了空格。
 */
export function filePathInUrl(href: string): string | null {
	const match = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(href);
	if (!match) return null;
	// `file:///C:/a.ts` 的路径是 `C:/a.ts`：盘符前那道斜杠属于地址，不属于路径。
	return match[1]!.replace(/^\/(?=[A-Za-z]:[/\\])/, "");
}

function lineLabel(lines: LineRange): string {
	return lines.from === lines.to ? `${lines.from}` : `${lines.from}-${lines.to}`;
}

/**
 * 文件签上写什么。
 *
 * 模型会写 [`docs/issue/very-long-name.md`](docs/issue/very-long-name.md)，整条路径塞进签里会从一个词的
 * 中间折行。签上只写文件名，写不下就省略，永不折第二行；路径放在悬停提示里。
 *
 * 行号先看链接地址，再看文字：`[a.ts:42](src/a.ts)` 这种写法里行号只在文字上。文字里的只在它写的就是
 * 路径时才算，「端口 8080:3000」不是第 3000 行。`line` 是签上要画的那段，同样只在签写的是文件名
 * 时给——「入口逻辑:42」读起来不像话，那时行号只进提示。
 */
export function fileLinkCaption(
	label: string,
	path: string,
	given: LineRange | null = null,
): { text: string; tip: string; lines: LineRange | null; line: string | null } {
	const own = splitLineSuffix(label.trim());
	const trimmed = own.path;
	// 文件夹的路径以分隔符结尾，最后一段是它前面那个名字。
	const base =
		path
			.replace(/[/\\]+$/, "")
			.split(/[/\\]/)
			.pop()
			?.trim() || path;
	const pathLike = !trimmed || /[/\\]/.test(trimmed) || trimmed === base;
	const lines = given ?? (pathLike ? own.lines : null);
	const line = lines && pathLike ? lineLabel(lines) : null;
	const suffix = lines ? `:${lineLabel(lines)}` : "";
	if (!trimmed) return { text: base, tip: path + suffix, lines, line };
	if (!pathLike) return { text: trimmed, tip: path + suffix, lines, line };
	return { text: trimmed.split(/[/\\]/).pop() || base, tip: trimmed + suffix, lines, line };
}

/**
 * 裸文件名只认这些扩展名。带目录的路径不查这张表。
 *
 * `console.log`、`process.env`、`obj.method` 在形状上和 `index.ts` 一样，全靠扩展名分辨；
 * 表里只放一眼就是文件的那些，漏掉的冷门类型写成带目录的路径照样能点。
 */
const BARE_FILE_EXTENSIONS = new Set(
	"ts tsx mts cts js jsx mjs cjs json jsonc md mdx yaml yml toml ini xml csv sql html htm css scss sass less vue svelte py rs go java kt rb php swift c h cpp hpp cs sh bash zsh ps1 bat lock txt png jpg jpeg gif svg webp pdf".split(
		" ",
	),
);

/**
 * 行内代码里写的是不是一个文件或文件夹的路径；是的话返回它（保留 `:42` 行号后缀）。
 *
 * 模型常把路径写成 `path/to/file.ts:42`，这类行内代码要画成文件签。带空格、括号、引号、协议的都不是。
 *
 * 只看样子分不出 `src/utils` 和 `origin/main`。带目录的相对路径因此不要求扩展名：`Link` 会先在磁盘上
 * 找，找到了才画，`origin/main` 找不到就留作代码。绝对路径仍要最后一段有以字母开头的扩展名：`/api`、
 * `/login` 这类路由和本机的 `/tmp`、`/usr` 形状一样，不拿去问；裸名字只认 `BARE_FILE_EXTENSIONS`，
 * 不然 `console.log` 也成了文件。
 */
export function filePathInCode(text: string): string | null {
	const raw = text.trim();
	if (!raw || raw.length > 300 || /[\s()[\]{}<>\x22\x27\x60,;=*?|$&!]/.test(raw) || raw.includes("://")) return null;
	const { path } = splitLineSuffix(raw);
	const parts = path.split(/[/\\]/);
	if (parts.length > 1 && !isAbsolutePath(path)) {
		// 只有末尾那段可以是空的：`src/` 是文件夹，`a//b` 不是谁写的路径。
		return parts.slice(0, -1).every(Boolean) && parts.every((part) => /^[\w@+.-]*$/.test(part)) ? raw : null;
	}
	const base = parts.pop() ?? "";
	const ext = /^[\w@+-][\w.@+-]*\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(base)?.[1];
	if (!ext) return null;
	if (!isAbsolutePath(path) && !BARE_FILE_EXTENSIONS.has(ext.toLowerCase())) return null;
	return raw;
}
