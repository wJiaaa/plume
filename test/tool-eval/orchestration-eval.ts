/**
 * 子智能体交回一份结构，真的比交回一段话好用吗？
 *
 *   node --experimental-transform-types test/tool-eval/orchestration-eval.ts [模型 id] [每组次数，默认 3]
 *
 * 要验的说法很具体、也证伪得了：**父会话拿到结果以后，不用再读任何东西就能接着干。** 所以量的不是「子智能体有没有把活干完」
 * ——两组都干完了——而是交回来的东西能不能直接当数据用。
 *
 * 两组在同一个仓库、用同一个模型派同一件事，都是 `explore`。一组用内置的 `explore`（带 `output` 结构，`yield` 交回校验过的对象），
 * 另一组在个人目录（数据目录的 `agents/`）里写一份同名定义盖住它：同样的身份和工具，没有 `output`，做完用正文回答。
 * 差别只在父会话手里最后拿着什么。派发经 `dispatch.ts`：父会话照脚本派，子智能体用这里解析出的模型。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagents from "../../../plume-plugins/plugins/subagents/src/index.ts";
import { BUILTIN_AGENTS } from "../../../plume-plugins/plugins/subagents/src/agents.ts";
import { evalAgent, type EvalAgent } from "./agent.ts";
import { dispatchOnce } from "./dispatch.ts";
import { loadModel } from "./model.ts";

const say = (line = "") => process.stderr.write(`${line}\n`);
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

/** 一个小而真实的代码库：登录流程散在三个文件里。 */
async function fixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-orch-"));
	await mkdir(join(dir, "src", "auth"), { recursive: true });
	await mkdir(join(dir, "src", "db"), { recursive: true });

	await writeFile(
		join(dir, "src", "auth", "login.ts"),
		[
			"import { verifyPassword } from './hash.ts';",
			"import { findUser } from '../db/users.ts';",
			"",
			"export async function login(email: string, password: string) {",
			"\tconst user = await findUser(email);",
			"\tif (!user) return null;",
			"\tif (!(await verifyPassword(password, user.hash))) return null;",
			"\treturn issueSession(user.id);",
			"}",
			"",
			"function issueSession(userId: string) {",
			"\treturn { token: `sess_${userId}_${Date.now()}`, expires: Date.now() + 86400000 };",
			"}",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(dir, "src", "auth", "hash.ts"),
		["export async function verifyPassword(plain: string, hash: string) {", "\treturn plain === hash;", "}"].join("\n"),
		"utf8",
	);
	await writeFile(
		join(dir, "src", "db", "users.ts"),
		["export async function findUser(email: string) {", "\treturn { id: '1', email, hash: 'x' };", "}"].join("\n"),
		"utf8",
	);
	return dir;
}

const TASK = "找出登录流程涉及哪些文件，每个文件为什么相关，并给出一句话的结论。";

/** 父会话要拿这份答案做的事，不用再读任何东西。 */
interface Extraction {
	/** 父会话能接着处理的文件路径。 */
	paths: string[];
	/** 能直接引用的简短结论。 */
	summary: string;
	/** 是怎么拿到的。 */
	how: "结构化字段" | "解析散文" | "没拿到";
}

/** 对一段散文，父会话只能这样做：用正则去猜。 */
function parseProse(text: string): Extraction {
	const paths = [...text.matchAll(/[`'"]?((?:src|packages|test)\/[\w./-]+\.\w+)(?::\d+(?:-\d+)?)?[`'"]?/g)].map((m) => m[1]!);
	const firstSentence = text.split(/\n\n|。/)[0]?.trim() ?? "";
	return { paths: [...new Set(paths)], summary: firstSentence, how: paths.length > 0 ? "解析散文" : "没拿到" };
}

function fromOutput(output: Record<string, unknown> | undefined): Extraction | null {
	if (!output) return null;
	const files = Array.isArray(output.files) ? output.files : [];
	const paths = files
		.map((f) => (typeof f === "object" && f !== null ? String((f as Record<string, unknown>).path ?? "") : ""))
		.filter(Boolean)
		.map((p) => p.split(":")[0]!);
	return { paths: [...new Set(paths)], summary: typeof output.summary === "string" ? output.summary : "", how: "结构化字段" };
}

/** 盖住内置 `explore` 的那份：同样的身份和工具，去掉 `output`，正文末尾说清要交回什么——没有结构以前就是这样要求的。 */
function proseDefinition(): string {
	const explore = BUILTIN_AGENTS.find((agent) => agent.name === "explore")!;
	const tools = explore.tools === "*" ? '"*"' : `[${explore.tools.join(", ")}]`;
	return [
		"---",
		"name: explore",
		`description: ${explore.description}`,
		`tools: ${tools}`,
		"---",
		`${explore.prompt} Reply with the file paths and line numbers that answer the question, plus a two-sentence summary.`,
		"",
	].join("\n");
}

async function main(): Promise<void> {
	const model = await loadModel(process.argv[2]);
	const runs = Number(process.argv[3] ?? 3);
	const cwd = await fixture();

	say(`\n${BOLD}子智能体结构化输出 · ${model.model.id}${OFF}\n`);

	const arms: { label: string; prose: boolean }[] = [
		{ label: "散文（没有 output）", prose: true },
		{ label: "结构化（内置 explore）", prose: false },
	];

	for (const arm of arms) {
		const agent: EvalAgent = await evalAgent({ model, plugins: [subagents] });
		try {
			if (arm.prose) {
				await mkdir(join(agent.dataDir, "agents"), { recursive: true });
				await writeFile(join(agent.dataDir, "agents", "explore.md"), proseDefinition(), "utf8");
			}
			const tally = { pathsOk: 0, summaryOk: 0, ms: 0, chars: 0 };
			for (let run = 0; run < runs; run += 1) {
				const started = Date.now();
				const { task, delivered, parent } = await dispatchOnce(agent, cwd, { subagent_type: "explore", description: "找登录流程", prompt: TASK });
				const answer = task?.answer ?? "";

				const extracted = fromOutput(task?.output) ?? parseProse(answer);
				const found = new Set(extracted.paths.map((p) => p.replace(/^\.?\//, "")));
				const wanted = ["src/auth/login.ts", "src/auth/hash.ts", "src/db/users.ts"];
				const hits = wanted.filter((w) => [...found].some((f) => f.endsWith(w) || w.endsWith(f)));

				/*
				 * 结论得是一句结论才能用。从散文里取「第一句」每次都取得到，可那一句常常是「登录流程共涉及以下 3 个文件：」——一个引子，
				 * 不是答案。要求不止一个分句、末尾不是冒号，判得很粗，但正是它把两组分开。
				 */
				const summaryUsable = extracted.summary.length > 12 && !/[:：]$/.test(extracted.summary);
				if (hits.length === 3) tally.pathsOk += 1;
				if (summaryUsable) tally.summaryOk += 1;
				tally.ms += Date.now() - started;
				tally.chars += delivered.length;

				if (run === 0) {
					say(`${BOLD}${arm.label}${OFF}`);
					if (!task) say(`  ${RED}没有派出去：${parent.errors.join("；") || parent.text || "（原因不明）"}${OFF}`);
					else if (task.state !== "done") say(`  ${RED}子智能体 ${task.state}${task.error ? `：${task.error}` : ""}${OFF}`);
					say(`  取到路径的方式  ${extracted.how === "结构化字段" ? GREEN : RED}${extracted.how}${OFF}`);
					say(`  第一次的结论    ${DIM}${extracted.summary.slice(0, 56) || "(空)"}${OFF}`);
					if (task?.warnings?.length) say(`  ${RED}结构问题        ${task.warnings.join("; ")}${OFF}`);
				}
			}
			const rate = (n: number) => `${n}/${runs}`;
			say(`  三个文件都找到  ${tally.pathsOk === runs ? GREEN : RED}${rate(tally.pathsOk)}${OFF}`);
			say(`  结论可直接引用  ${tally.summaryOk === runs ? GREEN : RED}${rate(tally.summaryOk)}${OFF}`);
			say(`  平均            ${DIM}${(tally.ms / runs / 1000).toFixed(1)}s，父会话收到 ${Math.round(tally.chars / runs)} 字符${OFF}\n`);
		} finally {
			await agent.close();
		}
	}

	say(
		`${DIM}判读：两边都能把活干完。差别在父会话拿到手的是什么——一边是可以直接索引的字段，\n` +
			`另一边是一段要用正则去猜的文字，而那段正则是这个脚本替父会话写的。${OFF}\n`,
	);
	await rm(cwd, { recursive: true, force: true }).catch(() => {});
}

await main();
