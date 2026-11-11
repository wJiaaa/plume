/**
 * 提交信息的格式（commit-msg 钩子，见 lefthook.yml）：把 spec/tech/commits.md 的格式变成能失败的检查。
 *
 *   <type>(<scope>): <中文主题>
 *
 *   <为什么>
 *
 * 只查形状，不查写得好不好：type 不在名单里、整行超过 100 个字符、主题和正文之间没空行，拦下；
 * scope 不在名单里只提醒——scope 是归档用的，写偏了不该逼人去 `--no-verify`。
 * Git 自己生成的合并、撤销、fixup! / squash! 不查。
 *
 *   node scripts/check-commit-msg.mjs <提交信息文件>
 */

import { readFileSync } from "node:fs";

const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "chore", "ci", "build", "revert"];
const SCOPES = ["core", "electron", "desktop", "ui", "plugins", "release", "deps"];
const HEADER_MAX = 100;
const GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

const file = process.argv[2];
if (!file) {
	console.error("用法：node scripts/check-commit-msg.mjs <提交信息文件>");
	process.exit(2);
}

// 钩子拿到的是编辑器存下的原文：注释行和 `git commit -v` 剪刀线以下的 diff 都还在，Git 之后才清掉。
const raw = readFileSync(file, "utf8").split("\n# ------------------------ >8 ------------------------")[0];
const lines = raw.split("\n").filter((line) => !line.startsWith("#"));
while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
while (lines.length > 0 && lines[0].trim() === "") lines.shift();

// 空的交给 Git 自己拒；生成的不是人写的格式。
if (lines.length === 0 || GENERATED.test(lines[0])) process.exit(0);

const header = lines[0];
const errors = [];
const warnings = [];

const match = /^([a-z]+)(?:\(([^()]*)\))?: (\S.*)$/.exec(header);
if (!match) {
	errors.push("标题要写成 `<type>(<scope>): <主题>` 或 `<type>: <主题>`，冒号后面一个空格。");
} else {
	const [, type, scope] = match;
	if (!TYPES.includes(type)) errors.push(`type「${type}」不在名单里：${TYPES.join("、")}。`);
	if (scope !== undefined && !SCOPES.includes(scope)) warnings.push(`scope「${scope}」不在名单里：${SCOPES.join("、")}；跨好几个包的可以不写 scope。`);
}
const length = [...header].length;
if (length > HEADER_MAX) errors.push(`标题 ${length} 个字符，最多 ${HEADER_MAX}：细节挪进正文。`);
if (lines.length > 1 && lines[1].trim() !== "") errors.push("标题和正文之间要空一行。");

for (const warning of warnings) console.error(`⚠ ${warning}`);
if (errors.length > 0) {
	console.error(`✖ 提交信息不合规：\n  ${header}\n`);
	for (const error of errors) console.error(`  - ${error}`);
	console.error("\n格式见 spec/tech/commits.md。");
	process.exit(1);
}
