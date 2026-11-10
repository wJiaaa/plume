/**
 * 后台总结会不会记下持久的、放过会过期的？
 *
 *   node --experimental-transform-types test/tool-eval/extract-eval.ts [模型 id]
 *
 * 代价大的失败不是空文件，而是一文件会过期的事实：「parseFrontmatter 在 skills/loader.ts 里」今天是真的，从此进这个项目的
 * 每一次请求，下次重构以后悄悄变成错的——而且会被相信。
 *
 * 所以样本故意把两种混在一起：这几次会话里一半是几个月都成立的约定，另一半是某个函数那一周恰好在哪。
 *
 * 跑的是 plume.memory 的 `extractMemory`（和后台那一遍同一个函数），模型调用经插件拿到的 `ctx.model.complete`，
 * 和插件在应用里走的是同一条路。写出来的 `MEMORY.md` 在临时目录里，跑完删掉。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Plugin, PluginContext } from "../../packages/contract/src/index.ts";
import { pluginSource } from "../../scripts/plugin-source.ts";
import { evalAgent } from "./agent.ts";
import { loadModel } from "./model.ts";

const { extractMemory } = await pluginSource("memory/src/extract.ts");

const say = (line = "") => process.stderr.write(`${line}\n`);
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

function talk(lines: string[]): Message[] {
	return lines.map((text, i) =>
		i % 2 === 0
			? ({ role: "user", content: [{ type: "text", text }], timestamp: 0 } as Message)
			: ({
					role: "assistant",
					content: [{ type: "text", text }],
					api: "anthropic-messages",
					provider: "p",
					model: "m",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 0,
				} as unknown as Message),
	);
}

const SESSIONS = [
	talk([
		"跑 e2e 老是报一堆类型错，看不懂。",
		"这是因为没有先跑 `pnpm build:contract`。契约包是生成的，e2e 依赖它的类型。",
		"果然，跑完就好了。这个能不能写进 README？",
		"可以。不过这个约定目前只在 CI 配置里体现，仓库文档里确实没写。",
	]),
	talk([
		"把 buildSystemPrompt 挪到 packages/core/src/prompt/system.ts 了。",
		"好的，我更新了三处导入。",
		"另外提醒一下，这个仓库的提交 scope 只能用 core、desktop、cli，别的 commitlint 会拒。",
		"明白了。",
	]),
	talk(["又忘了 build:contract，白等了五分钟。", "我记下了。以后跑 e2e 之前我会先确认契约包是新的。", "对了，别用 npm，这仓库只用 pnpm。", "好。"]),
];

/** 持久的：该记。会过期的：不该记。 */
const DURABLE = [
	{ label: "e2e 前要 build:contract", pattern: /build:contract/ },
	{ label: "提交 scope 限 core/desktop/cli", pattern: /scope|commitlint/ },
	{ label: "只用 pnpm", pattern: /pnpm/ },
];
const PERISHABLE = [{ label: "buildSystemPrompt 在哪个文件", pattern: /buildSystemPrompt|prompt\/system\.ts/ }];

/** 拿到插件看到的 `ctx.model`：评测替后台那一遍发请求，用的是同一个宿主实现。 */
function captureModel(found: { model?: PluginContext["model"] }): Plugin {
	return {
		name: "eval.capture-model",
		apply(ctx) {
			found.model = ctx.model;
		},
	};
}

async function main(): Promise<void> {
	const model = await loadModel(process.argv[2]);
	const found: { model?: PluginContext["model"] } = {};
	const agent = await evalAgent({ model, plugins: [captureModel(found)] });
	const dir = await mkdtemp(join(tmpdir(), "plume-extract-"));
	try {
		const host = found.model!;
		const result = await extractMemory(
			dir,
			{ instructions: "", candidates: SESSIONS.map((messages, i) => ({ id: `s${i}`, updatedAt: Date.now(), messages })) },
			(systemPrompt, prompt) => host.complete({ systemPrompt, prompt, requireComplete: true }),
		);

		say(`\n后台总结 · ${model.model.id}\n`);
		if (result.skipped && !result.memory) {
			say(`  跳过了：${result.skipped}`);
			return;
		}

		say(`${DIM}抽出来的：${OFF}`);
		for (const line of result.memory.split("\n").filter((l) => l.trim())) say(`${DIM}  ${line}${OFF}`);
		say("");

		let ok = 0;
		for (const item of DURABLE) {
			const hit = item.pattern.test(result.memory);
			if (hit) ok += 1;
			say(`  ${"该记".padEnd(4)} ${item.label.padEnd(28)} ${hit ? `${GREEN}记了 ✓${OFF}` : `${RED}漏了 ✗${OFF}`}`);
		}
		for (const item of PERISHABLE) {
			const hit = item.pattern.test(result.memory);
			if (!hit) ok += 1;
			say(`  ${"不该记".padEnd(3)} ${item.label.padEnd(28)} ${hit ? `${RED}记了 ✗ 这条会过期${OFF}` : `${GREEN}没记 ✓${OFF}`}`);
		}
		say(`\n  ${ok}/${DURABLE.length + PERISHABLE.length} 正确\n`);
	} finally {
		await agent.close();
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

await main();
