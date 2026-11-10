/**
 * Markdown 里的相对链接都指向存在的文件（`pnpm check` 的一部分）。
 *
 * spec、skill、docs 之间靠相对链接互相指：rule 改名、文件挪走以后，指向它的链接照样渲染成链接，
 * 点开才发现是空的，读规范的 agent 就少读了一份该读的东西。这里每次都对着磁盘查一遍。
 *
 * 只查仓库里的 Markdown（已跟踪的和还没加进去但没被忽略的），只查相对路径；`#锚点` 只确认文件在，不查锚点。
 * http 链接失效是另一回事，查它要联网。
 *
 *   node scripts/check-links.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], { cwd: root, encoding: "utf8" })
	.split("\n")
	.filter((file) => file && existsSync(join(root, file)));

/** `[文字](目标)`，图片 `![…](…)` 也一样查。 */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

let broken = 0;
for (const file of files) {
	const text = readFileSync(join(root, file), "utf8");
	for (const [, raw] of text.matchAll(LINK)) {
		// 外链、页内锚点、mailto 不归这里管。
		if (/^(https?:|mailto:|#)/.test(raw)) continue;
		const path = decodeURI(raw.split("#")[0]);
		if (!path) continue;
		if (!existsSync(resolve(root, dirname(file), path))) {
			console.error(`${file} → ${raw}`);
			broken++;
		}
	}
}

if (broken > 0) {
	console.error(`\n✖ ${broken} 个链接指向不存在的文件`);
	process.exit(1);
}
console.log(`✓ ${files.length} 个 Markdown 文件，相对链接都有效`);
