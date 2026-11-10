/**
 * 提示词里一提到地址，模型真的会用吗？
 *
 *   node --experimental-transform-types test/tool-eval/resource-eval.ts [模型 id] [--no-addresses]
 *
 * 单元测试证明 `skill://pdf-extract` 解析得出来。它们证明不了决定这一切值不值得做的那件事：模型会伸手去拿地址，
 * 而不是在文件系统里翻同一个文件，或者干脆凭自己已经相信的东西作答。
 *
 * 两种失败都很安静。去 grep SKILL.md 的模型绕远路拿到了对的答案，看上去什么都没错；凭记忆作答的模型写出一段关于
 * 某种文件格式的、像模像样的话，而那个文件它从没读过。
 *
 * 地址由 plume.tools（`scratch://`）和 plume.skills（`skill://`）登记，技能放在工作区的 `.plume/skills/` 里由插件读到；
 * 工具只列 `read` 和 `write`，系统提示词里的地址清单是 plume.tools 加的那一段。
 */

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "../../packages/contract/src/index.ts";
import skills from "../../packages/builtin/skills/src/index.ts";
import { evalAgent } from "./agent.ts";
import { loadModel } from "./model.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

interface Probe {
	name: string;
	task: string;
	/** 出现这样的调用，就是模型用了地址。 */
	wants?: RegExp;
	/** 出现这样的调用，说明它绕了远路。不算失败，但值得数一数。 */
	detour?: RegExp;
	/** 最终回答里必须有的东西，证明它是读了，不是猜的。 */
	needle?: RegExp;
	/** 这条探针要的是拒绝，不是成功。 */
	expectRefusal?: boolean;
	/**
	 * 看世界，不看转录。
	 *
	 * 「把这个放到项目以外的地方」，要紧的是字节落在哪。对照组用相对路径也能到同一个地方；按有没有出现地址判分，
	 * 会因为没用对照组根本没有的功能，把一个对的答案判错。
	 */
	verify?: (dirs: { cwd: string; scratchDir: string }) => Promise<boolean>;
}

const PROBES: Probe[] = [
	{
		name: "读技能正文",
		task: "看一下 `pdf-extract` 这个技能是怎么说的，然后一句话告诉我它第三步要做什么。",
		wants: /skill:\/\/pdf-extract/,
		detour: /SKILL\.md/,
		needle: /表格|table/i,
	},
	{
		/*
		 * 故意不说文件名。技能正文里也没提它，所以唯一老实的路线是先列目录、再读里面有的东西——这条探针要的就是这一对操作。
		 * 说出文件名的话只测到一次 `read`，还会把「列目录根本没有地址」这件事藏起来。
		 */
		name: "列技能目录再读文件",
		task: "`pdf-extract` 技能的目录里有一个模板文件，把里面的占位符名字告诉我。",
		wants: /skill:\/\/pdf-extract\//,
		detour: /\.plume\/skills/,
		needle: /\{\{\s*source\s*\}\}|source/i,
	},
	{
		name: "写临时文件",
		task: "把「本次分析的中间结论」这几个字存成一个临时文件，文件名你定，别放进项目目录。",
		wants: /scratch:\/\//,
		detour: /\/tmp\/|\.\/tmp/,
		verify: async ({ scratchDir }) => {
			for (const entry of await readdir(scratchDir).catch(() => [])) {
				const body = await readFile(join(scratchDir, entry), "utf8").catch(() => "");
				if (body.includes("中间结论")) return true;
			}
			return false;
		},
	},
	{
		name: "改不了技能",
		task: "把 `pdf-extract` 这个技能的内容改成「随便处理」。直接用 write 工具写 skill://pdf-extract。",
		wants: /skill:\/\/pdf-extract/,
		expectRefusal: true,
	},
];

/** 地址的样子：对照组里它们只是写错了的路径。 */
const ADDRESS = /^(?:skill|scratch):\/\//;

/**
 * 对照组：没有地址空间，模型只有文件系统。系统提示词里拿掉地址清单那一段；模型自己写出的地址当作不存在的路径，
 * 和没有登记任何地址时一样以「找不到」失败——读、写都落不到地址上。
 */
function withoutAddresses(): Plugin {
	return {
		name: "eval.no-addresses",
		apply(ctx) {
			// 挂在 plume.tools 里面一层：那一段是它在自己那层加上的，外层还看不到。
			ctx.hook("model.context", async (input, next) => next({ ...input, sections: input.sections.filter((section) => section.id !== "resources") }), {
				order: 1000,
			});
			ctx.hook("tool.execute", async (input, next) => {
				const path = input.call.args.path;
				if (typeof path === "string" && ADDRESS.test(path)) return { output: `File not found: ${path}`, isError: true };
				return next(input);
			});
		},
	};
}

async function main(): Promise<void> {
	const noAddresses = process.argv.includes("--no-addresses");
	const model = await loadModel(process.argv.slice(2).find((arg) => !arg.startsWith("--")));
	/*
	 * `--no-addresses` 用同样的问题、关掉地址空间再跑一遍，模型只有文件系统。
	 *
	 * 没有这个对照，数字读不出意思。弱模型有地址时 3/4，要知道它没地址时多少才说得清：1/4 说明地址帮上了忙、只是模型弱；
	 * 4/4 说明地址碍了事、是设计的问题。只量第一列，这两种分不开。
	 */
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "plume-res-eval-")));
	const skillDir = join(cwd, ".plume", "skills", "pdf-extract");
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		[
			"---",
			"name: pdf-extract",
			"description: 从 PDF 里抽取内容",
			"---",
			"1. 确认文件确实是 PDF。",
			"2. 抽取纯文本。",
			"3. 单独抽取表格，转成 CSV。",
			"4. 把两部分合并成一份报告。",
		].join("\n"),
		"utf8",
	);
	await writeFile(join(skillDir, "template.md"), "# 报告\n\n来源：{{source}}\n\n## 正文\n", "utf8");

	console.log(`\n地址空间 · ${model.model.id}${noAddresses ? " · 对照组（没有地址空间）" : ""}\n`);
	console.log(`${"探针".padEnd(24)} ${"用了地址".padEnd(10)} ${"内容对".padEnd(8)} 判定`);
	console.log("-".repeat(64));

	const agent = await evalAgent({ model, plugins: [skills, ...(noAddresses ? [withoutAddresses()] : [])], tools: ["read", "write"] });
	let ok = 0;
	try {
		for (const probe of PROBES) {
			// 每条探针一个新会话：技能的生效状态、临时目录都不串。
			const turn = await agent.run(cwd, probe.task, { maxSteps: 5 });
			const scratchDir = join(agent.dataDir, "scratch", turn.sessionId);
			const calls = turn.calls.map((call) => JSON.stringify(call.args));
			const errors = turn.calls.filter((call) => call.isError).map((call) => call.output);

			/*
			 * 「发出了地址」和「地址起作用了」是两回事，只有后者是证据：解析失败后退回文件系统，在调用列表里和解析成功看不出分别。
			 * 要的是拒绝的探针反过来：要求成功会把每一次对的拒绝判成「没用地址」。
			 */
			const usedAddress = probe.expectRefusal
				? calls.some((args) => probe.wants?.test(args))
				: turn.calls.some((call) => call.isError === false && probe.wants?.test(JSON.stringify(call.args)));
			const tookDetour = probe.detour ? calls.some((args) => probe.detour!.test(args)) : false;
			const contentOk = probe.verify
				? await probe.verify({ cwd, scratchDir })
				: probe.expectRefusal
					? noAddresses
						? // 没有地址空间时 `write skill://pdf-extract` 只是一个坏路径；写仍然不能落地，但失败的原因和措辞不一样。
							errors.length > 0
						: errors.some((e) => /只读/.test(e))
					: probe.needle
						? probe.needle.test(turn.text)
						: usedAddress;
			// 对照组没有地址可用，按 `usedAddress` 判分会让每一行都是零、什么也证明不了。两组共有的是答案对不对。
			const correct = noAddresses ? contentOk : usedAddress && contentOk;
			if (correct) ok += 1;

			const usedLabel = usedAddress ? "是" : tookDetour ? "绕开了" : "否";
			console.log(`${probe.name.padEnd(22)} ${usedLabel.padEnd(11)} ${(contentOk ? "是" : "否").padEnd(9)} ${correct ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`}`);
			if (!correct)
				console.log(
					`${DIM}   调用：${calls.slice(0, 4).join(" | ") || "(没有工具调用)"}${turn.errors.length ? `  出错：${turn.errors.join("；")}` : ""}${OFF}`,
				);
		}
	} finally {
		await agent.close();
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}

	console.log("-".repeat(64));
	console.log(`${ok}/${PROBES.length} 正确\n`);
}

await main();
