/**
 * 项目里该看哪些文件：grep 兜底、`glob`、`read` 找同名文件共用本体给的那一份清单（`ctx.workspace.files`，见 `ToolContext.projectFiles`）。
 * 在 git 仓库里是 git 认为该看的文件（认 `.gitignore`，隐藏的也算）；不在仓库里、或 git 答不上来时是 null，工具自己走目录，
 * 跳过下面这张名单。
 */

import { stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { ToolContext } from "./types.ts";

/**
 * 不在 git 仓库里、只能自己走目录时跳过的目录：依赖、构建产物、缓存。仓库里认 `.gitignore`，用不到它。
 * `glob`、`grep` 的兜底共用这一张。
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".turbo",
	".cache",
	"Pods",
	".gradle",
	".expo",
]);

/**
 * `root` 是否在某个 git 工作区里，只看路径上有没有 `.git`，不起进程。
 *
 * ripgrep 认 `.gitignore` 也是这样判断的。给它的 `--hidden` 只在这时加：仓库外没有忽略规则兜着，
 * 从家目录搜会一头扎进 `~/.cache`、`~/.npm`。
 */
export async function insideGitWorkTree(root: string): Promise<boolean> {
	for (let dir = root; ; dir = dirname(dir)) {
		if (
			await stat(join(dir, ".git")).then(
				() => true,
				() => false,
			)
		)
			return true;
		if (dirname(dir) === dir) return false;
	}
}

/**
 * `root` 之下和 `wanted` 同名的文件，相对 `root` 写，末尾对得上的路径段越多越靠前，最多 `limit` 个。
 *
 * 给 `read` 找不到文件时用。真实会话里模型把模块名猜错（读 `eim-eicq/…/RequestDistributor.java`，
 * 文件其实在 `eim-echat/` 下），只拿到一句 File not found，就换个名字再猜一轮；`glob` 按目录分组
 * 以后，只拿文件名去读也会是这个下场。同名的列出来，下一步就是读对的那个。
 *
 * 只认同名，不做模糊匹配：猜出来的「相近」会把模型引到不相干的文件上。不在 git 仓库里返回空——
 * 为一句提示把整棵目录树走一遍不值。
 */
export async function sameNamed(ctx: Pick<ToolContext, "projectFiles">, root: string, wanted: string, limit = 5): Promise<string[]> {
	const want = wanted.split(/[\\/]/).filter(Boolean);
	const name = want.at(-1);
	if (!name) return [];
	const files = await ctx.projectFiles(root);
	if (!files) return [];
	const found: { path: string[]; shared: number }[] = [];
	for (const full of files) {
		const path = relative(root, full).split(sep);
		if (path.at(-1) !== name) continue;
		let shared = 1;
		while (shared < path.length && shared < want.length && path.at(-1 - shared) === want.at(-1 - shared)) shared++;
		found.push({ path, shared });
	}
	return found
		.sort((a, b) => b.shared - a.shared || a.path.join("/").localeCompare(b.path.join("/")))
		.slice(0, limit)
		.map((entry) => entry.path.join("/"));
}
