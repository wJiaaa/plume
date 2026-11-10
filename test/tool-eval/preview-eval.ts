/**
 * preview 的说明改了以后，模型还会不会先截图自检、据截图改、再发布。
 *
 *   node --experimental-transform-types test/tool-eval/preview-eval.ts <模型 id ...> [--runs 2] [--task <id>] [--compare <旧 schema.json>]
 *
 * 模型 id 是设置里的 `<供应商 id>/<模型 id>`，解析见 `model.ts`。带 `--compare` 时同一题再用那份 { description, parameters }
 * 跑一遍，做新旧对照；那份 JSON 从改动前的 preview 工具导出，不留在仓库里。
 *
 * 经 `evalAgent` 跑真实的一轮：系统提示词、工具表、循环都是产品的。带上的插件是循环离不开的那组内置插件，加上清单、网页
 * 两个内置插件、原生界面（`plume.native-ui`，界面块的写法由它教给模型）和 preview。preview 真的写页面、真的起它自己的页面服务，
 * 检查交给 `preview-inspect.mjs`（在 Electron 里跑桌面应用的那份检查）；read/write/edit/ls/glob/grep 在临时目录里真跑；
 * 原生界面的 `ui_help` 只读参考也真跑；其余工具只记录、回一句 ok。
 *
 * 判通过：页面发布出去了、发布的那版没有抛异常、含任务点名的内容。「界面块」一列看回复里让人挑的那块有没有写在 ```ui 围栏里：
 * 漏了围栏，界面会把它原样显示成一段文字。
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Plugin, PluginEntry, ToolDefinition, WebInspection } from "../../packages/contract/src/index.ts";
import { type AssistantMessage, requestUsage } from "../../packages/core/llm/src/types.ts";
import { BUILTINS } from "../../packages/core/agent/test/builtins.ts";
import todo from "../../packages/builtin/todo/src/index.ts";
import web from "../../packages/builtin/web/src/index.ts";
import { pluginSource } from "../../scripts/plugin-source.ts";
import { evalAgent } from "./agent.ts";
import { loadModel } from "./model.ts";

const { default: nativeUi } = await pluginSource("native-ui/src/index.ts");
const { problemsIn } = await pluginSource("native-ui/src/notes.ts");
const { default: preview } = await pluginSource("preview/src/index.ts");

const say = (line = "") => process.stderr.write(`${line}\n`);
const run = promisify(execFile);
const electron = createRequire(join(import.meta.dirname, "../../apps/desktop/package.json"))("electron") as unknown as string;
const HELPER = join(import.meta.dirname, "preview-inspect.mjs");

interface Task {
	id: string;
	prompt: string;
	/** 发布的那版页面里应当有的东西。 */
	check: (html: string) => boolean;
}

const has =
	(...needles: (string | RegExp)[]) =>
	(html: string) =>
		needles.every((n) => (typeof n === "string" ? html.includes(n) : n.test(html)));

const TASKS: Task[] = [
	{
		id: "toggle",
		prompt:
			"Make me a small FAQ page with three questions about our coffee subscription; each answer is hidden until its question is clicked. Show it to me here.",
		check: has(/<button|<details|click/i),
	},
	{
		id: "bar-chart",
		prompt: "Draw a bar chart of monthly sales with a value label on every bar: Jan 120, Feb 95, Mar 140, Apr 180, May 160, Jun 210.",
		check: has("210", "95", "Jun"),
	},
	{
		id: "pricing",
		prompt: "Show three pricing plans side by side — Free $0, Pro $12/month, Team $30/month — and make sure it still reads well on a phone.",
		check: has("$0", "$12", "$30"),
	},
	{
		id: "tabs",
		prompt: "Build a tabbed product card with three tabs, Overview, Specs and Reviews, that switch the content when clicked. Show it to me.",
		check: has("Overview", "Specs", "Reviews", /<script/i),
	},
	// 一次真实会话里漏了界面块围栏的原话。
	{ id: "pick", prompt: "我想做一个待办清单。你给我几个好看的模板 我选择一下", check: has(/<body/i) },
];

const SYSTEM_SUFFIX =
	"This is an evaluation: the tools are real from your point of view. Do the task with the tools you have, then stop. Do not ask the user questions.";
const REAL = new Set(["read", "write", "edit", "ls", "glob", "grep", "preview"]);

/**
 * 页面主题：桌面里由界面经 `appearance` 交给 preview，评测没有界面，给一套浅色近似，够让 var(--foreground) 有颜色、截图像样。
 */
const LIGHT = {
	scheme: "light" as const,
	vars: {
		"--background": "#ffffff",
		"--foreground": "#1f1f1f",
		"--muted": "#f4f4f5",
		"--muted-foreground": "#71717a",
		"--card": "#ffffff",
		"--border": "#e4e4e7",
		"--primary": "#2563eb",
		"--primary-foreground": "#ffffff",
		"--success": "#16a34a",
		"--warning": "#d97706",
		"--danger": "#dc2626",
		"--code-background": "#f6f8fa",
		"--code-foreground": "#24292f",
		"--chart-1": "#2563eb",
		"--chart-2": "#16a34a",
		"--chart-3": "#d97706",
		"--chart-4": "#dc2626",
		"--chart-5": "#7c3aed",
		"--chart-6": "#0891b2",
		"--radius": "8px",
		"--font-sans": "-apple-system,system-ui,sans-serif",
		"--font-mono": "ui-monospace,monospace",
	},
};

/** 在 Electron 里跑一次桌面应用的检查，回来的就是 `ctx.pages.inspect` 的结果。 */
async function inspect(url: string, options: unknown): Promise<WebInspection> {
	const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
	const { stdout } = await run(electron, [HELPER, url, JSON.stringify(options ?? {})], { env, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
	const line = stdout.trim().split("\n").pop();
	if (!line) throw new Error("页面检查没有返回结果");
	return JSON.parse(line) as WebInspection;
}

/**
 * 换掉插件登记的工具，其余原样：插件照常起来（数据目录、钩子、服务都是它自己的），只是登记工具那一下经过 `change`。
 * `onServe` 拿到插件开给界面的那个对象，评测替界面调它。
 */
function rewrap(plugin: Plugin, change: (tool: ToolDefinition) => ToolDefinition, onServe?: (api: unknown) => void): Plugin {
	return {
		...plugin,
		apply(ctx) {
			const tools = { register: (tool: ToolDefinition) => ctx.tools.register(change(tool)), names: () => ctx.tools.names() };
			const wrapped = new Proxy(ctx, {
				get(target, key) {
					if (key === "tools") return tools;
					if (key === "serve" && onServe)
						return (api: object) => {
							target.serve(api);
							onServe(api);
						};
					const value: unknown = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			return plugin.apply(wrapped);
		},
	};
}

interface PreviewCall {
	args: Record<string, unknown>;
	isError: boolean;
	checkId?: string;
	/** 这一下发布出去的页面 id。 */
	published?: string;
}

async function runOnce(task: Task, schema: Pick<ToolDefinition, "description" | "parameters"> | null, modelId: string) {
	const model = await loadModel(modelId);
	const cwd = await mkdtemp(join(tmpdir(), "plume-preview-eval-"));
	const other: string[] = [];
	const previews: PreviewCall[] = [];

	const record = (tool: ToolDefinition): ToolDefinition =>
		REAL.has(tool.name)
			? tool
			: {
					...tool,
					async execute(args) {
						other.push(`${tool.name} ${JSON.stringify(args).slice(0, 80)}`);
						return { output: tool.name === "bash" ? "" : "ok" };
					},
				};
	const recorded = (plugin: Plugin) => rewrap(plugin, record);
	const builtins: PluginEntry[] = [
		...BUILTINS,
		...[todo, web].map((plugin): PluginEntry => ({ key: plugin.name, builtin: true, load: async () => plugin })),
	].map((entry) => ({ ...entry, load: async () => recorded((await entry.load()) as Plugin) }));
	const watched = rewrap(
		preview,
		(tool) =>
			tool.name !== "preview"
				? tool
				: {
						...tool,
						...schema,
						async execute(args, ctx) {
							const result = await tool.execute(args, ctx);
							const details = result.details as { kind?: string; id?: string; preview?: { id?: string } } | undefined;
							previews.push({
								args,
								isError: result.isError === true,
								...(details?.kind === "preview-check" && details.id ? { checkId: details.id } : {}),
								...(details?.preview?.id ? { published: details.preview.id } : {}),
							});
							return result;
						},
					},
		(api) => void (api as { appearance(theme: typeof LIGHT): Promise<void> }).appearance(LIGHT),
	);
	const suffix: Plugin = {
		name: "eval.suffix",
		apply(ctx) {
			ctx.hook("model.context", async (input, next) => next({ ...input, sections: [...input.sections, { id: "eval", text: SYSTEM_SUFFIX }] }));
		},
	};

	const agent = await evalAgent({
		model,
		builtins,
		plugins: [nativeUi, watched, suffix],
		pages: {
			call: async (_plugin, id, method, args) => {
				if (method !== "inspect") throw new Error(`评测只提供页面检查，不提供 ${method}`);
				return inspect(id, args[0]);
			},
		},
	});
	try {
		const turn = await agent.run(cwd, task.prompt, { maxSteps: 12 });
		const replies = turn.messages.filter((m): m is AssistantMessage => m.role === "assistant");
		const input = replies.reduce((sum, m) => {
			const u = requestUsage(m);
			return sum + u.input + u.cacheRead + u.cacheWrite;
		}, 0);
		const checks = previews.filter((p) => p.checkId);
		const firstCheck = previews.findIndex((p) => p.checkId);
		const htmlOf = (p: PreviewCall) => (typeof p.args.html === "string" ? p.args.html : JSON.stringify(p.args.files ?? p.args.path ?? ""));
		// 看过截图之后又交了一版不同的页面：据截图改过。
		const revised = firstCheck >= 0 && previews.slice(firstCheck + 1).some((p) => p.args.id === undefined && htmlOf(p) !== htmlOf(previews[firstCheck]!));
		const shown = [...previews].reverse().find((p) => p.published);
		// 发布出去的那版从 preview 自己的存档里读：按 id 发布、从本地文件发布的，参数里都没有页面正文。
		const shownHtml = shown ? await publishedHtml(join(agent.pluginDataDir(preview.name), "pages", turn.sessionId, `${shown.published}.json`)) : "";
		const said = turn.text;
		const fenced = /^\s*(?:`{3,}|~{3,})ui\s*$/im.test(said);
		const unfenced = problemsIn(said).some((problem) => problem.includes("outside a ui fence"));
		return {
			pass: Boolean(shown) && task.check(shownHtml),
			used: previews.length > 0,
			checks: checks.length,
			widths: previews.filter((p) => p.args.width !== undefined).length,
			revised,
			refused: previews.filter((p) => p.isError).length,
			published: Boolean(shown),
			ui: fenced ? "围栏" : unfenced ? "漏围栏" : "无",
			server: other.some((line) => /http\.server|npx serve|live-server|open .*\.html/.test(line)),
			other: other.length,
			requests: replies.length,
			input,
			error: turn.errors[0],
			// 没过时看一眼它最后说了什么：停在检查之后，还是页面内容不对。
			last: replies
				.at(-1)
				?.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
				.join(" ")
				.replace(/\s+/g, " ")
				.slice(0, 160),
		};
	} finally {
		await agent.close();
		await rm(cwd, { recursive: true, force: true });
	}
}

async function publishedHtml(file: string): Promise<string> {
	const document = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as {
		preview: { entry: string; published: boolean };
		files: { path: string; content: string }[];
	} | null;
	if (!document?.preview.published) return "";
	return document.files.find((entry) => entry.path === document.preview.entry)?.content ?? "";
}

type Row = Awaited<ReturnType<typeof runOnce>>;

async function main(): Promise<void> {
	const flag = (name: string) => {
		const at = process.argv.indexOf(name);
		return at >= 0 ? process.argv[at + 1] : undefined;
	};
	const runs = Number(flag("--runs") ?? 2);
	const one = flag("--task");
	const compare = flag("--compare");
	const old = compare ? (JSON.parse(await readFile(compare, "utf8")) as Pick<ToolDefinition, "description" | "parameters">) : null;
	const models = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && !["--runs", "--task", "--compare"].includes(all[i - 1]!));
	if (models.length === 0) throw new Error("给一个或几个模型 id（设置里的 `<供应商 id>/<模型 id>`）");
	const tasks = TASKS.filter((task) => !one || task.id === one);
	if (tasks.length === 0) throw new Error(`没有任务 ${one}；有：${TASKS.map((task) => task.id).join(", ")}`);
	const variants: [string, Pick<ToolDefinition, "description" | "parameters"> | null][] = old
		? [
				["old", old],
				["new", null],
			]
		: [["new", null]];
	for (const modelId of models) {
		say(`\npreview 自检 · ${modelId} · 每题 ${runs} 次\n`);
		say(`${"任务".padEnd(10)} 版本 结果 用了 检查 宽度 改过 退回 发布 界面块 起服务 其他工具 请求 输入`);
		const totals: Record<string, Row[]> = {};
		for (const task of tasks) {
			for (const [name, schema] of variants) {
				for (let i = 0; i < runs; i++) {
					const r: Row = await runOnce(task, schema, modelId).catch((error: unknown) => ({
						pass: false,
						used: false,
						checks: 0,
						widths: 0,
						revised: false,
						refused: 0,
						published: false,
						ui: "无",
						server: false,
						other: 0,
						requests: 0,
						input: 0,
						error: String(error),
						last: undefined,
					}));
					(totals[name] ??= []).push(r);
					const yn = (v: boolean) => (v ? "是" : "否");
					say(
						`${task.id.padEnd(10)} ${name.padEnd(4)} ${r.pass ? "通过" : "失败"} ${yn(r.used)}   ${r.checks}    ${r.widths}    ${yn(r.revised)}   ${r.refused}    ${yn(r.published)}   ${r.ui.padEnd(4)} ${yn(r.server)}     ${String(r.other).padEnd(8)} ${String(r.requests).padEnd(4)} ${r.input}${r.error ? `  ${r.error.slice(0, 100)}` : ""}${!r.pass && r.last ? `  最后一句：${r.last}` : ""}`,
					);
				}
			}
		}
		for (const [name, rows] of Object.entries(totals)) {
			const n = rows.length;
			const count = (f: (r: Row) => boolean) => rows.filter(f).length;
			const checked = rows.filter((r) => r.checks > 0);
			say(
				`${name.padEnd(4)} 通过 ${count((r) => r.pass)}/${n} · 用了 preview ${count((r) => r.used)}/${n} · 先检查 ${checked.length}/${n} · 检查后改过 ${count((r) => r.revised)}/${checked.length} · 检查了没发布 ${count((r) => r.checks > 0 && !r.published)} · 界面块漏围栏 ${count((r) => r.ui === "漏围栏")}/${count((r) => r.ui !== "无")} · 起服务 ${count((r) => r.server)} · 平均请求 ${(rows.reduce((s, r) => s + r.requests, 0) / n).toFixed(2)} · 平均输入 ${Math.round(rows.reduce((s, r) => s + r.input, 0) / n)}`,
			);
		}
	}
}

main().catch((error) => {
	say(String(error instanceof Error ? (error.stack ?? error.message) : error));
	process.exit(1);
});
