/**
 * pre-commit 里自动修（排版、`oxlint --fix`）之后跑，参数是这次暂存的文件。
 *
 * `git commit -- <路径>`（`--only`）时，git 在跑钩子之前就把这些路径写进了真正的暂存区，钩子里 `git add` 的只进提交用的
 * 临时索引（`.git/next-index-*.lock`）：提交进去的是修好的，暂存区却留着修之前的那份，`git status` 里平白多出一笔反着改回去的。
 * 所以这种提交方式下修过了就拦下：工作区已经是修好的，原样再提交一次，git 拿的就是它。普通的 `git commit`、`-a`、`-i`
 * 改的就是真正的暂存区，不受影响，这里直接放行。
 */

import { execFileSync } from "node:child_process";

if (!/next-index-[^/\\]*\.lock$/.test(process.env.GIT_INDEX_FILE ?? "")) process.exit(0);

const files = process.argv.slice(2);
try {
	// 临时索引里装的是 git 从工作区取的内容；修过的文件，工作区和它就不一样了。
	execFileSync("git", ["diff", "--quiet", "--", ...files], { stdio: "inherit" });
} catch {
	console.error("钩子自动修改了要提交的文件。用 `git commit -- <路径>` 提交时改动进不了暂存区；工作区已经修好，原样再提交一次。");
	process.exit(1);
}
