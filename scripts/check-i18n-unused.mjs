/**
 * 没人用的词条（`pnpm check` 的一部分）。check-i18n.mjs 查该是词条却写死的字，这里查反过来的：
 * 组件删了，词条还留在两个语言文件里，下一个找措辞的人看到几条差不多的，分不清哪条还在用。
 *
 * 一个 key 只要以完整字符串字面量出现在任何源码里就算有人用。key 也会在运行时拼出来
 * （`` t(`thinking.${level}`) ``、`"notice." + kind`），所以插值前面的字面量前缀、后面的字面量后缀，
 * 会把以它开头、结尾的词条都留下。宁可多留：多留一条是两行字，误删一条界面上就直接露出 key。
 *
 *   node scripts/check-i18n-unused.mjs          # 报告，有没人用的词条就非零退出
 *   node scripts/check-i18n-unused.mjs --fix    # 从两个语言文件里一起删掉
 */

import { readFile, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MESSAGES = join(ROOT, "packages/client/ui/src/i18n/messages");
const CATALOGS = ["zh-CN.ts", "en.ts"].map((name) => join(MESSAGES, name));
// 市场插件拿不到产品的词条目录（文案自带在 src/messages.ts），不用扫。
const SCANNED = ["apps", "packages"].map((dir) => join(ROOT, dir));

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (path === MESSAGES || ["node_modules", "dist", "out"].includes(name)) continue;
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(path);
	}
	return out;
}

/** 跳过从 `at` 开始的字符串字面量，返回它结束引号后面的位置。 */
function stringEnd(text, at) {
	let i = at + 1;
	while (text[i] !== text[at]) i += text[i] === "\\" ? 2 : 1;
	return i + 1;
}

/**
 * 目录里每个顶层词条：key 和它占的那一段（含后面的逗号）。
 * 不按一行一个 key 读：短词条可能挤在一行里；带复数形式的词条是个对象，要跟着括号层数走。
 */
function entries(text) {
	const out = [];
	let depth = 1;
	let open = null;
	for (let i = text.indexOf("= {") + 3; i < text.length && depth > 0; i++) {
		const c = text[i];
		if (c === "/" && text[i + 1] === "/") i = text.indexOf("\n", i);
		else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i) + 1;
		else if (c === '"' || c === "'" || c === "`") {
			const end = stringEnd(text, i);
			const colon = depth === 1 && !open ? /^\s*:/.exec(text.slice(end, end + 8)) : null;
			if (colon) open = { key: text.slice(i + 1, end - 1), start: i };
			i = end - 1 + (colon ? colon[0].length : 0);
		} else if ("{[(".includes(c)) depth++;
		else if ("}])".includes(c) && --depth === 0 && open) out.push({ ...open, end: i });
		else if (c === "," && depth === 1 && open) {
			let end = i + 1;
			while (text[end] === " ") end++;
			out.push({ ...open, end });
			open = null;
		}
	}
	return out;
}

const keys = entries(await readFile(CATALOGS[0], "utf8")).map((entry) => entry.key);

const literals = new Set();
const prefixes = new Set();
const suffixes = new Set();
for (const file of SCANNED.flatMap((dir) => walk(dir))) {
	const text = await readFile(file, "utf8");
	for (const [, name] of text.matchAll(/["'`]([\w.-]+)["'`]/g)) literals.add(name);
	for (const [, head] of text.matchAll(/`([\w.-]+\.)\$\{/g)) prefixes.add(head);
	for (const [, head] of text.matchAll(/["']([\w.-]+\.)["']\s*\+/g)) prefixes.add(head);
	for (const [, tail] of text.matchAll(/\}(\.[\w.-]+)`/g)) suffixes.add(tail);
}

const used = (key) => literals.has(key) || [...prefixes].some((head) => key.startsWith(head)) || [...suffixes].some((tail) => key.endsWith(tail));
const unused = keys.filter((key) => !used(key));

if (process.argv.includes("--fix")) {
	const dead = new Set(unused);
	for (const path of CATALOGS) {
		let text = await readFile(path, "utf8");
		for (const { key, start, end } of entries(text).reverse()) {
			if (!dead.has(key)) continue;
			const lineStart = text.lastIndexOf("\n", start - 1) + 1;
			const alone = !text.slice(lineStart, start).trim() && text[end] === "\n";
			// 独占一行就删整行；和别的词条挤在一行就只删它自己和它留下的空格。
			if (alone) text = text.slice(0, lineStart) + text.slice(end + 1);
			else text = text.slice(0, start).replace(text[end] === "\n" ? / +$/ : /$/, "") + text.slice(end);
		}
		await writeFile(path, text);
	}
	console.log(`删掉了 ${unused.length} 个没人用的词条（两种语言）。`);
	process.exit(0);
}

if (unused.length) {
	console.error(`${unused.length} 个词条没有任何代码在用：\n${unused.map((key) => `  ${key}`).join("\n")}\n确认后：node scripts/check-i18n-unused.mjs --fix`);
	process.exit(1);
}
console.log(`✓ ${keys.length} 个词条都有人用`);
