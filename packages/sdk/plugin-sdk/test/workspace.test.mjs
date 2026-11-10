/**
 * 插件仓库这样的别的 pnpm workspace 里 init：SDK 依赖写 npm 上的版本号，不写指回 SDK 所在目录的路径（换台机器、换个目录就断）；
 * 插件规则（lint/）拦得住越界引用、写死的色值和 Tailwind 类、界面上写死的中文。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { initPlugin } from "../lib/init.mjs";
import { lintPlugin } from "../lib/lint/index.mjs";

const sdk = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version;
const work = mkdtempSync(join(tmpdir(), "plume-plugin-workspace-"));

after(() => rmSync(work, { recursive: true, force: true }));

test("别的 workspace 里 init：SDK 依赖是 npm 上的版本号", () => {
	writeFileSync(join(work, "pnpm-workspace.yaml"), "packages:\n  - plugins/*\n");
	const created = initPlugin(join(work, "plugins", "hello"));
	assert.equal(created.workspace, true);
	const pkg = JSON.parse(readFileSync(join(created.dir, "package.json"), "utf8"));
	assert.equal(pkg.devDependencies["@plumeai/plugin-sdk"], `^${version}`);
});

test("插件规则：越界引用、色值、Tailwind 类、写死的中文都报出来；color-exempt 的文件不查色值", async () => {
	const dir = join(work, "bad");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bad", type: "module" }));
	writeFileSync(
		join(dir, "src/ui.tsx"),
		[
			'import { Agent } from "@plume/agent";',
			'import { Card } from "@plume/contract";',
			'export const View = () => <div className="flex text-ink" style={{ color: "#ff0000" }}>你好</div>;',
		].join("\n"),
	);
	writeFileSync(join(dir, "src/canvas.ts"), '// color-exempt：画在 canvas 上只认字面色值\nexport const RED = "#ff0000";\n');
	const rules = (await lintPlugin(dir)).map((problem) => `${problem.rule} ${problem.message.split("：")[0]}`);
	// JSX 里的文字报的是整行，按开头认。
	for (const expected of [
		"引用 @plume/agent",
		"引用 @plume/contract",
		"插件类名 flex",
		"插件类名 text-ink",
		"色值 #ff0000",
		'行内样式 color: "#ff0000"',
		"中文 ",
	])
		assert.ok(
			rules.some((rule) => rule.startsWith(expected)),
			`${expected}\n${rules.join("\n")}`,
		);
	assert.equal(rules.filter((rule) => rule.startsWith("色值")).length, 1, "canvas.ts 写了 color-exempt，不查色值");
});
