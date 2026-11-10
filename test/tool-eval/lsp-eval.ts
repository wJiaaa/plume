/**
 * 语言服务器找不找得到文本搜索找不到的东西，agent 又会不会去用它？
 *
 *   node --experimental-transform-types test/tool-eval/lsp-eval.ts [模型 id]
 *
 * 前提是一个具体的、不出声的失败。`grep parseConfig` 看不到这里：
 *
 *     import { parseConfig as pc } from "./core.ts";
 *     return pc(text);                                 // ← 这一行里没有 "parseConfig"
 *
 * 照着这个 grep 做的重命名改掉了它找到的每一行，看起来改完了，`pc` 却指向一个已经不存在的函数。改的时候什么都不报错。
 *
 * 所以要量两件事，而且分开量：工具找不找得到别名调用点（机制），以及被要求重命名时模型会不会真的去用它、而不是用 grep（行为）。
 * 决定这东西有没有用的是后一个。机制部分直接调 plume.lsp 的工具（`lspTool`，和插件注册的是同一个），读取授权和文件清单用
 * plume.tools 的实现；行为部分经 `evalAgent` 跑真实的一轮，一组装 plume.lsp、一组不装。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRun } from "../../packages/contract/src/index.ts";
import { grepTool } from "../../packages/builtin/tools/src/tools/grep.ts";
import { gitListedFiles } from "../../packages/builtin/tools/src/tools/project-files.ts";
import { authorizeRead } from "../../packages/builtin/tools/src/tools/read-access.ts";
import { pluginSource } from "../../scripts/plugin-source.ts";
import { evalAgent } from "./agent.ts";
import { loadModel } from "./model.ts";

const { default: lsp } = await pluginSource("lsp/src/index.ts");
const { lspTool } = await pluginSource("lsp/src/lsp-tool.ts");
const { CodeIntelManager } = await pluginSource("lsp/src/manager.ts");

/*
 * 写 stderr，不写 stdout：机制部分不到一秒就跑完，行为部分要等模型。stdout 接到管道时有缓冲，快的那部分结果会一直憋到慢的跑完，
 * 看上去像整个脚本卡住了，而不是其中一部分慢。
 */
const say = (line = "") => process.stderr.write(`${line}\n`);

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

/** 一个项目，那个危险的调用点里没有符号的名字。 */
async function fixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-lsp-"));
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "probe", type: "module" }), "utf8");
	await writeFile(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, allowImportingTsExtensions: true, noEmit: true },
			include: ["src"],
		}),
		"utf8",
	);
	await writeFile(join(dir, "src", "core.ts"), "export function parseConfig(text: string): object {\n\treturn JSON.parse(text);\n}\n", "utf8");
	await writeFile(join(dir, "src", "index.ts"), 'export { parseConfig } from "./core.ts";\n', "utf8");
	// 别名调用点：`pc(text)` 里没有 `parseConfig`。
	await writeFile(
		join(dir, "src", "aliased.ts"),
		'import { parseConfig as pc } from "./core.ts";\n\nexport function load(text: string) {\n\treturn pc(text);\n}\n',
		"utf8",
	);
	await writeFile(
		join(dir, "src", "via-reexport.ts"),
		'import { parseConfig } from "./index.ts";\n\nexport function boot(text: string) {\n\treturn parseConfig(text);\n}\n',
		"utf8",
	);
	return dir;
}

/** 直接调工具时的那一次调用：只给工具读得到的几样。 */
function runFor(cwd: string): ToolRun {
	return {
		sessionId: "lsp-eval",
		toolCallId: "call",
		cwd,
		projectRoots: [],
		scratchDir: join(cwd, ".scratch"),
		signal: new AbortController().signal,
		progress() {},
		ask: async () => "reject",
		permissionMode: async () => "full",
		tools: () => [],
		calls: [],
	};
}

/** 和 plume.lsp 注册的同一个工具，只把语言服务器那一套换成 `manager`。 */
function lspWith(manager: InstanceType<typeof CodeIntelManager>) {
	return lspTool({
		managerFor: () => manager,
		listFiles: gitListedFiles,
		authorizeRead: (run, path) => authorizeRead({ cwd: run.cwd, state: new Map(), projectRoots: run.projectRoots }, path),
	});
}

async function main(): Promise<void> {
	const cwd = await fixture();

	// -------------------------------------------------------------------------
	// 机制：别名调用点找不找得到
	// -------------------------------------------------------------------------
	say(`\n${BOLD}机制：别名调用点找不找得到${OFF}\n`);

	const manager = new CodeIntelManager();
	const started = Date.now();
	const viaLsp = await lspWith(manager).execute({ operation: "references", path: "src/core.ts", symbol: "parseConfig" }, runFor(cwd));
	const lspFoundAlias = /aliased\.ts:4/.test(viaLsp.output);
	const lspConfidence = (viaLsp.details as { confidence?: string } | undefined)?.confidence ?? "?";

	const viaGrep = await grepTool.execute({ pattern: "parseConfig", path: "." }, { cwd, state: new Map() });
	const grepText = viaGrep.content.map((c) => c.text).join("");
	const grepFoundAlias = /aliased\.ts:4/.test(grepText);

	say(`  ${"grep parseConfig".padEnd(24)} ${grepFoundAlias ? `${GREEN}找到了${OFF}` : `${RED}漏了 pc(text)${OFF}`}`);
	say(
		`  ${"lsp references".padEnd(24)} ${lspFoundAlias ? `${GREEN}找到了 pc(text)${OFF}` : `${RED}也漏了${OFF}`}  ${DIM}${lspConfidence} · ${Date.now() - started}ms${OFF}`,
	);
	if (lspConfidence !== "exact") say(`  ${DIM}这次是文本搜索（语言服务器没起来）：${viaLsp.output.split("\n").at(-1)?.slice(0, 80)}${OFF}`);
	await manager.dispose();

	// -------------------------------------------------------------------------
	// 降级：没有语言服务器时，而且得说出来
	// -------------------------------------------------------------------------
	say(`\n${BOLD}降级：没有语言服务器时${OFF}\n`);
	const none = lspWith(new CodeIntelManager([]));
	const degraded = await none.execute({ operation: "references", path: "src/core.ts", symbol: "parseConfig" }, runFor(cwd));
	say(`  ${"仍然给出答案".padEnd(24)} ${/找到 \d+ 处|文本搜索找到/.test(degraded.output) ? `${GREEN}是${OFF}` : `${RED}否${OFF}`}`);
	say(`  ${"说明了这是文本搜索".padEnd(23)} ${/别名导入/.test(degraded.output) ? `${GREEN}是${OFF}` : `${RED}否——这是最危险的情况${OFF}`}`);

	const refusedRename = await none.execute({ operation: "rename", path: "src/core.ts", symbol: "parseConfig", newName: "parseSettings" }, runFor(cwd));
	say(`  ${"拒绝无服务器的重命名".padEnd(22)} ${refusedRename.isError ? `${GREEN}是${OFF}` : `${RED}否——文本重命名正是要防的那件事${OFF}`}`);

	// -------------------------------------------------------------------------
	// 行为：两样都给，模型去拿哪个
	// -------------------------------------------------------------------------
	say(`\n${BOLD}行为：模型会不会去用它——以及没有它时会不会漏${OFF}\n`);

	const model = await loadModel(process.argv[2]);

	/*
	 * 对照：同一个任务、同一个仓库，一组装了 plume.lsp、一组没装，各跑三次。
	 *
	 * 「成功率提升」是相对的说法，只有对照给得出。没有 lsp 时模型只能 grep，而 grep 找不到别名导入 `pc(text)`——那正是这个工具
	 * 存在的理由。三次而不是一次，是因为单次的对错说不清是工具的功劳还是模型那天的状态。
	 */
	const task = "我要把 src/core.ts 里导出的 parseConfig 改个名字。先告诉我一共有哪些地方在用它，一个都不能漏。";
	const REPS = 3;
	const tally = { with: { alias: 0, usedLsp: 0 }, without: { alias: 0, usedLsp: 0 } };
	for (const withLsp of [true, false]) {
		const agent = await evalAgent({
			model,
			plugins: withLsp ? [lsp] : [],
			tools: withLsp ? ["read", "grep", "glob", "lsp"] : ["read", "grep", "glob"],
		});
		try {
			for (let rep = 1; rep <= REPS; rep++) {
				const turn = await agent.run(cwd, task, { maxSteps: 6 });
				const calls = turn.calls.map((call) => call.name);
				const usedLsp = calls.includes("lsp");
				const mentionedAlias = /aliased\.ts|\bpc\b/.test(turn.text);
				const arm = withLsp ? tally.with : tally.without;
				if (usedLsp) arm.usedLsp += 1;
				if (mentionedAlias) arm.alias += 1;
				say(
					`  ${(withLsp ? "有 lsp" : "无 lsp").padEnd(8)} #${rep}  ${(mentionedAlias ? `${GREEN}找到别名调用点${OFF}` : `${RED}漏了 pc(text)${OFF}`).padEnd(28)} ${DIM}${calls.join(" → ") || "(无)"}${OFF}`,
				);
				if (turn.errors.length) say(`  ${RED}出错：${turn.errors.join("；").slice(0, 160)}${OFF}`);
			}
		} finally {
			await agent.close();
		}
	}
	say("");
	say(`  有 lsp：${tally.with.alias}/${REPS} 次找到别名调用点（${tally.with.usedLsp} 次真的调了 lsp）`);
	say(`  无 lsp：${tally.without.alias}/${REPS} 次找到别名调用点`);
	if (tally.with.alias <= tally.without.alias) say(`  ${DIM}这个模型不用 lsp 也能找到，或者有了也没用——工具带来的提升在这里量不出来。${OFF}`);
	say("");

	await rm(cwd, { recursive: true, force: true }).catch(() => {});
}

await main();
