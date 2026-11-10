/**
 * 模型会不会为对的事调 `learn`，又会不会为不该记的事放过它？
 *
 *   node --experimental-transform-types test/tool-eval/memory-eval.ts [模型 id]
 *
 * 两种失败，第二种才危险：
 *
 *   从来不调。功能等于没有；用户只会发现自己一直在重复同一句话，而且会怪模型，不会想到少了一次工具调用。
 *
 *   为会过期的事实调。「`parseFrontmatter` 在 skills/loader.ts 里」今天是真的，从此进这个项目的每一次请求，
 *   下一次重构以后悄悄变成错的。一条过时的记忆比没有更糟，因为它会被相信——所以「不该记」的探针和「该记」的一样重。
 *
 * 另外量的是：记下的那条到了下一个会话，到底有没有改变行为。这是整件事的承诺，也是单元测试够不着的那部分。
 *
 * 跑的是 plume.memory 插件本身：`learn` 写进插件数据目录里这个项目的 `learned.md`，下一个会话由插件经 `model.context` 注入。
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginSource } from "../../scripts/plugin-source.ts";
import { evalAgent } from "./agent.ts";
import { loadModel } from "./model.ts";

const { default: memory } = await pluginSource("memory/src/index.ts");
const { memoryHome, projectDir } = await pluginSource("memory/src/paths.ts");
const { recordLesson } = await pluginSource("memory/src/project-memory.ts");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

interface Probe {
	name: string;
	task: string;
	/** 表现好的模型在这里会不会记。 */
	shouldLearn: boolean;
	/** 为什么，一句话，给报告用。 */
	because: string;
}

const PROBES: Probe[] = [
	{
		name: "用户纠正了做法",
		task: "别用 npm，这个仓库一律用 pnpm，npm 会把 lockfile 搞坏。记住这一点，以后都这样。",
		shouldLearn: true,
		because: "会反复适用的纠正",
	},
	{
		name: "代码里看不出的约定",
		task: "提醒你一下：跑 e2e 之前必须先 `pnpm build:contract`，否则会报一堆看不懂的类型错。这个在 README 里没写。",
		shouldLearn: true,
		because: "从代码看不出来",
	},
	{
		name: "读一个文件回答问题",
		task: "看一下 src/app.ts，告诉我 total 函数是怎么实现的。",
		shouldLearn: false,
		because: "代码结构，读代码就知道，记下来会过期",
	},
	{
		name: "一次性的任务状态",
		task: "我现在在调试一个登录的问题，先帮我看看 src/app.ts 有没有语法错误。",
		shouldLearn: false,
		because: "这一次任务的临时状态",
	},
];

/** 临时目录在 macOS 上经软链（/var → /private/var）：用真实路径，会话的工作目录和记忆按目录归档才对得上。 */
async function scratchProject(prefix: string): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function main(): Promise<void> {
	const model = await loadModel(process.argv[2]);
	const modelId = model.model.id;

	console.log(`\n${BOLD}项目记忆 · ${modelId}${OFF}\n`);
	console.log(`${"探针".padEnd(22)} ${"该记".padEnd(6)} ${"记了".padEnd(6)} 判定`);
	console.log("-".repeat(64));

	let ok = 0;
	for (const probe of PROBES) {
		const cwd = await scratchProject("plume-mem-proj-");
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(join(cwd, "src", "app.ts"), "export function total(items: number[]) {\n\treturn items.reduce((a, b) => a + b, 0);\n}\n", "utf8");

		const agent = await evalAgent({ model, plugins: [memory], tools: ["read", "bash", "learn"] });
		try {
			const turn = await agent.run(cwd, probe.task, { maxSteps: 4 });
			const learned = turn.calls.some((call) => call.name === "learn");
			const correct = learned === probe.shouldLearn;
			if (correct) ok += 1;
			console.log(
				`${probe.name.padEnd(20)} ${(probe.shouldLearn ? "是" : "否").padEnd(7)} ${(learned ? "是" : "否").padEnd(7)} ` +
					`${correct ? `${GREEN}✓${OFF}` : probe.shouldLearn ? `${RED}✗ 漏了${OFF}` : `${RED}✗ 记了不该记的${OFF}`}  ${DIM}${probe.because}${OFF}`,
			);
			if (turn.errors.length > 0) console.log(`${DIM}   出错：${turn.errors.join("；").slice(0, 160)}${OFF}`);
		} finally {
			await agent.close();
			await rm(cwd, { recursive: true, force: true }).catch(() => {});
		}
	}
	console.log("-".repeat(64));
	console.log(`${ok}/${PROBES.length} 正确\n`);

	// -------------------------------------------------------------------------
	// 承诺本身：记下的一条，会不会改变下一个会话？
	// -------------------------------------------------------------------------
	console.log(`${BOLD}下一个会话会不会照做${OFF}\n`);

	const cwd = await scratchProject("plume-mem-carry-");
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest" } }, null, 2), "utf8");

	const question = "这个项目要装依赖，我该跑哪条命令？只回答命令，不要执行。";
	/*
	 * 这一组故意不给 `bash`。
	 *
	 * 给了的话，模型会直接去跑安装而不是说出来——回复是空的，对照什么也没量到。这里比的是它「说」命令是什么，
	 * 所以唯一的说法只能是文字。
	 */
	const agent = await evalAgent({ model, plugins: [memory], tools: ["read"] });
	try {
		for (const withMemory of [false, true]) {
			// 写进插件数据目录里这个项目的 `learned.md`，和 `learn` 写的是同一处；新会话由插件读进提示词。
			if (withMemory)
				await recordLesson(projectDir(agent.pluginDataDir("plume.memory"), memoryHome(cwd)), {
					text: "这个仓库一律用 pnpm，绝对不要用 npm——npm 会把 lockfile 搞坏。",
				});

			const turn = await agent.run(cwd, question, { maxSteps: 3 });
			const answer = turn.text;
			if (!answer.trim()) {
				console.log(
					`  ${DIM}诊断：停下=${turn.stopped} 出错=${turn.errors.join("；") || "无"} 消息数=${turn.messages.length} 角色=${turn.messages.map((m) => m.role).join(",")}${OFF}`,
				);
			}
			const usedPnpm = /pnpm i(nstall)?\b|pnpm\b/.test(answer);
			const usedNpm = /\bnpm i(nstall)?\b/.test(answer);
			const line =
				answer
					.split("\n")
					.find((l) => /npm|pnpm|yarn/.test(l))
					?.trim() ?? `(没提到包管理器) ${answer.slice(0, 80).replace(/\n/g, " ")}`;

			console.log(`  ${withMemory ? `${GREEN}记过之后${OFF}` : `${RED}没有记忆${OFF}`}  ${DIM}${line.slice(0, 60)}${OFF}`);
			console.log(`    ${usedPnpm && !usedNpm ? `${GREEN}✓ pnpm${OFF}` : usedNpm ? `${RED}✗ 用了 npm${OFF}` : `${DIM}? 说不清${OFF}`}\n`);
		}
	} finally {
		await agent.close();
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

await main();
