/**
 * 一轮里只调 todo 的比例 ≤ 5%。
 *
 *   node --experimental-transform-types test/tool-eval/todo-only-eval.ts [<供应商 id>/<模型 id>]
 *
 * 清单是执行状态，不是记事本：一次回复只调 `todo_write`，等于白白多一次往返。plume.todo 的工具说明里写着别让它成为一次回复里
 * 唯一的调用，单独调时结果末尾还会再提醒一句。这里用三个天然会列清单的多步任务，数每一条助手消息里的工具调用：全是
 * `todo_write` 的那条算「solo」。比例 = solo 条数 / 有工具调用的条数。
 *
 * 跑真实的 agent（plume.todo、plume.tools 的 read 和 edit、plume.prompt 的系统提示词）；bash 换成记录器，命令不真跑，
 * 测试一律当作通过——评测不该真的装东西、跑东西。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin, PluginEntry } from "../../packages/contract/src/index.ts";
import todo from "../../packages/builtin/todo/src/index.ts";
import { BUILTINS } from "../../packages/core/agent/test/builtins.ts";
import { evalAgent } from "./agent.ts";
import { loadModel } from "./model.ts";

const say = (line = "") => process.stderr.write(`${line}\n`);
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

async function fixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-todo-"));
	await mkdir(join(dir, "src"), { recursive: true });
	await mkdir(join(dir, "test"), { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "probe", type: "module", scripts: { test: "node --test" } }, null, 2));
	await writeFile(
		join(dir, "src", "util.ts"),
		"// TODO: add is too permissive, reject NaN\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
	);
	await writeFile(
		join(dir, "src", "a.ts"),
		'import { add } from "./util.ts";\n\n// TODO: total should skip undefined entries\nexport function total(xs: number[]): number {\n\treturn xs.reduce((s, x) => add(s, x), 0);\n}\n',
	);
	await writeFile(
		join(dir, "src", "b.ts"),
		'import { add } from "./util.ts";\n\n// TODO: step should default to 1\nexport function step(n: number, step: number): number {\n\treturn add(n, step);\n}\n',
	);
	await writeFile(
		join(dir, "test", "util.test.ts"),
		'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/util.ts";\n\ntest("add", () => assert.equal(add(1, 2), 3));\n',
	);
	return dir;
}

/** 换掉 plume.tools 的 bash：只记下命令。 */
const recordingBash: Plugin = {
	name: "eval.recording-bash",
	apply(ctx) {
		ctx.tools.register({
			name: "bash",
			description: "Run a shell command in the project directory.",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
			async execute() {
				return { output: "ok\n（评测环境：已记录，未执行；测试视为通过）" };
			},
		});
	},
};

const TASKS = [
	"把 src/util.ts 里的 add 函数改名为 sum，并把 src/a.ts、src/b.ts 和 test/util.test.ts 里的调用点都改过来，最后跑一下测试。",
	"给 src/util.ts 加 clamp(x, lo, hi) 和 lerp(a, b, t) 两个函数，各写一条简单的测试到 test/util.test.ts，然后跑测试。",
	"src/a.ts、src/b.ts、src/util.ts 里各有一个 TODO 注释，逐个把它们处理掉（改代码、删掉注释），处理完跑测试。",
];

async function main(): Promise<void> {
	const model = await loadModel(process.argv[2]);
	const builtins: PluginEntry[] = [...BUILTINS, { key: todo.name, builtin: true, load: async () => todo }];
	const agent = await evalAgent({ model, builtins, plugins: [recordingBash], tools: ["todo_write", "read", "edit", "bash"] });

	say(`\n一轮里只有 todo 的比例 · ${model.model.id}\n`);
	let toolTurns = 0;
	let soloTurns = 0;
	let todoTurns = 0;
	try {
		for (const [i, task] of TASKS.entries()) {
			const cwd = await fixture();
			try {
				const result = await agent.run(cwd, task, { maxSteps: 14 });
				for (const error of result.errors) say(`  ${RED}出错：${error}${OFF}`);
				let turns = 0;
				let solo = 0;
				let withTodo = 0;
				const shapes: string[] = [];
				for (const message of result.messages) {
					if (message.role !== "assistant") continue;
					const names = message.content.flatMap((c) => (c.type === "toolCall" ? [c.name] : []));
					if (names.length === 0) continue;
					turns += 1;
					const onlyTodo = names.every((n) => n === "todo_write");
					if (names.includes("todo_write")) withTodo += 1;
					if (onlyTodo) solo += 1;
					shapes.push(onlyTodo ? `${RED}[todo]${OFF}` : names.includes("todo_write") ? `${GREEN}[todo+${names.length - 1}]${OFF}` : `[${names.length}]`);
				}
				toolTurns += turns;
				soloTurns += solo;
				todoTurns += withTodo;
				say(`任务 ${i + 1}：${turns} 条有工具调用，其中 ${solo} 条只有 todo，${withTodo} 条带 todo   ${DIM}${shapes.join(" ")}${OFF}`);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		}
	} finally {
		await agent.close();
	}
	const ratio = toolTurns === 0 ? 0 : soloTurns / toolTurns;
	say("");
	say(`合计：${toolTurns} 条里 ${soloTurns} 条只有 todo —— ${(ratio * 100).toFixed(1)}%${ratio <= 0.05 ? ` ${GREEN}≤ 5% ✓${OFF}` : ` ${RED}> 5% ✗${OFF}`}`);
	if (todoTurns === 0) say(`${DIM}模型一次都没用 todo：比例是 0，但那是「没用」不是「用得好」——这个任务集或这个模型量不出这条。${OFF}`);
	say();
}

await main();
