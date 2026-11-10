#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里取出一个版本的那一节。
 *
 * tag 说明要用它，以后发布到 Release 时正文也用它：两处都从 CHANGELOG 读，人改的那个文件就是人看到的发布内容，
 * 而不是把 `git log` 原样贴出去。
 *
 * 用法：`node scripts/changelog-section.mjs v0.2.0`
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const tag = process.argv[2];
if (!tag) {
	console.error("用法：node scripts/changelog-section.mjs <tag>");
	process.exit(2);
}

const version = tag.replace(/^v/, "");
const changelog = await readFile(join(ROOT, "CHANGELOG.md"), "utf8");

/*
 * 按标题认，不按正文里出现的版本号认：提交信息里可能提到「0.2.0」，发版那条提交一定会提，
 * 松一点的匹配会从别人的一句话中间开始截。
 */
const lines = changelog.split("\n");
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
	console.error(`CHANGELOG.md 里没有 ${version} 这一节，先跑 pnpm release 生成它。`);
	process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith("## ["));
const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();

process.stdout.write(`${body}\n`);
