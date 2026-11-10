/**
 * 把一次验证交给 `verify` 子智能体，父会话省下了多少上下文？
 *
 *   node --experimental-transform-types test/tool-eval/verify-eval.ts [模型 id]
 *
 * 说法是：「verify 跑一个会失败的测试，父会话拿到的是失败摘要，不是完整日志」。这里用真的：一个临时项目、一条真会失败的
 * `node --test`、一个真的模型、真的 bash（plume.tools 的，权限是完全访问）。量两个数——完整日志多少字符，父会话最后收到的那条
 * 送达多少字符——以及摘要里有没有说对是哪条挂了、计数对不对。派发经 `dispatch.ts`：父会话照脚本派，子智能体用这里解析出的模型。
 */

import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagents from "../../../plume-plugins/plugins/subagents/src/index.ts";
import { evalAgent } from "./agent.ts";
import { dispatchOnce } from "./dispatch.ts";
import { loadModel } from "./model.ts";

const say = (line = "") => process.stderr.write(`${line}\n`);
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

async function fixture(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "plume-verify-"));
	await mkdir(join(cwd, "test"), { recursive: true });
	await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
	await writeFile(join(cwd, "parser.js"), "export function parseSettings(raw) { return JSON.parse(raw); }\n");
	/*
	 * 三十条过、一条挂：只有四条时日志不到一千字符，那个量级上「省了七成」说明不了什么。
	 * 挂的那条名字很具体，好看摘要有没有说对是哪条。
	 */
	const passing = Array.from({ length: 30 }, (_, i) => `test("parses case ${i} correctly", () => assert.deepEqual(parseSettings('{"k":${i}}'), { k: ${i} }));`);
	await writeFile(
		join(cwd, "test", "parser.test.js"),
		[
			'import assert from "node:assert/strict";',
			'import { test } from "node:test";',
			'import { parseSettings } from "../parser.js";',
			...passing,
			'test("rejects a trailing comma with a clear message", () => {',
			"  assert.throws(() => parseSettings('{\"a\":1,}'), /trailing comma/);",
			"});",
		].join("\n"),
	);
	return cwd;
}

interface VerifyOutput {
	passed?: boolean;
	summary?: string;
	failures?: { name?: string; location?: string; message?: string }[];
}

async function main(): Promise<void> {
	const model = await loadModel(process.argv[2]);
	const cwd = await fixture();
	/*
	 * 完整日志：父会话自己跑的话会拿到的东西。不写 `test/`：Node 24 把目录参数当成一个要执行的文件，报「找不到模块」就收场，
	 * 量到的是一行错误而不是测试日志；不给参数时按默认规则找到 `test/` 下的测试文件。
	 */
	let fullLog = "";
	try {
		execSync("node --test", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string };
		fullLog = `${e.stdout ?? ""}${e.stderr ?? ""}`;
	}

	say(`\nverify 委派出去，父会话省了多少 · ${model.model.id}\n`);
	const agent = await evalAgent({ model, plugins: [subagents] });
	const started = Date.now();
	try {
		const { task, delivered, parent } = await dispatchOnce(agent, cwd, {
			subagent_type: "verify",
			description: "跑测试",
			prompt: "跑一遍这个项目的测试，报告结果。",
		});
		const elapsed = ((Date.now() - started) / 1000).toFixed(1);
		if (!task) say(`${RED}没有派出去：${parent.errors.join("；") || parent.text || "（原因不明）"}${OFF}`);
		else if (task.state !== "done") say(`${RED}子智能体 ${task.state}${task.error ? `：${task.error}` : ""}${OFF}`);

		const out = task?.output as VerifyOutput | undefined;
		const named = out?.failures?.some((f) => /trailing comma/i.test(`${f.name} ${f.message}`)) ?? false;
		const ratio = fullLog.length > 0 ? ((delivered.length / fullLog.length) * 100).toFixed(0) : "?";

		say(`完整日志        ${fullLog.length} 字符`);
		say(`父会话收到      ${delivered.length} 字符  ${DIM}(${ratio}%)${OFF}`);
		say(`passed          ${out?.passed === false ? `${GREEN}false ✓${OFF}` : `${RED}${String(out?.passed)} ✗${OFF}`}`);
		say(`failures        ${out?.failures?.length ?? 0} 条  ${named ? `${GREEN}说对了是哪条${OFF}` : `${RED}没说对是哪条${OFF}`}`);
		for (const f of out?.failures ?? [])
			say(`${DIM}                  · ${f.name ?? "?"}${f.location ? ` @ ${f.location}` : ""}: ${(f.message ?? "").slice(0, 80)}${OFF}`);
		if (task?.warnings?.length) say(`${RED}结构问题        ${task.warnings.join("; ")}${OFF}`);
		/*
		 * 摘要里的计数对不对：报成「0 过 1 挂」而实际 30 过 1 挂，这样一个说错的摘要比完整日志更糟，父会话会照着它做决定。
		 */
		const countsRight = /\b30\b/.test(out?.summary ?? "") && /\b1\b/.test(out?.summary ?? "");
		say(`summary         ${DIM}${out?.summary ?? "（没有）"}${OFF}  ${countsRight ? `${GREEN}计数对${OFF}` : `${RED}计数错（该是 30 过 1 挂）${OFF}`}`);
		say(`耗时            ${elapsed}s`);
		say();
		const ok = out?.passed === false && named && countsRight && delivered.length > 0 && delivered.length < fullLog.length / 3;
		say(ok ? `${GREEN}✓ 父会话拿到的是摘要，不是日志${OFF}` : `${RED}✗ 委派没省下东西，或者摘要说错了${OFF}`);
		say();
	} finally {
		await agent.close();
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

await main();
