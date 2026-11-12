/**
 * monitor 怎么把输出分批送给模型：凑批、两批之间的间隔、行数和空闲的上限、清掉终端的转义。进程是假的，输出由测试一段段喂，时间用假时钟。
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BackgroundChannel, DeliveryInput, RunProcess, ToolRun } from "@plume/contract";
import { backgroundJobs } from "../../src/tools/background-jobs.ts";
import { bashOutputTool } from "../../src/tools/bash.ts";
import { monitorTool } from "../../src/tools/monitor.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";
import { withFiles } from "../files.ts";

interface FakeProcess extends RunProcess {
	print(chunk: string): void;
	exit(code: number | null): void;
	kills: string[];
}

function fakeProcess(): FakeProcess {
	const output: Array<(chunk: string) => void> = [];
	const exits: Array<(code: number | null) => void> = [];
	const kills: string[] = [];
	return {
		pid: 4242,
		mode: "workspace-write",
		denied: () => false,
		kills,
		onOutput: (listener) => void output.push(listener),
		onExit: (listener) => void exits.push(listener),
		onError: () => undefined,
		kill: (signal = "SIGTERM") => void kills.push(signal),
		print: (chunk) => output.forEach((listener) => listener(chunk)),
		exit: (code) => exits.forEach((listener) => listener(code)),
	};
}

interface Sent {
	text: string | (() => string | undefined);
	delivery?: DeliveryInput;
}

function fakeChannel() {
	const controller = new AbortController();
	const sent: Sent[] = [];
	const channel: BackgroundChannel = {
		signal: controller.signal,
		report: (text, delivery) => {
			if (controller.signal.aborted) return false;
			sent.push({ text, ...(delivery ? { delivery } : {}) });
			return true;
		},
	};
	/** 宿主送出那一刻取的那份。 */
	const take = (index: number) => {
		const { text } = sent[index]!;
		return typeof text === "function" ? text() : text;
	};
	return { channel, sent, take, stop: () => controller.abort() };
}

let process: FakeProcess;
let state: Map<string, unknown>;
let channel: ReturnType<typeof fakeChannel>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	process = fakeProcess();
	state = new Map();
	channel = fakeChannel();
});
afterEach(() => vi.useRealTimers());

const exec: ToolRun["exec"] = async () => process;
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => withFiles({ cwd: "/tmp", state, exec, background: () => channel.channel, ...extra });
const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("\n");

async function start(args: Record<string, unknown> = {}): Promise<string> {
	const result = await monitorTool.execute({ command: "tail -f app.log", description: "盯着日志", ...args }, ctx());
	expect(result.isError).toBeUndefined();
	return (result.details as { id: string }).id;
}

it("第一行之后等一秒凑齐同一阵；说明里写清怎么送、怎么停", async () => {
	const result = await monitorTool.execute({ command: "tail -f app.log" }, ctx());
	const id = (result.details as { id: string }).id;
	expect(textOf(result)).toBe(
		`Started monitor ${id}. Keep working: its new output lines will be delivered to you as messages, so do not poll it. ` +
			"They come in batches, at most one every 10s, each keeping the newest 4000 characters. " +
			"It stops after 100 lines or 600s without output, or when the person presses Stop; " +
			`stop it with bash_output({ id: "${id}", kill: true }) as soon as you no longer need it.`,
	);
	expect(backgroundJobs(state).get(id)).toMatchObject({ kind: "monitor", status: "running" });

	process.print("first\n");
	await vi.advanceTimersByTimeAsync(500);
	process.print("second\nhalf");
	await vi.advanceTimersByTimeAsync(499);
	expect(channel.sent).toHaveLength(0);
	await vi.advanceTimersByTimeAsync(1);
	expect(channel.sent).toHaveLength(1);
	expect(channel.sent[0]!.delivery).toEqual({
		id,
		title: "tail -f app.log",
		status: "done",
		inline: true,
		details: { kind: "job", command: "tail -f app.log", monitor: { lines: 2 } },
	});
	expect(channel.take(0)).toContain(`<monitor_events id="${id}" command="tail -f app.log" lines="2" status="running">\nfirst\nsecond\n</monitor_events>`);
});

it("同一个 monitor 两批之间至少隔十秒，期间的行攒到下一批", async () => {
	await start();
	process.print("one\n");
	await vi.advanceTimersByTimeAsync(1_000);
	expect(channel.sent).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1_000);
	process.print("two\n");
	await vi.advanceTimersByTimeAsync(3_000);
	process.print("three\n");
	await vi.advanceTimersByTimeAsync(5_999);
	expect(channel.sent).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(channel.sent).toHaveLength(2);
	expect(channel.take(1)).toContain('lines="2" status="running">\ntwo\nthree\n<');
});

it("满了 max_events 当场送最后一批、说明为什么停，进程停掉；随后的退出不再当成命令结束送一遍", async () => {
	const id = await start({ max_events: 3, description: "盯着日志" });
	process.print("1\n2\n3\n4\n");
	expect(channel.sent).toHaveLength(1);
	expect(channel.sent[0]!.delivery).toMatchObject({ title: "盯着日志", details: { monitor: { lines: 3, stopped: "max_events" } } });
	const text = channel.take(0)!;
	expect(text).toContain('lines="3" status="stopped">\n1\n2\n3\n[监视已停止：输出满了 max_events 的 3 行，进程已结束]');
	expect(process.kills).toEqual(["SIGTERM"]);
	process.exit(null);
	await vi.advanceTimersByTimeAsync(20_000);
	expect(channel.sent).toHaveLength(1);
	// 填满那一行之后的仍算没读：bash_output 从「4」接着给。
	const read = await bashOutputTool.execute({ id }, ctx());
	expect(textOf(read)).toBe(`[job ${id} terminated]\n4\n`);
});

it("太久没输出就自己停，最后一批只说为什么停", async () => {
	await start({ idle_timeout: 5_000 });
	await vi.advanceTimersByTimeAsync(4_999);
	expect(channel.sent).toHaveLength(0);
	await vi.advanceTimersByTimeAsync(1);
	expect(channel.sent).toHaveLength(1);
	expect(channel.sent[0]!.delivery?.details).toMatchObject({ monitor: { lines: 0, stopped: "idle" } });
	expect(channel.take(0)).toContain('lines="0" status="stopped">\n[监视已停止：5 秒没有新输出（idle_timeout），进程已结束]');
	expect(process.kills).toEqual(["SIGTERM"]);
});

it("每批只留最新的 4000 字，单行截到 1000 字；颜色去掉，用 \\r 重画的行只留最后一次", async () => {
	await start();
	process.print("\x1b[31mred\x1b[0m\n10%\r50%\r100%\n\n");
	await vi.advanceTimersByTimeAsync(1_000);
	expect(channel.take(0)).toContain('lines="2" status="running">\nred\n100%\n<');

	await vi.advanceTimersByTimeAsync(10_000);
	process.print(`${"x".repeat(1_500)}\n`);
	for (let index = 0; index < 5; index++) process.print(`${String(index).repeat(900)}\n`);
	await vi.advanceTimersByTimeAsync(1_000);
	const text = channel.take(1)!;
	expect(text).toContain('lines="6"');
	expect(text).toContain("[更早的 2 行超出单次送达的上限，没有放进来]");
	expect(text).not.toContain("x".repeat(1_001));
	expect(text).toContain("4".repeat(900));
});

it("自己结束的命令和别的后台任务一样送一次结束，带上上一批之后的行", async () => {
	const id = await start();
	process.print("ready\n");
	await vi.advanceTimersByTimeAsync(1_000);
	process.print("bye\n");
	process.exit(0);
	expect(channel.sent).toHaveLength(2);
	expect(channel.sent[1]!.delivery).toMatchObject({ id, status: "done", details: { kind: "job", exitCode: 0 } });
	expect(channel.sent[1]!.delivery?.details).not.toHaveProperty("monitor");
	expect(channel.take(1)).toContain(`<background_job id="${id}" command="tail -f app.log" status="exited with code 0">\nbye\n\n</background_job>`);
});

it("人按停时 monitor 跟着停；bash_output 停掉的，攒着没送的那批不再送", async () => {
	await start();
	channel.stop();
	expect(process.kills).toEqual(["SIGTERM"]);

	process = fakeProcess();
	channel = fakeChannel();
	const id = await start();
	process.print("pending\n");
	await vi.advanceTimersByTimeAsync(1_000);
	process.print("later\n");
	await vi.advanceTimersByTimeAsync(10_000);
	expect(channel.sent).toHaveLength(2);
	await bashOutputTool.execute({ id, kill: true }, ctx());
	expect(channel.take(1)).toBeUndefined();
});

it("没有送达渠道（子会话）时不跑，叫模型改用后台的 bash", async () => {
	const result = await monitorTool.execute({ command: "tail -f app.log" }, ctx({ background: undefined }));
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("monitor is not available here");
	expect(backgroundJobs(state).list()).toEqual([]);
});

it("导出会话时的说法（describe）和 bash 那一行一样：模型写的说明，没有就是命令的第一行", () => {
	expect(monitorTool.describe?.({ command: "tail -f log", description: "看日志" })).toBe("看日志");
	expect(monitorTool.describe?.({ command: "npm run dev\n--watch" })).toBe("npm run dev");
	expect(monitorTool.describe?.({})).toBe("bash");
	expect(monitorTool.describe?.({ description: "" })).toBe("Run bash command");
});
