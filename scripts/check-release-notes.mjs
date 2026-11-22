#!/usr/bin/env node
/**
 * 发版文案：CHANGELOG.md 里这一版那一节要有手写的英文、中文两段，各以 `<!-- plume:notes en -->`、
 * `<!-- plume:notes zh-CN -->` 开头。git-cliff 生成的提交列表只是原料，原样发出去，关于页和更新对话框里
 * 就只有一串提交标题（分段的读法见 apps/desktop/src/renderer/update/notes-locale.ts）。
 *
 *   node scripts/check-release-notes.mjs v0.5.0   # 查工作区的 CHANGELOG.md
 *   node scripts/check-release-notes.mjs          # pre-push 钩子：从标准输入读要推的 ref，只查 v* tag，读 tag 指向的那份 CHANGELOG.md
 *
 * `pnpm release` 推送前也按这里查一遍（release.mjs），文案没写就停在推送前。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection } from "./changelog-section.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["en", "zh-CN"];

/** 这一版缺的问题，一条一句；没缺的是空数组。 */
export function releaseNotesProblems(changelog, version) {
	const section = changelogSection(changelog, version);
	if (section === undefined) return [`CHANGELOG.md 里没有 ${version} 这一节`];
	const problems = [];
	for (const locale of LOCALES) {
		// 和 notes-locale.ts 一样只认独占一行的标记；后面要跟着内容，空着的一段在关于页里什么也不显示。
		const marker = new RegExp(`^[ \\t]*<!--[ \\t]*plume:notes[ \\t]+${locale}[ \\t]*-->[ \\t]*$`, "m").exec(section);
		if (!marker) {
			problems.push(`${version} 这一节没有 <!-- plume:notes ${locale} --> 那一段`);
			continue;
		}
		const after = section.slice(marker.index + marker[0].length);
		const next = after.search(/^[ \t]*<!--[ \t]*plume:notes[ \t]/m);
		if (!(next === -1 ? after : after.slice(0, next)).trim()) problems.push(`${version} 这一节的 <!-- plume:notes ${locale} --> 那一段是空的`);
	}
	return problems;
}

/** pre-push 的标准输入：每行 `<本地 ref> <本地 sha> <远端 ref> <远端 sha>`；删 tag 时本地 sha 全是 0。 */
function pushedTags(input) {
	return input
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([ref, sha]) => ref?.startsWith("refs/tags/v") && sha && !/^0+$/.test(sha))
		.map(([ref, sha]) => ({ tag: ref.slice("refs/tags/".length), sha }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const tag = process.argv[2];
	const targets = tag
		? [{ tag, changelog: readFileSync(join(ROOT, "CHANGELOG.md"), "utf8") }]
		: pushedTags(readFileSync(0, "utf8")).map(({ tag, sha }) => ({
				tag,
				changelog: execFileSync("git", ["show", `${sha}:CHANGELOG.md`], { cwd: ROOT, encoding: "utf8" }),
			}));
	const problems = targets.flatMap(({ tag, changelog }) => releaseNotesProblems(changelog, tag.replace(/^v/, "")));
	if (problems.length > 0) {
		console.error(`发版文案没写完（见 docs/release.md「发版」）：\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
		process.exit(1);
	}
}
