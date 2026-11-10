/**
 * 结构视图和 edit 合在一起，在真文件上、经真工具跑。
 *
 *   node --experimental-transform-types test/tool-eval/integration-eval.ts [<供应商 id>/<模型 id>]
 *
 * 两样各自量过还不够：结构视图把函数体折起来，而改一段折起来的函数体按设计会被 edit 拒掉（上一次读没读全）——
 * 所以最明显的风险是，两个单看都好的功能一碰到一起，每次都多花一个来回。
 *
 * 这里跑真实的 agent（`evalAgent`：plume.tools 的 read 和 edit、plume.prompt 的系统提示词），在这个仓库里一份真文件的副本上，
 * 数它花了多少。
 */

import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EvalAgent, evalAgent } from "./agent.ts";
import { loadModel } from "./model.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface Task {
	id: string;
	/** 拷进一个临时目录：仓库本身永远不碰。 */
	source: string;
	instruction: string;
	/** 改完以后文件必须满足这个。 */
	expect: (content: string) => boolean;
	/** ……而且还得满足这个：不能靠把文件改坏来「通过」。 */
	intact: (content: string) => boolean;
}

const TASKS: Task[] = [
	{
		id: "top-level-const",
		source: "packages/builtin/tools/src/tools/read.ts",
		instruction: "把 DEFAULT_LIMIT 从 2000 改成 1500，其他都别动。",
		expect: (c) => /const DEFAULT_LIMIT = 1500;/.test(c),
		intact: (c) => /const OUTPUT_BUDGET = 35_400;/.test(c) && c.includes("export const readTool"),
	},
	{
		// 目标在一段折起来的函数体里：会多花一次读的就是这种。
		id: "inside-folded-body",
		source: "packages/builtin/tools/src/tools/grep.ts",
		instruction: "在 describeErrors 里，把 `is missing from these results` 这句改成 `is not in these results`。",
		expect: (c) => c.includes("is not in these results") && !c.includes("is missing from these results"),
		intact: (c) => c.includes("export const grepTool") && c.includes("function describeErrors"),
	},
	{
		id: "two-places",
		source: "packages/builtin/tools/src/tools/grep.ts",
		instruction: "两处改动：MAX_MATCHES 从 200 改成 150；ERROR_LINES_KEPT 从 3 改成 5。",
		expect: (c) => /MAX_MATCHES = 150;/.test(c) && /ERROR_LINES_KEPT = 5;/.test(c),
		intact: (c) => c.includes("export const grepTool") && /MAX_OUTPUT_CHARS = 12_000;/.test(c),
	},
];

async function runTask(agent: EvalAgent, task: Task) {
	const cwd = await mkdtemp(join(tmpdir(), "plume-integration-"));
	const name = basename(task.source);
	await copyFile(join(ROOT, task.source), join(cwd, name));
	try {
		const turn = await agent.run(cwd, `文件 ${name}。${task.instruction}`, { maxSteps: 8 });
		const reads = turn.calls.filter((c) => c.name === "read").length;
		const edits = turn.calls.filter((c) => c.name === "edit");
		const steps = turn.messages.filter((m) => m.role === "assistant").length;
		const content = await readFile(join(cwd, name), "utf8");
		return {
			passed: task.expect(content),
			intact: task.intact(content),
			reads,
			edits: edits.length,
			failedEdits: edits.filter((c) => c.isError).length,
			steps,
			errors: turn.errors,
		};
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const model = await loadModel(process.argv[2]);
	const agent = await evalAgent({ model, tools: ["read", "edit"] });
	try {
		console.log(`模型 ${model.model.id} · 真实文件 · 真实 read/edit\n`);
		console.log(`${"任务".padEnd(22)} ${"结果".padEnd(8)} ${"read".padStart(5)} ${"edit".padStart(5)} ${"失败".padStart(5)} ${"轮次".padStart(5)}`);
		console.log("-".repeat(62));

		let passed = 0;
		for (const task of TASKS) {
			const r = await runTask(agent, task);
			const ok = r.passed && r.intact;
			if (ok) passed += 1;
			const verdict = r.passed ? (r.intact ? "✓" : "✗ 改坏了文件") : "✗ 没改对";
			console.log(
				`${task.id.padEnd(22)} ${verdict.padEnd(8)} ${String(r.reads).padStart(5)} ${String(r.edits).padStart(5)} ${String(r.failedEdits).padStart(5)} ${String(r.steps).padStart(5)}`,
			);
			for (const error of r.errors) console.log(`  出错：${error}`);
		}

		console.log("-".repeat(62));
		console.log(`${passed}/${TASKS.length} 通过`);
		console.log("\nread 次数 > 1 说明结构视图折叠了目标，agent 补读了一次——这是设计意图，代价是一个来回。");
	} finally {
		await agent.close();
	}
}

await main();
