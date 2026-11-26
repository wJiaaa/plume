/**
 * 插件仓库这样的别的 pnpm workspace 里 init：SDK 依赖写 npm 上的版本号，不写指回 SDK 所在目录的路径（换台机器、换个目录就断）；
 * 插件规则（lint/）：默认拦越界引用、产品 Tailwind 类、全局 CSS 污染和写死的中文，放行带作用域的自定义样式；strictStyle: true 额外严查设计系统约束。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, test } from "vitest";
import { initPlugin } from "../lib/init.mjs";
import { lintPlugin } from "../lib/lint/index.mjs";

const sdk = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version;
const work = mkdtempSync(join(tmpdir(), "plume-plugin-workspace-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

test("别的 workspace 里 init：SDK 依赖是 npm 上的版本号", () => {
	writeFileSync(join(work, "pnpm-workspace.yaml"), "packages:\n  - plugins/*\n");
	const created = initPlugin(join(work, "plugins", "hello"));
	assert.equal(created.workspace, true);
	const pkg = JSON.parse(readFileSync(join(created.dir, "package.json"), "utf8"));
	assert.equal(pkg.devDependencies["@plumeai/plugin-sdk"], `^${version}`);
});

test("插件规则（默认模式）：拦越界引用、产品 Tailwind 类、全局 CSS 污染和写死的中文，允许带作用域的自定义样式", async () => {
	const dir = join(work, "default-mode");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "default-mode", type: "module" }));
	writeFileSync(
		join(dir, "src/ui.tsx"),
		[
			'import { Agent } from "@plume/agent";',
			'import { Card } from "@plume/contract";',
			'export const View = () => <div className="my-card flex text-ink" style={{ color: "#ff0000", borderRadius: 12, fontSize: 15 }}>你好</div>;',
		].join("\n"),
	);
	writeFileSync(
		join(dir, "src/custom.css"),
		[
			".my-card { color: #2563eb; font-size: 14px; font-weight: 600; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); transition: opacity 150ms; }",
			"* { box-sizing: border-box; }",
			"body { margin: 0; }",
			":root { --plume-bg: #fff; }",
			".my-ok, button { color: #111; }",
			"[disabled] { opacity: 0.4; }",
			'a[href="https://example.com"] { color: #00f; }',
			":not(.my-card) { opacity: 0.5; }",
			"div:has(.my-card) { padding: 0; }",
			":is(.my-a, button) span { color: #333; }",
			"@media (prefers-color-scheme: dark) { h1 { color: #fff; } }",
			"@scope (body) { p { color: #666; } }",
		].join("\n"),
	);
	const rules = (await lintPlugin(dir)).map((problem) => `${problem.rule} ${problem.message.split("：")[0]}`);
	// JSX 里的文字报的是整行，按开头认。
	for (const expected of [
		"引用 @plume/agent",
		"引用 @plume/contract",
		"插件类名 flex",
		"插件类名 text-ink",
		"全局样式 *",
		"全局样式 body",
		"全局样式 :root",
		"全局样式 button",
		"全局样式 [disabled]",
		'全局样式 a[href="https://example.com"]',
		"全局样式 :not(.my-card)",
		"全局样式 div:has(.my-card)",
		"全局样式 :is(.my-a, button) span",
		"全局样式 h1",
		"全局样式 @scope (body)",
		"中文 ",
	])
		assert.ok(
			rules.some((rule) => rule.startsWith(expected)),
			`${expected}\n${rules.join("\n")}`,
		);
	assert.equal(
		rules.some((rule) => /^(?:色值|行内样式|时长|插件样式)\s/.test(rule)),
		false,
		`默认模式不该报设计系统样式规则：\n${rules.join("\n")}`,
	);
});

test("全局 CSS 污染检查：带类/ID、@scope、原生嵌套、@keyframes、::highlight 等作用域写法全部放行", async () => {
	const dir = join(work, "scoped-css");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scoped-css", type: "module" }));
	writeFileSync(
		join(dir, "src/style.css"),
		[
			".my-card { color: #2563eb; font-size: 14px; border-radius: 12px; transition: opacity 200ms; }",
			".my-card button, #my-panel > span { color: #111; }",
			"button.my-btn:hover { background: #eee; }",
			':root[data-diff-markers="symbols"] .my-diff { padding-left: 8px; }',
			"[data-plume-flash] .my-card { outline: 2px solid #f59e0b; }",
			"::highlight(my-plugin-draft) { background: rgba(255, 200, 0, 0.25); }",
			":is(.my-a, .my-b) button { cursor: pointer; }",
			".my-nested { button { color: #222; } & > * { box-sizing: border-box; } }",
			"@scope (.my-scope) { * { box-sizing: border-box; } button { color: #111; } }",
			"@scope (.my-scope) to (.my-inner) { a { color: #00f; } }",
			"@keyframes my-spin { from { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }",
			'@font-face { font-family: "Demo"; src: local("Arial"); }',
		].join("\n"),
	);
	const problems = await lintPlugin(dir);
	assert.deepEqual(problems, []);
});

test("插件规则（strictStyle 模式）：额外查色值、行内样式、时长和 CSS 排版；color-exempt 的文件不查色值", async () => {
	const dir = join(work, "strict-mode");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "strict-mode", type: "module" }));
	writeFileSync(join(dir, "src/ui.tsx"), 'export const View = () => <div className="my-card" style={{ color: "#ff0000" }} />;\n');
	writeFileSync(join(dir, "src/style.css"), ".my-card { font-size: 14px; border-radius: 8px; transition: opacity 150ms; }\n");
	writeFileSync(join(dir, "src/canvas.ts"), '// color-exempt：画在 canvas 上只认字面色值\nexport const RED = "#ff0000";\n');
	const rules = (await lintPlugin(dir, { strictStyle: true })).map((problem) => `${problem.rule} ${problem.message.split("：")[0]}`);
	for (const expected of ["色值 #ff0000", '行内样式 color: "#ff0000"', "时长 150ms", "插件样式 font-size: 14px", "插件样式 border-radius: 8px"])
		assert.ok(
			rules.some((rule) => rule.startsWith(expected)),
			`${expected}\n${rules.join("\n")}`,
		);
	assert.equal(rules.filter((rule) => rule.startsWith("色值")).length, 1, "canvas.ts 写了 color-exempt，不查色值");
});
