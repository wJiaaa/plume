/**
 * 回复里写的一条相对路径，是不是这场对话里 read、edit、write 过的那个文件。
 *
 * 这几样工具的路径是 agent 亲手给的，不必再去磁盘上找：对得上就当场画成文件签，流式写着的时候也一样。
 * 对不上、或者对上不止一个，交回给 `useLocatedPaths` 照旧去找。碰过的路径从哪来见 `files/scope.ts`。
 */

import { isAbsolutePath } from "./assets.ts";

const slashed = (path: string) => path.replaceAll("\\", "/");

/**
 * `relative` 在 `roots` 里对得上的那一个碰过的文件；第一个对得上的目录里只有一个时才认。
 *
 * 只认 `roots` 里的：文件面板只放行会话工作目录，别处的文件画成签也只会点出一句「读不到」。
 */
export function touchedFile(paths: readonly string[], cwd: string | null, roots: readonly string[], relative: string): string | null {
	// 不走 `resolveAsset`：它把 `#` 后面当成锚点切掉，`src/C#/a.cs` 就没了。带 `..` 的不拼，对不上就交回去找。
	const files = paths.flatMap((path) => (isAbsolutePath(path) ? [path] : cwd ? [`${cwd.replace(/[/\\]+$/, "")}/${path.replace(/^\.[/\\]/, "")}`] : []));
	const wanted = slashed(relative).replace(/^\.\//, "");
	if (!wanted || wanted.endsWith("/")) return null;
	for (const root of roots) {
		const inside = `${slashed(root).replace(/\/+$/, "")}/`;
		const matches = new Set(
			files.filter((file) => {
				const path = slashed(file);
				if (!path.startsWith(inside)) return false;
				const rest = path.slice(inside.length);
				return rest === wanted || rest.endsWith(`/${wanted}`);
			}),
		);
		if (matches.size) return matches.size === 1 ? [...matches][0]! : null;
	}
	return null;
}
