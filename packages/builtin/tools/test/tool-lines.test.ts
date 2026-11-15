import { expect, it } from "vitest";
import { TOOLS } from "../src/tools.ts";
import { WAKEUP_TOOLS } from "../src/tools/wakeups.ts";
import { TOOL_LINES } from "../src/tool-lines.ts";
import { cronWords } from "../src/cron-words.ts";

/** 本体不认工具名：转录里的说法、归类、文件签只看工具定义上的种类和这张表，这里钉住每个工具声明了什么。 */
it("每个工具在定义上声明它做的是哪种活，读写的文件、命令、说明和后台任务从参数里取", () => {
	expect(Object.fromEntries([...TOOLS, ...WAKEUP_TOOLS].map((tool) => [tool.name, tool.kind]))).toEqual({
		read: "view",
		ls: "list",
		glob: "find",
		grep: "search",
		write: "create",
		edit: "modify",
		bash: "command",
		bash_output: "job",
		monitor: "watch",
		schedule_wakeup: undefined,
		cron_create: undefined,
		cron_list: undefined,
		cron_delete: undefined,
	});
	expect(Object.keys(TOOL_LINES)).toEqual([
		"read",
		"ls",
		"glob",
		"grep",
		"write",
		"edit",
		"bash",
		"bash_output",
		"monitor",
		"schedule_wakeup",
		"cron_create",
		"cron_list",
		"cron_delete",
	]);
	const { read, ls, write, bash, bash_output: output, grep } = TOOL_LINES;
	expect(read!.file!({ path: "a.ts" })).toEqual({ path: "a.ts" });
	expect(read!.file!({ path: "a.ts", offset: 10, limit: 20 })).toEqual({ path: "a.ts", lines: { from: 10, to: 29 } });
	expect(read!.file!({ path: "a.ts", offset: 5 })).toEqual({ path: "a.ts", lines: { from: 5 } });
	expect(read!.file!({ path: "a.ts", limit: 3, offset: null })).toEqual({ path: "a.ts", lines: { from: 1, to: 3 } });
	expect(read!.file!({})).toBeUndefined();
	// 没给目录是工作目录。
	expect(ls!.file!({})).toEqual({ path: "" });
	expect(write!.file!({ path: "b.ts", content: "x" })).toEqual({ path: "b.ts" });
	expect(bash!.command!({ command: "ls" })).toBe("ls");
	expect(bash!.command!({})).toBeUndefined();
	expect(grep!.note!({ pattern: "x", description: "找 x" })).toBe("找 x");
	expect(output!.job!({ id: "j1" })).toEqual({ id: "j1", stop: false });
	expect(output!.job!({ id: "j1", kill: true })).toEqual({ id: "j1", stop: true });
	expect(output!.job!({ id: 3 })).toEqual({ stop: false });
});

/**
 * 约好的三种按来几次分开叫：检查（`schedule_wakeup`）、定时任务（只来一次的 `cron_create`）、轮询（反复的）。不说工具名，动作分跑着、做完，
 * 接上模型写给人看的那句；点开是结果里交回的那一个（或那几个）的几样事实。
 */
it("检查、定时任务、轮询：行上说动作和那句话，点开列出检查时间、频率、活多久、id、提示词", () => {
	const { schedule_wakeup: wake, cron_create: cron, cron_list: list, cron_delete: remove } = TOOL_LINES;
	const verb = (line: typeof wake, call: { args?: Record<string, unknown>; details?: unknown; live?: boolean }, locale: "zh-CN" | "en" = "zh-CN") =>
		line!.verbFor!({ args: call.args ?? {}, details: call.details, live: call.live === true }, locale);
	expect(wake!.subject!({ reason: "等 PR 482 的 CI", prompt: "看 CI" })).toBe("等 PR 482 的 CI");
	expect(cron!.subject!({ reason: "盯着部署", prompt: "看部署" })).toBe("盯着部署");
	// 没写 reason 的旧调用：退回提示词的第一行，太长的截掉。
	expect(cron!.subject!({ prompt: "\n看部署好了没有\n好了就删掉" })).toBe("看部署好了没有");
	expect(cron!.subject!({ prompt: "长".repeat(100) })).toHaveLength(80);
	expect(list!.subject).toBeUndefined();
	// 几次合在一起时数次数。
	expect(typeof wake!.verb === "function" && wake!.verb("zh-CN")).toBe("已安排检查");
	expect(wake!.times).toBe(true);
	expect(verb(wake, { live: true })).toBe("正在安排检查");
	expect(verb(wake, {}, "en")).toBe("Scheduled check-in");
	// cron_create 只看参数：recurring 缺省是轮询，false 是定时任务。
	expect(verb(cron, {})).toBe("已开始轮询");
	expect(verb(cron, { args: { recurring: false }, live: true })).toBe("正在安排定时任务");
	expect(verb(cron, { args: { recurring: true } }, "en")).toBe("Started loop");

	const at = new Date(2026, 10, 14, 18, 5).getTime();
	const once = { id: "wake-1", kind: "wakeup", prompt: "看 CI", reason: "等 CI", recurring: false, createdAt: at, nextAt: at, fired: 0 };
	const rows = wake!.fields!({}, { kind: "wakeup", wakeup: once }, "zh-CN")!;
	expect(rows.map((row) => row.label)).toEqual(["检查时间", "原因", "有效期", "ID", "提示词"]);
	expect(rows.find((row) => row.label === "ID")).toEqual({ label: "ID", value: "wake-1", mono: true });
	expect(rows.at(-1)!.value).toBe("看 CI");

	const loop = { ...once, id: "cron-2", kind: "cron", cron: "*/5 * * * *", recurring: true, expiresAt: at + 3 * 86_400_000, reason: "盯着部署" };
	const loopRows = cron!.fields!({}, { kind: "wakeup", wakeup: loop }, "en")!;
	expect(loopRows.map((row) => row.label)).toEqual(["Schedule", "Next run", "Expires", "Reason", "Lasts", "ID", "Prompt"]);
	// 认得出的频率说人话、带上原式；认不出的只给原式，等宽。
	expect(loopRows[0]).toEqual({ label: "Schedule", value: "Every 5 minutes · */5 * * * *", mono: false });
	const prompt = { ...loop, cron: "30 14 * * *", recurring: false };
	expect(cron!.fields!({}, { kind: "wakeup", wakeup: prompt }, "zh-CN")![0]).toMatchObject({ value: "每天 14:30 · 30 14 * * *（只一次）" });
	expect(cron!.fields!({}, { kind: "wakeup", wakeup: { ...loop, cron: "0,30 9-17 * * *" } }, "zh-CN")![0]).toEqual({
		label: "频率",
		value: "0,30 9-17 * * *",
		mono: true,
	});
	// 认不出的结果（出错了、别的形状）不给：照通用的画。
	expect(wake!.fields!({}, undefined, "zh-CN")).toBeUndefined();
	expect(wake!.fields!({}, { kind: "wakeup", wakeup: { id: 1 } }, "zh-CN")).toBeUndefined();

	// cron_list：数有几个，点开一个一行，名称是哪一种。
	const listed = { kind: "wakeups", wakeups: [once, loop] };
	expect(verb(list, { live: true })).toBe("正在列出定时任务");
	expect(verb(list, { details: listed })).toBe("已列出 2 个定时任务");
	expect(verb(list, { details: { kind: "wakeups", wakeups: [once] } }, "en")).toBe("Listed 1 scheduled prompt");
	expect(verb(list, { details: { kind: "wakeups", wakeups: [] } })).toBe("没有找到定时任务");
	expect(list!.fields!({}, listed, "zh-CN")!.map((row) => row.label)).toEqual(["检查", "轮询"]);
	expect(list!.fields!({}, listed, "zh-CN")![0]!.value).toMatch(/^等 CI · /);

	// cron_delete：停掉的是哪一个只有结果里有，有就说它的种类和那句话，没有说 id。
	const cancelled = { kind: "wakeup", wakeup: loop, cancelled: true };
	expect(verb(remove, { details: cancelled })).toBe("已停止轮询");
	expect(verb(remove, { details: { ...cancelled, wakeup: once } }, "en")).toBe("Cancelled check-in");
	expect(verb(remove, { live: true })).toBe("正在停止");
	expect(verb(remove, {})).toBeUndefined();
	expect(remove!.subject!({ id: "cron-2" }, cancelled)).toBe("盯着部署");
	expect(remove!.subject!({ id: " cron-2 " })).toBe("cron-2");
	expect(remove!.fields!({}, cancelled, "zh-CN")!.map((row) => row.label)).toEqual(["频率", "原因", "ID", "提示词"]);
});

it("monitor：跑着说「监视中」、停了说「已开始监视」，接上说明（没写说明说命令的第一行），不整行只说说明", () => {
	const { monitor } = TOOL_LINES;
	expect(monitor!.note).toBeUndefined();
	expect(monitor!.verbFor!({ args: {}, details: undefined, live: true }, "zh-CN")).toBe("监视中");
	expect(monitor!.verbFor!({ args: {}, details: undefined, live: false }, "en")).toBe("Started watching");
	expect(monitor!.subject!({ description: "等开发服务器起来", command: "tail -f log" })).toBe("等开发服务器起来");
	expect(monitor!.subject!({ command: "tail -f log\ngrep x" })).toBe("tail -f log");
});

it("cron 的人话：步长不整除 60、24 的不说「每 n」，只留原式", () => {
	expect(cronWords("*/15 * * * *", "en")).toBe("Every 15 minutes");
	// :00、:45 各一次，间隔不等长。
	expect(cronWords("*/45 * * * *", "en")).toBeUndefined();
	expect(cronWords("*/90 * * * *", "en")).toBeUndefined();
	expect(cronWords("0 */6 * * *", "en")).toBe("Every 6 hours at :00");
	expect(cronWords("30 */1 * * *", "en")).toBe("Hourly at :30");
	expect(cronWords("0 */48 * * *", "en")).toBeUndefined();
});
