/**
 * 改道之后，模型会不会真的换工具？
 *
 *   node --experimental-transform-types test/tool-eval/reroute-eval.ts [<供应商 id>/<模型 id>]
 *
 * 改道存在的理由是：一个工具结果比提示词里的一句劝告有效。这里验它：同一个诱人用 `cat` 的任务，对照组只有劝告
 * （bash 的说明和系统提示词里都有「用 read 别用 cat」），实验组是产品本来的 bash——无歧义的 `cat`/`ls`/`rg` 当场改用
 * read、ls、grep 执行并在结果末尾注明下次直接用哪个，其余等价调用拦下报错。看两件事：模型第一反应是不是裸的 shell 命令
 * （劝告有没有用），以及被改道之后有没有换成专用工具（改道有没有用）。
 *
 * 两组的 read/grep/glob/ls 都是 plume.tools 的真工具，在一个临时目录里跑。实验组的 bash 就是 plume.tools 的 bash；
 * 对照组的 bash 换成一个同说明、同参数的记录器（同名工具后登记的生效），命令不真跑，回一段像样的输出。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "../../packages/contract/src/index.ts";
import { bashTool } from "../../packages/builtin/tools/src/tools/bash.ts";
import { rerouteShellCommand, translatedShellCommand } from "../../packages/builtin/tools/src/tools/reroute.ts";
import { type EvalAgent, evalAgent } from "./agent.ts";
import { loadModel } from "./model.ts";

const say = (line = "") => process.stderr.write(`${line}\n`);
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

const TASKS = ["看一下 src/parser.ts 的内容，告诉我它导出了什么。", "src/ 目录下有哪些文件？列出来。", "在 src/ 里找一下哪里用到了 parseSettings。"];

const TOOLS = ["read", "grep", "glob", "ls", "bash"];
const AVAILABLE = new Set(TOOLS);

/** plume.tools 的 bash 会改道的命令：当场改用别的工具执行的，和拦下报错的。 */
const isBare = (command: string) => translatedShellCommand(command) !== null || rerouteShellCommand(command, AVAILABLE) !== null;

/** 对照组：说明和参数照搬 bash，命令不跑。 */
const plainBash: Plugin = {
	name: "eval.plain-bash",
	apply(ctx) {
		ctx.tools.register({
			name: "bash",
			description: bashTool.description,
			parameters: bashTool.parameters,
			async execute(args) {
				const command = String(args.command ?? "");
				if (/^\s*cat\b/.test(command)) return { output: "export function parseSettings(raw: string) { return JSON.parse(raw); }" };
				if (/^\s*ls\b/.test(command)) return { output: "loader.ts\nparser.ts" };
				if (/^\s*(grep|rg)\b/.test(command)) return { output: "src/parser.ts:1:export function parseSettings\nsrc/loader.ts:1:import { parseSettings as pc }" };
				return { output: "" };
			},
		});
	},
};

async function fixture(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "plume-reroute-"));
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(join(cwd, "src", "parser.ts"), "export function parseSettings(raw: string) { return JSON.parse(raw); }\n");
	await writeFile(join(cwd, "src", "loader.ts"), "import { parseSettings as pc } from './parser.ts';\nexport const load = (s: string) => pc(s);\n");
	return cwd;
}

async function runOnce(agent: EvalAgent, task: string) {
	const cwd = await fixture();
	try {
		const turn = await agent.run(cwd, task, { maxSteps: 6 });
		const calls = turn.calls;
		const bare = calls.filter((c) => c.name === "bash" && isBare(String(c.args.command ?? "")));
		const firstBare = calls.findIndex((c) => c.name === "bash" && isBare(String(c.args.command ?? "")));
		const switchedAfter = firstBare >= 0 && calls.slice(firstBare + 1).some((c) => c.name !== "bash");
		// plume.tools 当场改用专用工具执行时，结果末尾有这一句。
		const translated = bare.filter((c) => /\[Executed with \w+; use that tool directly next time\.\]/.test(c.output)).length;
		return { bare: bare.length, translated, firstBare: firstBare >= 0, switchedAfter, total: calls.length, errors: turn.errors };
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const model = await loadModel(process.argv[2]);
	const control = await evalAgent({ model, tools: TOOLS, plugins: [plainBash] });
	const treated = await evalAgent({ model, tools: TOOLS });
	try {
		say(`\n改道之后，模型会不会换工具 · ${model.model.id}\n`);
		say(`${"任务".padEnd(28)} ${"对照：裸调用".padEnd(14)} ${"实验：裸调用→换了".padEnd(20)}`);
		say("-".repeat(70));

		let baselineBare = 0;
		let rerouteBare = 0;
		let translatedBare = 0;
		let switched = 0;
		for (const task of TASKS) {
			const c = await runOnce(control, task);
			const t = await runOnce(treated, task);
			baselineBare += c.bare;
			rerouteBare += t.bare;
			translatedBare += t.translated;
			if (t.firstBare && t.switchedAfter) switched += 1;

			const ctl = c.bare > 0 ? `${RED}${c.bare} 次${OFF}` : `${GREEN}0${OFF}`;
			const how = t.translated > 0 ? `${DIM}（${t.translated} 次当场改用专用工具执行）${OFF}` : "";
			const trt = t.firstBare ? (t.switchedAfter ? `${GREEN}改道→换了${OFF}` : `${RED}改道→没换${OFF}`) : `${DIM}没碰 bash${OFF}`;
			say(`${task.slice(0, 26).padEnd(28)} ${ctl.padEnd(23)} ${trt}${how}`);
			for (const error of [...c.errors, ...t.errors]) say(`  ${RED}出错：${error}${OFF}`);
		}

		say("-".repeat(70));
		say(
			`对照组（只有提示词劝告）：${baselineBare} 次裸调用 · 实验组：${rerouteBare} 次被改道（其中 ${translatedBare} 次当场改用专用工具执行），${switched} 个任务之后换成了专用工具`,
		);
		if (baselineBare === 0) say(`${DIM}对照组一次裸调用都没有——这个模型光看提示词就够了，改道在它身上量不出差别。${OFF}`);
		say();
	} finally {
		await control.close();
		await treated.close();
	}
}

await main();
