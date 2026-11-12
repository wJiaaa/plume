/**
 * bash 真的跑命令：退出码按命令读、超时的两种处理、后台任务的读和停、命令退出后留下来的进程。
 * 不进沙箱（`ToolRun.exec` 换成不设限的本地实现），沙箱档和提权由本体定，另有 `packages/core/agent/test/commands.test.ts`。
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { BackgroundChannel, DeliveryInput, ToolRun } from "@plume/contract";
import { backgroundJobs, disposeBackgroundJobs } from "../../src/tools/background-jobs.ts";
import { bashOutputTool, bashTool } from "../../src/tools/bash.ts";
import { readTool } from "../../src/tools/read.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";
import { localExec } from "../sandbox.ts";

let cwd: string;
const states: Map<string, unknown>[] = [];

beforeAll(async () => {
	cwd = await mkdtemp(join(tmpdir(), "plume-bash-"));
	await writeFile(join(cwd, "haystack.txt"), "hay\n");
});
afterEach(() => {
	vi.useRealTimers();
	for (const state of states.splice(0)) disposeBackgroundJobs(state);
});
afterAll(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
	const state = new Map<string, unknown>();
	states.push(state);
	return { cwd, state, exec: localExec(cwd), ...extra };
}

const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("\n");

it("退出码按命令读：搜不到是答案，别的非零是失败，成功不写状态", async () => {
	const ok = await bashTool.execute({ command: "echo hi" }, ctx());
	expect(textOf(ok)).toBe("hi");
	expect(ok.isError).toBe(false);

	const none = await bashTool.execute({ command: "grep -q needle haystack.txt" }, ctx());
	expect(none.isError).toBe(false);
	expect(textOf(none)).toBe("(no output)\n\n[exit code 1 — no matches; not a failure]");
	expect(none.details).toMatchObject({ kind: "bash", exitCode: 1, exitMeaning: "no matches" });

	const failed = await bashTool.execute({ command: "echo broke >&2; exit 3" }, ctx());
	expect(failed.isError).toBe(true);
	expect(textOf(failed)).toBe("broke\n\n[exit code 3]");
});

it("提权经 run.escalate 申请：卡上是命令和模型的理由，批了才跑，不批时命令不跑、结果是本体给的说明", async () => {
	const requests: Parameters<ToolRun["escalate"]>[0][] = [];
	const ran: string[] = [];
	const exec: ToolRun["exec"] = (command, options) => (ran.push(command), localExec(cwd)(command, options));
	const escalated = { command: "echo hi", description: "写缓存", escalate: "danger-full-access", justification: "要写项目外的缓存" };
	const granted = await bashTool.execute(escalated, ctx({ exec, escalate: async (request) => (requests.push(request), { granted: true }) }));
	expect(textOf(granted)).toBe("hi");
	expect(requests).toEqual([{ mode: "danger-full-access", justification: "要写项目外的缓存", title: "提权运行：写缓存", detail: "echo hi" }]);

	const refused = await bashTool.execute(escalated, ctx({ exec, escalate: async () => ({ granted: false, message: "本体说不行" }) }));
	expect(refused.isError).toBe(true);
	expect(textOf(refused)).toBe("本体说不行");
	expect(ran).toEqual(["echo hi"]);
});

it("只给理由不申请提权：不问人，直接拒，命令不跑", async () => {
	const ran: string[] = [];
	const result = await bashTool.execute(
		{ command: "echo hi", justification: "要写缓存" },
		ctx({ exec: async (command) => (ran.push(command), localExec(cwd)(command)), escalate: async () => ({ granted: true }) }),
	);
	expect(result.isError).toBe(true);
	expect(textOf(result)).toMatch(/justification 只能和 escalate 一起用/);
	expect(ran).toEqual([]);
});

it("给了 timeout 到点就杀", async () => {
	const result = await bashTool.execute({ command: "echo before; sleep 5", timeout: 300 }, ctx());
	expect(result.isError).toBe(true);
	expect(textOf(result)).toMatch(/^before\n\n\n\[timed out after 300ms\]$/);
	expect(result.details).toMatchObject({ timedOut: true });
});

it("没给 timeout 的过了默认等待转成后台任务，能读能停", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	let printed!: () => void;
	const first = new Promise<void>((resolve) => (printed = resolve));
	const context = ctx({ onProgress: () => printed() });
	const pending = bashTool.execute({ command: "echo first; sleep 30" }, context);
	await first;
	await vi.advanceTimersByTimeAsync(120_000);
	const result = await pending;
	expect(result.isError).toBeUndefined();
	const id = (result.details as { jobId: string }).jobId;
	expect(textOf(result)).toBe(
		`first\n\n[still running after 120s — now background job ${id}. Read its output with bash_output({ id: "${id}" }). Stop it with bash_output({ id: "${id}", kill: true }).]`,
	);
	expect(backgroundJobs(context.state).get(id)?.status).toBe("running");

	const stopped = await bashOutputTool.execute({ id, kill: true }, context);
	expect(textOf(stopped)).toBe(`[job ${id} stopping]\n(no new output)`);
});

it("后台任务：bash_output 只给上次读之后的，任务结束时报退出码", async () => {
	const context = ctx();
	const started = await bashTool.execute({ command: "echo one; sleep 0.3; echo two", run_in_background: true }, context);
	const id = (started.details as { id: string }).id;
	expect(textOf(started)).toBe(`Started background job ${id}. Read its output with bash_output({ id: "${id}" }).`);

	const first = textOf(await bashOutputTool.execute({ id }, context));
	expect(first).toMatch(/^\[job .* running\]\none\n$/);
	// 刚读过：等到结束才答，中间的一起给。
	const second = textOf(await bashOutputTool.execute({ id }, context));
	expect(second).toBe(`[job ${id} exited with code 0]\ntwo\n`);

	expect(textOf(await bashOutputTool.execute({ id: "nope" }, context))).toBe('No background job with id "nope".');
});

it("命令退出了但它放到后台的进程还拿着输出：不等它，交成后台任务；会话结束时停掉", async () => {
	const context = ctx();
	const began = Date.now();
	const result = await bashTool.execute({ command: "sleep 30 & echo started" }, context);
	expect(Date.now() - began).toBeLessThan(5_000);
	const id = (result.details as { jobId: string }).jobId;
	expect(textOf(result)).toContain("started\n\n[processes it started in the background are still running and holding its output — background job");
	expect(result.isError).toBe(false);

	expect(disposeBackgroundJobs(context.state)).toEqual([]);
	const ended = textOf(await bashOutputTool.execute({ id }, context));
	expect(ended).toMatch(new RegExp(`^\\[job ${id} (terminated|exited with code \\d+)\\]`));
});

it("停下这一轮时命令被杀，结果说是停下的", async () => {
	const controller = new AbortController();
	const pending = bashTool.execute({ command: "echo going; sleep 30" }, ctx({ signal: controller.signal, onProgress: () => controller.abort() }));
	const result = await pending;
	expect(result.isError).toBe(true);
	expect(textOf(result)).toBe("going\n\n\n[cancelled]");
	expect(result.details).toMatchObject({ cancelled: true });
});

/** 记下送了什么的假渠道；`take` 是宿主送出那一刻取的那份。 */
function fakeChannel() {
	const controller = new AbortController();
	const sent: { text: string | (() => string | undefined); delivery?: DeliveryInput }[] = [];
	const channel: BackgroundChannel = {
		signal: controller.signal,
		report: (text, delivery) => {
			if (controller.signal.aborted) return false;
			sent.push({ text, ...(delivery ? { delivery } : {}) });
			return true;
		},
	};
	const take = (index: number) => {
		const { text } = sent[index]!;
		return typeof text === "function" ? text() : text;
	};
	return { channel, sent, take, stop: () => controller.abort() };
}

const ended = (context: ToolContext, id: string) => vi.waitFor(() => expect(backgroundJobs(context.state).get(id)?.finishedAt).toBeDefined());

it("有送达渠道时，后台任务自己结束就把退出状态和没读过的输出送给模型，结果里叫它别轮询", async () => {
	const { channel, sent, take } = fakeChannel();
	const context = ctx({ background: () => channel });
	const started = await bashTool.execute({ command: "echo done; exit 2", description: "跑一下", run_in_background: true }, context);
	const id = (started.details as { id: string }).id;
	expect(textOf(started)).toBe(
		`Started background job ${id}. Keep working: its exit status and new output will be delivered to you as a message when it ends, so do not poll it. ` +
			`Read it earlier with bash_output({ id: "${id}" }) only if you need its output before then.`,
	);
	await ended(context, id);
	expect(sent).toHaveLength(1);
	expect(sent[0]!.delivery).toEqual({
		id,
		title: "跑一下",
		status: "failed",
		inline: true,
		details: { kind: "job", command: "echo done; exit 2", exitCode: 2 },
	});
	expect(take(0)).toBe(
		"你之前放到后台的命令结束了。下面是它的退出状态和你上次读取之后的输出，不用再拿 bash_output 去查：\n\n" +
			`<background_job id="${id}" command="echo done; exit 2" status="exited with code 2">\ndone\n\n</background_job>`,
	);
	// 送达就是替模型读了一次：再读不重发。
	expect(textOf(await bashOutputTool.execute({ id }, context))).toBe(`[job ${id} exited with code 2]\n(no new output)`);
});

it("模型自己读到了结束、或者停掉了它、或者渠道作废了，都不再送", async () => {
	const read = fakeChannel();
	const context = ctx({ background: () => read.channel });
	const job = await bashTool.execute({ command: "echo hi", run_in_background: true }, context);
	const id = (job.details as { id: string }).id;
	await ended(context, id);
	// 攒着还没送出时模型读了：送出那一刻就不送了。
	expect(textOf(await bashOutputTool.execute({ id }, context))).toBe(`[job ${id} exited with code 0]\nhi\n`);
	expect(read.take(0)).toBeUndefined();

	const killed = fakeChannel();
	const other = ctx({ background: () => killed.channel });
	const long = await bashTool.execute({ command: "sleep 30", run_in_background: true }, other);
	const longId = (long.details as { id: string }).id;
	await bashOutputTool.execute({ id: longId, kill: true }, other);
	await ended(other, longId);
	expect(killed.sent).toEqual([]);

	const stopped = fakeChannel();
	const third = ctx({ background: () => stopped.channel });
	const after = await bashTool.execute({ command: "sleep 0.2", run_in_background: true }, third);
	stopped.stop();
	await ended(third, (after.details as { id: string }).id);
	expect(stopped.sent).toEqual([]);
});

it("输出被截过时给出完整日志的路径；标记里的行号就是日志的行号，read 按它读得到省略的那几行", async () => {
	const scratchDir = join(cwd, "scratch");
	const context = ctx({ scratchDir });
	const result = await bashTool.execute({ command: 'for i in $(seq 1 6000); do echo "line $i ......................"; done' }, context);
	const details = result.details as { outputPath: string; outputComplete: boolean };
	expect(details.outputPath.startsWith(join(scratchDir, "tool-output"))).toBe(true);
	expect(details.outputComplete).toBe(true);
	const text = textOf(result);
	expect(text).toContain(`\n\n[full output: ${details.outputPath} — read it with offset/char_offset for the omitted lines]`);
	const log = await readFile(details.outputPath, "utf8");
	expect(log.split("\n")).toHaveLength(6001);
	expect((await stat(details.outputPath)).mode & 0o777).toBe(0o600);
	const [, from, to] = /characters omitted, lines (\d+)-(\d+)/.exec(text)!;
	const omitted = await readTool.execute({ path: details.outputPath, offset: Number(from), limit: 1 }, context);
	expect(textOf(omitted)).toContain(`line ${from} ...`);
	expect(text).not.toContain(`line ${from} ...`);
	expect(text).toContain(`line ${Number(to) + 1} ...`);

	// 没截的不给路径，但日志照样在。
	const short = await bashTool.execute({ command: "echo small" }, context);
	expect(textOf(short)).toBe("small");
	expect(await readFile((short.details as { outputPath: string }).outputPath, "utf8")).toBe("small\n");
});
