/**
 * 真实模型上的检查：答案落在 grep 输出上限之外时，agent 还能不能把事做完；grep 交出去的结果是不是比文件小两个数量级。
 *
 * 三件事各开一个会话：在一个单行的大 JSON 里找一个字段（grep、read 随它用）、改一个文件里的值、只用 read 的 `char_offset`
 * 窗口读那个大 JSON。外加一道不经模型的闸：直接调 grep 工具，看它交出的那份有多大、答案在不在里面。
 *
 * 用的是一个临时数据目录里的 agent（带上随应用发的那几个内置插件，权限是完全访问），跑完连同临时工作区一起删掉，不碰
 * `~/.plume`：不读那里的设置和密钥，会话也不写进那里的会话库。所以模型和 key 从环境变量给，key 不打印：
 *
 *   PLUME_PROBE_BASE_URL   供应商的地址（必填）
 *   PLUME_PROBE_API_KEY    API key（必填）
 *   PLUME_PROBE_API        接口格式，缺省 anthropic-messages（见 `ApiFormat`）
 *   模型 id               第一个命令行参数，或 PLUME_PROBE_MODEL
 *
 * 用法：
 *   PLUME_PROBE_BASE_URL=… PLUME_PROBE_API_KEY=… pnpm probe:prune <模型 id>
 *
 * 会调真实模型、花钱；输出一份 JSON，没全过时退出码为 1。
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { grepTool } from "../packages/builtin/tools/src/tools/grep.ts";
import { withFiles } from "../packages/builtin/tools/test/files.ts";
import type { AgentService, ApiFormat, AssistantMessage, Message, Plugin } from "../packages/contract/src/index.ts";
import { createAgent } from "../packages/core/agent/src/index.ts";
import { BUILTINS } from "../packages/core/agent/test/builtins.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(ROOT, "packages/core/llm/src/catalog/model-catalog.json");
const SECRET_AFTER = "BETA-2C7";
/** 一件事最多等多久，到点就按停。 */
const TASK_TIMEOUT_MS = 180_000;
/** grep 交出去的上限（plume.tools 的 grep 截在 12k 字符），闸门按它判。 */
const GREP_MAX_CHARS = 12_000;

interface RequestSnap {
	index: number;
	toolResultChars: number;
	toolResults: number;
	usage: AssistantMessage["usage"];
	stop: string;
}

function textOf(message: Message): string {
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function toolChars(messages: Message[]): { chars: number; count: number } {
	let chars = 0;
	let count = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		count += 1;
		chars += textOf(message).length;
	}
	return { chars, count };
}

/**
 * 找一个当针的模型：名字在整个目录里只出现一次，位置在文件后段（离开头远，grep 和 read 的第一屏都看不到它）。
 * 目录会随上游更新，所以按条件挑，不写死哪一个。
 */
function pickNeedle(catalog: string): string {
	const document = JSON.parse(catalog) as { providers: { models: { name?: string }[] }[] };
	for (const provider of document.providers) {
		for (const model of provider.models) {
			if (!model.name || !/^[\w .-]+$/.test(model.name)) continue;
			const mark = `"name":"${model.name}"`;
			const at = catalog.indexOf(mark);
			if (at > catalog.length * 0.6 && catalog.indexOf(mark, at + 1) < 0) return model.name;
		}
	}
	throw new Error("目录里找不到名字唯一、又在后段的模型");
}

function required(name: string, value: string | undefined): string {
	if (!value) {
		console.error(`缺少 ${name}，用法见 scripts/probe-prune-accuracy.ts 开头。`);
		process.exit(2);
	}
	return value;
}

const baseUrl = required("PLUME_PROBE_BASE_URL", process.env.PLUME_PROBE_BASE_URL);
const apiKey = required("PLUME_PROBE_API_KEY", process.env.PLUME_PROBE_API_KEY);
const modelId = required("模型 id（命令行参数或 PLUME_PROBE_MODEL）", process.argv[2] ?? process.env.PLUME_PROBE_MODEL);
const api = (process.env.PLUME_PROBE_API || "anthropic-messages") as ApiFormat;

/** 这几个会话只给模型 read：量的是 read 自己的窗口能不能把答案读出来。 */
const readOnly = new Set<string>();
const onlyRead: Plugin = {
	name: "probe.read-only",
	apply(ctx) {
		ctx.hook("model.context", async (input, next) =>
			next(readOnly.has(input.sessionId) ? { ...input, tools: input.tools.filter((tool) => tool.name === "read") } : input),
		);
	},
};

/** 等这个会话从跑着变成停下；到点按停。 */
function settled(service: AgentService, sessionId: string, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		let running = false;
		const timer = setTimeout(() => service.stop(sessionId), TASK_TIMEOUT_MS);
		void (async () => {
			for await (const event of service.watch({ signal })) {
				if (event.type !== "sessions") continue;
				const summary = event.sessions.find((entry) => entry.id === sessionId);
				if (summary?.running) running = true;
				else if (running) break;
			}
			clearTimeout(timer);
			resolve();
		})();
	});
}

async function runTask(service: AgentService, workspace: string, label: string, prompt: string, onlyReadTool = false) {
	const session = await service.createSession({ cwd: workspace });
	if (onlyReadTool) readOnly.add(session.id);
	const watching = new AbortController();
	const done = settled(service, session.id, watching.signal);
	service.send(session.id, { content: [{ type: "text", text: prompt }] });
	await done;
	watching.abort();
	const view = await service.getSession(session.id);
	const requests: RequestSnap[] = [];
	view.messages.forEach((message, at) => {
		if (message.role !== "assistant") return;
		const tools = toolChars(view.messages.slice(0, at));
		requests.push({ index: requests.length, toolResultChars: tools.chars, toolResults: tools.count, usage: message.usage, stop: message.stopReason });
	});
	const reply = view.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
	return {
		label,
		reason: view.summary.stop?.reason ?? "(none)",
		reply: reply ? textOf(reply) : "",
		requests,
		error: view.summary.stop?.error ?? reply?.errorMessage,
	};
}

const dir = await mkdtemp(join(tmpdir(), "plume-prune-accuracy-"));
const workspace = join(dir, "workspace");
const started = Date.now();
const agent = await createAgent({
	dataDir: join(dir, "data"),
	settingsFile: join(dir, "model.json"),
	plugins: [...BUILTINS, { key: onlyRead.name, load: async () => onlyRead }],
	log: () => undefined,
});
try {
	await mkdir(workspace);
	const service = agent.service;
	const providerId = await service.saveProvider({
		id: "",
		name: "probe",
		api,
		baseUrl,
		enabled: true,
		models: [{ modelId, name: modelId, contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: false, supportsTools: true }],
		apiKey,
	});
	await service.setDefaultModel(`${providerId}/${modelId}`);
	await service.setPermissionMode("full");

	const original = await readFile(CATALOG, "utf8");
	const name = pickNeedle(original);
	const probe = `PLUME-${randomBytes(4).toString("hex").toUpperCase()}`;
	const catalog = original.replace(`"name":"${name}"`, `"name":"${name}","probe":"${probe}"`);
	await writeFile(join(workspace, "catalog.json"), catalog);
	await writeFile(join(workspace, "note.txt"), "# workspace note\nSECRET=ALPHA-9F3\n");

	const gated = await grepTool.execute({ pattern: name, path: "catalog.json" }, withFiles({ cwd: workspace, state: new Map() }));
	const gatedText = gated.content.map((part) => part.text).join("");

	const catalogTask = await runTask(
		service,
		workspace,
		"catalog",
		`catalog.json is a model catalog (one JSON file). Find the probe field of the entry whose name is exactly "${name}". Reply with only that probe value.`,
	);
	const secretTask = await runTask(
		service,
		workspace,
		"secret",
		`Read note.txt. Change the SECRET value to ${SECRET_AFTER}. Reply with only the new SECRET value.`,
	);
	const nameAt = catalog.indexOf(name);
	const readTask = await runTask(
		service,
		workspace,
		"read-window",
		`catalog.json is a single-line JSON file. Read it with char_offset=${Math.max(1, nameAt - 80)} and find the probe ` +
			`field of the entry whose name is exactly "${name}". Reply with only that probe value.`,
		true,
	);
	const note = await readFile(join(workspace, "note.txt"), "utf8");

	const catalogOk = catalogTask.reply.includes(probe);
	const secretOk = note.includes(SECRET_AFTER) && secretTask.reply.includes(SECRET_AFTER);
	const readOk = readTask.reply.includes(probe);
	const gateOk = gatedText.includes(name) && gatedText.includes(probe) && gatedText.length <= GREP_MAX_CHARS;
	const brief = (task: Awaited<ReturnType<typeof runTask>>, ok: boolean) => ({
		ok,
		reason: task.reason,
		error: task.error,
		reply: task.reply.slice(0, 240),
		requests: task.requests,
	});
	const summary = {
		model: `${providerId}/${modelId}`,
		elapsedMs: Date.now() - started,
		gate: {
			catalogBytes: catalog.length,
			grepChars: gatedText.length,
			savedChars: catalog.length - gatedText.length,
			ratio: Number((gatedText.length / catalog.length).toFixed(4)),
			needleVisible: gateOk,
		},
		catalog: brief(catalogTask, catalogOk),
		secret: { ...brief(secretTask, secretOk), fileHasNewSecret: note.includes(SECRET_AFTER) },
		readWindow: brief(readTask, readOk),
		passed: gateOk && catalogOk && secretOk && readOk,
	};
	console.log(JSON.stringify(summary, null, 2));
	if (!summary.passed) process.exitCode = 1;
} finally {
	await agent.shutdown();
	await rm(dir, { recursive: true, force: true });
}
