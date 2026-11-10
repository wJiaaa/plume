/**
 * 记忆和代码冲突时，模型选代码。
 *
 *   node --experimental-transform-types test/tool-eval/memory-conflict-eval.ts [模型 id]
 *
 * 记忆会过期：三个月前记下「这个仓库用 npm」，后来换成了 pnpm——lockfile 和 package.json 里的 packageManager 都说明了这一点。
 * 一条过期的记忆比没有这条更糟，因为模型会照着它做决定。这里放一条明确过期的项目记忆，让模型去装依赖跑测试，
 * 看它第一个包管理器命令用的是哪个。
 *
 * 对照组没有那条记忆——如果连对照组都用 npm，那问题不在记忆，而在模型不看 lockfile。
 *
 * 记忆经 plume.memory 插件注入：过期的那条写进插件数据目录里这个项目的 `learned.md`（带三个月前的时间戳），
 * 系统提示词里那一段由插件按它组出来，和应用里看到的一样。`bash` 换成记录器（同名工具后登记的生效）：只读命令真跑，
 * 包管理器命令只记下——评测不该真的装东西。重复次数用环境变量 `MEMCONF_REPS`，默认 2。
 */

import { execFileSync, execSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "../../packages/contract/src/index.ts";
import { pluginSource } from "../../scripts/plugin-source.ts";
import { evalAgent } from "./agent.ts";
import { loadModel } from "./model.ts";

const { default: memory } = await pluginSource("memory/src/index.ts");
const { memoryHome, projectDir } = await pluginSource("memory/src/paths.ts");
const { writeLessons } = await pluginSource("memory/src/project-memory.ts");

const say = (line = "") => process.stderr.write(`${line}\n`);
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

async function fixture(): Promise<string> {
	// 真实路径：macOS 的临时目录经软链，记忆按目录归档，两边得是同一个路径。
	const dir = await realpath(await mkdtemp(join(tmpdir(), "plume-memconf-")));
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(
		join(dir, "package.json"),
		JSON.stringify(
			{ name: "probe", version: "1.0.0", packageManager: "pnpm@9.12.0", scripts: { test: "node --test" }, devDependencies: { "some-lib": "^1.0.0" } },
			null,
			2,
		),
	);
	await writeFile(
		join(dir, "pnpm-lock.yaml"),
		"lockfileVersion: '9.0'\n\nimporters:\n  .:\n    devDependencies:\n      some-lib:\n        specifier: ^1.0.0\n        version: 1.0.0\n",
	);
	await writeFile(join(dir, "src", "index.ts"), "export const answer = 42;\n");
	await writeFile(join(dir, "README.md"), "# probe\n\n跑 `pnpm test` 即可。\n");
	// 一个真的仓库：系统提示词的环境段照实说「是 git 仓库」。
	execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
}

/** 只读命令真的跑，包管理器命令只记录——评测不该真的装东西。 */
function recordingBash(commands: string[]): Plugin {
	return {
		name: "eval.recording-bash",
		apply(ctx) {
			ctx.tools.register({
				name: "bash",
				description: "Run a shell command in the project directory.",
				parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				async execute(args, run) {
					const command = String(args.command ?? "");
					commands.push(command);
					if (/^\s*(ls|cat|head|find|grep|pwd|wc)\b/.test(command) && !/[|;&`$]/.test(command)) {
						try {
							return { output: execSync(command, { cwd: run.cwd, encoding: "utf8", timeout: 5000 }) || "(空)" };
						} catch (error) {
							return { output: `exit 1\n${error instanceof Error ? error.message : String(error)}` };
						}
					}
					return { output: "ok\n（评测环境：这条命令已记录，没有真的执行）" };
				},
			});
		},
	};
}

const STALE = [{ text: "这个仓库用 npm 装依赖和跑测试（npm install / npm test）。", at: Date.now() - 90 * 86400000 }];

async function runOnce(model: Awaited<ReturnType<typeof loadModel>>, withMemory: boolean) {
	const cwd = await fixture();
	const commands: string[] = [];
	const agent = await evalAgent({ model, plugins: [memory, recordingBash(commands)], tools: ["read", "bash"] });
	try {
		if (withMemory) await writeLessons(projectDir(agent.pluginDataDir("plume.memory"), memoryHome(cwd)), STALE);
		const turn = await agent.run(cwd, "把依赖装上，然后跑一遍测试。", { maxSteps: 6 });
		const first = commands.find((c) => /\b(npm|pnpm|yarn|bun)\b/.test(c)) ?? null;
		return { first, commands, answer: turn.text.replace(/\s+/g, " "), tools: turn.calls.map((call) => call.name), errors: turn.errors };
	} finally {
		await agent.close();
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

function verdict(first: string | null): "code" | "memory" | "none" {
	if (!first) return "none";
	if (/\bpnpm\b/.test(first)) return "code";
	if (/\bnpm\b/.test(first)) return "memory";
	return "none";
}

async function main(): Promise<void> {
	const model = await loadModel(process.argv[2]);
	const REPS = Number(process.env.MEMCONF_REPS ?? 2);
	say(`\n记忆与代码冲突时选谁 · ${model.model.id}\n`);
	say(`${"组".padEnd(10)} ${"第一个包管理器命令".padEnd(36)} 判定`);
	say("-".repeat(70));
	const tally = { stale: { code: 0, memory: 0, none: 0 }, clean: { code: 0, memory: 0, none: 0 } };
	for (const withMemory of [true, false]) {
		for (let rep = 1; rep <= REPS; rep++) {
			const { first, commands, answer, tools, errors } = await runOnce(model, withMemory);
			const v = verdict(first);
			tally[withMemory ? "stale" : "clean"][v] += 1;
			const word = v === "code" ? `${GREEN}选了代码（pnpm）${OFF}` : v === "memory" ? `${RED}跟了过期记忆（npm）${OFF}` : `${DIM}没跑包管理器${OFF}`;
			say(`${(withMemory ? "有过期记忆" : "对照·无记忆").padEnd(8)} ${(first ?? "—").slice(0, 36).padEnd(36)} ${word}`);
			say(`${DIM}     工具：${tools.join(" → ") || "(无)"}   命令：${commands.join(" ; ").slice(0, 80) || "(无)"}${OFF}`);
			if (!first) say(`${DIM}     模型说：${answer.slice(0, 200)}${errors.length ? `  出错：${errors.join("；").slice(0, 120)}` : ""}${OFF}`);
		}
	}
	say("-".repeat(70));
	say(`有过期记忆：选代码 ${tally.stale.code}/${REPS}，跟记忆 ${tally.stale.memory}/${REPS}；对照：选代码 ${tally.clean.code}/${REPS}`);
	if (tally.stale.memory > 0) say(`${RED}过期记忆能把模型带偏——注入时的措辞（「和代码矛盾时以代码为准」）需要加强，或记忆需要过期标记。${OFF}`);
	if (tally.clean.code < REPS) say(`${DIM}对照组也没全选 pnpm：这个模型本来就不太看 lockfile，冲突那条的结论要打折。${OFF}`);
	say();
}

await main();
