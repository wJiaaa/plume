/**
 * bash 和 bash_output：在会话的工作目录里跑一条 shell 命令，跑在审批层给的沙箱模式里。
 *
 * 不会改动的命令（`isReadOnlyCommand`）不问人，也能和相邻的只读调用同时跑；其余的动手前问。命令写明的路径先按
 * 文件工具的读边界判一遍（`authorizeCommandReads`）。超过默认等待还在跑的命令不杀，转成这个会话的后台任务，
 * 模型用 bash_output 读、停；顶层会话里任务自己结束时，退出状态和没读过的输出作为一条运行时送达交给模型（`ToolRun.background`）。
 * 完整输出写进会话临时目录的日志（`output-log.ts`），截过的结果里给出它的路径。
 */

import { randomUUID } from "node:crypto";
import { commandShell } from "@plume/platform";
import type { DeliveryDetails } from "../delivery.ts";
import { escalationDeclined, escalationHint, ESCALATION_TARGETS, escalationTarget, sandboxDenialMarker, validateEscalationArgs } from "../escalation.ts";
import { words } from "../messages.ts";
import { isReadOnlyCommand } from "../read-only-command.ts";
import type { BackgroundChannel, SandboxMode, SandboxProcess, SandboxService } from "@plume/contract";
import { backgroundJobs, type BackgroundJob, type BackgroundJobs } from "./background-jobs.ts";
import { commandChangesForJob, withCommandChanges } from "./command-changes.ts";
import { OutputBuffer } from "./bash-output.ts";
import { createOutputLog, type OutputLog } from "./output-log.ts";
import { describeStatus, readExit } from "./exit-status.ts";
import { authorizeCommandReads } from "./read-access.ts";
import { declinedResult, errorResult } from "./result.ts";
import { rerouteShellCommand } from "./reroute.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { describeCommand, describeJobRead } from "./describe.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** 后台任务的 `output` 留多少。不发给模型，所以不受下面那条线约束。 */
const MAX_OUTPUT_CHARS = 60_000;
/**
 * 一次命令交给模型的输出上限。够看清一次构建、测试的开头结尾和中间摘出来的错误行，又不让一条刷屏的命令
 * 吃掉一大块上下文；超过的部分按整行省略，省略了哪几行写在标记里。
 */
const MODEL_OUTPUT_CHARS = 35_400;

interface BashArgs {
	command: string;
	description?: string;
	timeout?: number;
	run_in_background?: boolean;
	/** 这条命令要的更宽的沙箱模式；只在重试一条刚被沙箱拒了的命令时有效。 */
	escalate?: string;
	/** 为什么要更宽的模式，一句话，原样给人看。 */
	justification?: string;
}

export const bashTool: Tool<BashArgs> = {
	name: "bash",
	describe: describeCommand,
	/*
	 * shell 本身要模型知道的（是哪个 shell、怎么写）不写在这里，写在系统提示词的环境一段：同一个工具给所有会话用，
	 * 而那取决于这台机器和会话的权限模式（Windows 上受约束的命令跑在 PowerShell 里，见 `commandShell`）。
	 */
	description:
		"Run a shell command. Prefer the dedicated tools: read over `cat`/`head`/`tail`, edit over `sed`, glob over `find`, grep over shell `grep`. " +
		"Every call starts fresh in the workspace root — `cd`, variables and functions do not carry over — so chain dependent steps (`cd sub && make`). " +
		"Commands that do not need each other's output (`git status`, `git diff`, `git log`) go out as separate calls in one reply; read-only ones run in parallel. " +
		"Quote paths that may contain spaces. Use `run_in_background: true` for dev servers and slow commands you need not wait on, and keep working; " +
		"the result says whether its exit will be reported to you, otherwise read it with `bash_output`. " +
		"Before your final answer, kill the jobs you started that nobody needs any more; leave a server running only when the user is meant to use it.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "The command to run." },
			description: {
				type: "string",
				description:
					"What this command is for, in 5-10 words and the user's language — it is the line the user reads instead of the command. " +
					'Say the purpose in plain words ("Run the e2e tests", "Check which branches are merged"), not the command, its flags or file paths; ' +
					'not a generic label ("Run command", "Check output"), and no names you coined yourself that the user has never seen.',
			},
			timeout: {
				type: "number",
				description:
					"Hard limit in milliseconds, max 600000: the command is killed when it passes. Without it, a command " +
					"still running after 120000 ms keeps running as a background job.",
			},
			run_in_background: { type: "boolean", description: "Detach the process and return immediately." },
			escalate: {
				type: "string",
				enum: [...ESCALATION_TARGETS],
				description:
					"Only valid as a one-shot retry of a command the sandbox just denied. The narrowest mode that would " +
					"let it through. Requires justification, and asks the user.",
			},
			justification: {
				type: "string",
				description: "One sentence on why the wider mode is needed. Shown to the user verbatim.",
			},
		},
		required: ["command"],
		additionalProperties: false,
	},
	mutating: true,
	// 只有能证明什么都不写的命令才能和别的调用同时跑：两个写的同时跑会在文件上撞车。
	readsOnly: (args) => typeof args.command === "string" && !args.escalate && isReadOnlyCommand(args.command),

	async execute(args, ctx): Promise<ToolResult> {
		if (typeof args.command !== "string" || !args.command.trim()) return errorResult("`command` is required.");

		/*
		 * 裸的 `cat`、`grep`、`find`、`ls` 改道到专用工具。在提权和审批之前：一条要被改道的命令不该先问人「允许吗」
		 * 再说「其实别用这个」。`isError` 让模型换工具；`details.kind` 说明这是改道，不是命令坏了。
		 */
		const reroute = rerouteShellCommand(args.command, ctx.toolNames);
		if (reroute) return { ...errorResult(reroute.message), details: { kind: "reroute", tool: reroute.tool } };

		/*
		 * 提权在任何东西跑起来之前定下。不比现在宽的申请什么都不授予，没东西可决定，不到人面前；到人面前的是模型自己说的理由。
		 * 提权只能由人答：它要的是放宽沙箱，外层的放行和「以后不再问」都不是对这件事的回答（见 tool-run.ts）。
		 */
		let mode = ctx.sandboxMode;
		try {
			validateEscalationArgs(args.escalate, args.justification);
			if (args.escalate !== undefined) {
				const target = escalationTarget(args.escalate, mode ?? "danger-full-access") as Exclude<SandboxMode, "read-only">;
				const title = words().escalate(args.description ?? (args.command.split("\n")[0] ?? "").slice(0, 60));
				const decision = await ctx.requestApproval?.({ kind: "command", title, detail: args.command, reason: args.justification!, escalation: target });
				// i18n-exempt：工具结果是发给模型的，不随界面语言变。
				if (decision === "reject") return errorResult(escalationDeclined("命令", target));
				mode = target;
			}
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}

		// 提权的已经带着更宽的模式问过了，问一次就够。
		const refused = await authorizeCommand(args.command, args.description, ctx, args.escalate === undefined);
		if (refused) return refused;

		/*
		 * 只读命令不拍前后快照、不占改动门闩：它不写文件，快照记不到任何东西，代价却不小——前后各起五六个 git、
		 * 把工作区里每个已改动的文件读一遍。一批并行的 `git log`、`rg` 正好全是只读的（能并行的判定就是它）。
		 */
		const observe: typeof withCommandChanges = isReadOnlyCommand(args.command) ? (ctx, action) => action(ctx) : withCommandChanges;
		return observe(ctx, async (ctx) => {
			if (args.run_in_background) return startBackground(args, ctx, mode);

			/*
			 * 模型给的 timeout 是上限，默认的那个只是不再等的时刻。
			 *
			 * 到默认时限就杀，会扔掉快做完的事（装依赖、跑测试、构建两分钟，重试从头来），也会给 `gh run watch` 这种
			 * 本来就要等的命令一个红叉。过了默认时限命令转成后台任务，模型可以读、可以停；模型自己给了 timeout，
			 * 就是它说过这件事可以花多久，到了照样杀。
			 */
			const hardLimit = args.timeout !== undefined;
			const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
			const outputLog = await openOutputLog(ctx);
			/** 命令活过了这次调用：日志留给接手的后台任务接着写。 */
			let handedOff = false;
			const result = await new Promise<ToolResult>((resolve) => {
				let child: SandboxProcess;
				try {
					child = sandboxOf(ctx).run(args.command, runOptions(ctx, mode));
				} catch (error) {
					// 给不了沙箱的抛错；模型拿到的是这句话，不是崩溃。
					resolve(errorResult(`Failed to start command: ${error instanceof Error ? error.message : String(error)}`));
					return;
				}

				// 累计的原始输出；给模型看的那一份每次从它截一次，见 `bash-output.ts`。
				const buffer = new OutputBuffer();
				const output = () => buffer.render(MODEL_OUTPUT_CHARS);
				let settled = false;
				child.onOutput((chunk) => {
					// 这次调用已经答了，之后的输出归接手的后台任务。
					if (settled) return;
					outputLog?.append(chunk);
					buffer.append(chunk);
					ctx.onProgress?.(chunk);
				});

				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					ctx.signal?.removeEventListener("abort", onAbort);
					if (hardLimit) {
						child.kill();
						resolve({
							content: [{ type: "text", text: `${output()}${fullLogHint(buffer, outputLog?.path)}\n\n[timed out after ${timeout}ms]` }],
							details: { kind: "bash", command: args.command, timedOut: true },
							isError: true,
						});
						return;
					}
					handedOff = true;
					const id = adoptJob(ctx, args, child, outputLog, buffer);
					resolve({
						content: [
							{
								type: "text",
								text:
									`${output().trim() || "(no output yet)"}${fullLogHint(buffer, outputLog?.path)}\n\n[still running after ${Math.round(timeout / 1000)}s — ` +
									`now background job ${id}. ${followUp(ctx, id)} ` +
									`Stop it with bash_output({ id: "${id}", kill: true }).]`,
							},
						],
						// `job` 是给宿主和别的插件看的通用声明（`BackgroundJobDetails`）：这次调用在后台起了任务。
						details: { kind: "bash", command: args.command, backgrounded: true, jobId: id, job: { id, command: args.command } },
					});
				}, timeout);

				const onAbort = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					child.kill();
					resolve({
						content: [{ type: "text", text: `${output()}\n\n[cancelled]` }],
						details: { kind: "bash", command: args.command, cancelled: true },
						isError: true,
					});
				};
				ctx.signal?.addEventListener("abort", onAbort, { once: true });
				if (ctx.signal?.aborted) onAbort();

				child.onError((error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					ctx.signal?.removeEventListener("abort", onAbort);
					resolve(errorResult(`Failed to start command: ${error.message}`));
				});

				child.onExit((code, signal, lingering) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					ctx.signal?.removeEventListener("abort", onAbort);
					const text = output().trim();
					/*
					 * 是沙箱拒的就说出来：被拒的写入和磁盘满、路径错一样只是非零退出，分不清的模型会换个写法再写三遍，
					 * 然后报告工具坏了。标记把「失败了」说成「被拒了」，旁边是正当的出路。
					 */
					const denied = mode !== undefined && mode !== "danger-full-access" && sandboxOf(ctx).looksDenied(output());
					/*
					 * 按人的读法判失败（见 `exit-status.ts`）：`grep` 没找到、`gh pr checks` 报检查还在跑，都是答案。
					 * 退出码总是用字写给模型：只有部分服务商的协议带 `is_error`，别的协议下失败的构建和通过的长得一样。
					 */
					// 按命令是照哪个 shell 写的读：会话宣布的模式选的那个，提权不改它。
					const reading = readExit(args.command, code, output(), commandShell(ctx.sandboxMode).kind);
					const status = code === 0 ? undefined : `[${describeStatus(code, signal)}${reading.meaning ? ` — ${reading.meaning}; not a failure` : ""}]`;
					const leftBehind = lingering ? adoptJob(ctx, args, lingering, undefined) : undefined;
					// i18n-exempt：工具结果是发给模型的，不随界面语言变。
					const markers = [
						...(denied && mode ? [sandboxDenialMarker(mode), escalationHint("命令")] : []),
						...(leftBehind
							? [
									`[processes it started in the background are still running and holding its output — background job ${leftBehind}. ` +
										`Read it with bash_output({ id: "${leftBehind}" }); stop it with bash_output({ id: "${leftBehind}", kill: true }). ` +
										"They are stopped when the session ends.]",
								]
							: []),
					];
					const body = [`${text || "(no output)"}${fullLogHint(buffer, outputLog?.path)}`, ...(status ? [status] : []), ...markers].join("\n\n");
					resolve({
						content: [{ type: "text", text: body }],
						details: {
							kind: "bash",
							command: args.command,
							exitCode: code,
							...(signal ? { signal } : {}),
							...(reading.meaning && !reading.failed ? { exitMeaning: reading.meaning } : {}),
							...(denied ? { denied: true } : {}),
							...(leftBehind ? { jobId: leftBehind } : {}),
						},
						isError: reading.failed || denied,
					});
				});
			});
			const logged = handedOff ? (outputLog ? { outputPath: outputLog.path } : {}) : await outputLog?.close();
			return logged ? { ...result, details: { ...(result.details as object | undefined), ...logged } } : result;
		});
	},
};

/** 写不了日志（临时目录建不出来、磁盘满）不挡命令：只是截过的结果里少一句完整日志在哪。 */
async function openOutputLog(ctx: ToolContext): Promise<OutputLog | undefined> {
	return createOutputLog(ctx.scratchDir).catch(() => undefined);
}

/**
 * 输出被截过时告诉模型完整日志在哪：只放在 `details` 里模型看不到，标记里的行号和 `char_offset` 就无处可用。
 * 日志在会话临时目录下，`read` 不用问；标记里的行号就是这个文件的行号。
 */
function fullLogHint(buffer: OutputBuffer, path: string | undefined): string {
	if (!path || !buffer.clipped(MODEL_OUTPUT_CHARS)) return "";
	return `\n\n[full output: ${path} — read it with offset/char_offset for the omitted lines]`;
}

/**
 * 一条命令能不能跑：它读什么，以及——除非能证明什么都不写——人怎么说。`undefined` 是能跑，别的是代替运行返回的结果。
 *
 * `monitor` 也跑 shell 命令，共用这一道，不能成为绕过它的路：两者问的 `kind` 都是 `bash`，审批层按它判命令的风险。
 * `ask` 只对提权的为 false：那次已经带着更宽的模式问过了。
 */
export async function authorizeCommand(command: string, title: string | undefined, ctx: ToolContext, ask = true): Promise<ToolResult | undefined> {
	const refusedRead = await authorizeCommandReads(command, ctx);
	if (refusedRead) return errorResult(refusedRead);
	if (ask && ctx.requestApproval && !isReadOnlyCommand(command)) {
		const decision = await ctx.requestApproval({ kind: "command", title: title ?? "Run shell command", detail: command, subject: command });
		if (decision !== "once" && decision !== "always") return declinedResult("The user rejected this command.");
	}
	return undefined;
}

/**
 * 一个后台任务的两份输出：`all` 从头累计，`unread` 是模型上次读之后的。每次轮询都把 `all` 整份重发的话，
 * 一个开发服务器轮询十次就是十份同样的日志。
 */
interface JobStream {
	all: OutputBuffer;
	unread: OutputBuffer;
	/** 在 bash_output 里等这个任务打印或结束的。 */
	wake: Set<() => void>;
	/** 模型上一次看到这份输出的时刻：一次 bash_output、一次送达，或交出任务的那条 bash 结果。 */
	readAt?: number;
}
const streams = new WeakMap<BackgroundJob, JobStream>();

/**
 * 把一个还在跑的进程留作这个会话的后台任务：超过默认时限的命令，和命令退出后留下来拿着输出的进程。
 * 和 `run_in_background` 起的一样能读能停、结束时送达，删会话时一起停掉。`seen` 是模型在这次结果里已经看过的输出。
 */
function adoptJob(ctx: ToolContext, args: BashArgs, process: SandboxProcess, outputLog: OutputLog | undefined, seen?: OutputBuffer): string {
	const job = newJob(args, process, outputLog);
	track(job, process, ctx, outputLog, seen);
	return job.id;
}

function newJob(args: { command: string; description?: string }, process: SandboxProcess, outputLog: OutputLog | undefined, kind?: "monitor"): BackgroundJob {
	return {
		id: randomUUID(),
		command: args.command,
		...(args.description ? { description: args.description } : {}),
		...(kind ? { kind } : {}),
		startedAt: Date.now(),
		exitCode: null,
		output: "",
		...(outputLog ? { outputPath: outputLog.path } : {}),
		...(process.pid === undefined ? {} : { pid: process.pid }),
		status: "running",
	};
}

/** 跟着一个任务的输出和退出，不管是谁起的；它自己结束时告诉模型（`reportEnd`）。 */
function track(job: BackgroundJob, process: SandboxProcess, ctx: ToolContext, outputLog: OutputLog | undefined, seen?: OutputBuffer): void {
	const all = seen ?? new OutputBuffer();
	const stream: JobStream = { all, unread: new OutputBuffer(all.end), wake: new Set(), ...(seen ? { readAt: Date.now() } : {}) };
	const news = () => {
		for (const wake of stream.wake) wake();
	};
	streams.set(job, stream);
	Object.defineProperty(job, "output", { get: () => all.render(MAX_OUTPUT_CHARS), enumerable: true, configurable: true });
	const jobs = backgroundJobs(ctx.state);
	const closeLog = () => void outputLog?.close().then((record) => Object.assign(job, record));
	const follow = (process: SandboxProcess, channel: BackgroundChannel | undefined) => {
		jobs.add(job, process, channel);
		process.onOutput((chunk) => {
			outputLog?.append(chunk);
			stream.all.append(chunk);
			stream.unread.append(chunk);
			news();
		});
		process.onExit((code, _signal, lingering) => {
			if (lingering) {
				// 还有进程拿着输出：同一个任务接着跟它，渠道沿用起任务时的那一条。
				follow(lingering, channel);
				return;
			}
			closeLog();
			job.exitCode = code;
			job.finishedAt = Date.now();
			job.status = code !== null && code !== 0 ? "failed" : "exited";
			reportEnd(job, jobs);
			news();
		});
		process.onError((error) => {
			closeLog();
			job.error = error.message;
			job.status = "failed";
			job.finishedAt = Date.now();
			// 起不来的错误在「Started background job」已经答出去以后才到，也是一种结束。
			reportEnd(job, jobs);
			news();
		});
	};
	follow(process, ctx.background?.());
}

/**
 * 一个自己结束了的后台任务送给模型：模型不用再拿 bash_output 一遍遍去问「好了没」，每问一次都是一整轮请求；这一轮已经说完的时候，
 * 它跑完了也有人把会话叫醒。送达攒一会儿再送，送出那一刻再问一次该不该送：这期间模型可能已经自己读过，或者有人停了它。
 * 送出的就是替模型做的那一次读取（`readJob`），之后再读不会重发同一段。
 */
function reportEnd(job: BackgroundJob, jobs: BackgroundJobs): void {
	const channel = jobs.channel(job.id);
	if (!channel || jobs.isQuiet(job.id)) return;
	channel.report(
		() => {
			if (jobs.isQuiet(job.id)) return undefined;
			jobs.observed(job.id);
			const { status, text } = readJob(job);
			// i18n-exempt：送给模型的话，不随界面语言变。
			return (
				"你之前放到后台的命令结束了。下面是它的退出状态和你上次读取之后的输出，不用再拿 bash_output 去查：\n\n" +
				`<background_job id="${job.id}" command="${attribute(job.command)}" status="${attribute(status)}">\n${text}\n</background_job>`
			);
		},
		{
			id: job.id,
			title: job.description || job.command,
			status: job.status === "failed" ? "failed" : "done",
			inline: true,
			details: { kind: "job", command: job.command, exitCode: job.exitCode } satisfies DeliveryDetails,
		},
	);
}

/** 标签属性里的值：引号换掉，换行压平，免得一句描述把标签撑破。 */
export function attribute(value: string): string {
	return value.replaceAll('"', "'").replace(/\s+/g, " ").trim();
}

/** 命令经服务 `sandbox` 跑；没有它（不该发生：plume.tools 要等它就位才加载）就起不了命令。 */
function sandboxOf(ctx: ToolContext): SandboxService {
	if (!ctx.sandbox) throw new Error("no sandbox service to run commands");
	return ctx.sandbox;
}

/**
 * 交给服务 `sandbox` 的选项：`mode` 是这一次跑在哪一档（提权过的就是更宽的那档），`shellMode` 是会话宣布的那一档，
 * shell 按它选：提权的命令仍是模型照系统提示词里那个 shell 写的，提成完全访问的 PowerShell 命令还是 PowerShell。
 */
function runOptions(ctx: ToolContext, mode: SandboxMode | undefined): Parameters<SandboxService["run"]>[1] {
	return { cwd: ctx.cwd, ...(mode ? { mode } : {}), ...(ctx.sandboxMode ? { shellMode: ctx.sandboxMode } : {}) };
}

/**
 * 把一条命令起成这个会话的后台任务：进沙箱、写日志、能用 bash_output 读、结束时送达。`monitor` 也从这里起，
 * 它和 `run_in_background` 的不同只在怎么处理输出，不在怎么跑。`mode` 是提权后的那档，不给就是会话的。
 */
export async function launchJob(
	args: { command: string; description?: string },
	ctx: ToolContext,
	kind?: "monitor",
	mode: SandboxMode | undefined = ctx.sandboxMode,
): Promise<{ job: BackgroundJob; process: SandboxProcess } | { error: string }> {
	const outputLog = await openOutputLog(ctx);
	let child: SandboxProcess;
	try {
		child = sandboxOf(ctx).run(args.command, runOptions(ctx, mode));
	} catch (error) {
		await outputLog?.close();
		return { error: `Failed to start command: ${error instanceof Error ? error.message : String(error)}` };
	}
	const job = newJob(args, child, outputLog, kind);
	track(job, child, ctx, outputLog);
	return { job, process: child };
}

async function startBackground(args: BashArgs, ctx: ToolContext, mode: SandboxMode | undefined): Promise<ToolResult> {
	const started = await launchJob(args, ctx, undefined, mode);
	if ("error" in started) return errorResult(started.error);
	const { id, outputPath } = started.job;
	return {
		content: [{ type: "text", text: `Started background job ${id}. ${followUp(ctx, id)}` }],
		// `job` 是给宿主看的通用声明（`BackgroundJobDetails`）：转录据此把查它输出的那几行说成起它那次调用写的说明。
		details: { kind: "bash_background", id, command: args.command, job: { id, command: args.command }, ...(outputPath ? { outputPath } : {}) },
	};
}

interface BashOutputArgs {
	id: string;
	kill?: boolean;
}

export const bashOutputTool: Tool<BashOutputArgs> = {
	name: "bash_output",
	describe: describeJobRead,
	description:
		"Read a background job's new output since your last bash_output call (the first call returns everything so far), and optionally kill it. " +
		"While it runs, a call within 30s of your last read waits until it ends or those 30s are up, and returns everything printed meanwhile.",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string", description: "Job id returned by bash." },
			kill: { type: "boolean", description: "Terminate the job after reading its output." },
		},
		required: ["id"],
		additionalProperties: false,
	},

	async execute(args, ctx): Promise<ToolResult> {
		const jobs = backgroundJobs(ctx.state);
		const job = typeof args.id === "string" ? jobs.get(args.id) : undefined;
		if (!job) return errorResult(`No background job with id "${args.id}".`);
		if (args.kill) jobs.stop(args.id, true);
		else await waitForNews(job, ctx.signal);
		jobs.observed(args.id);
		const { status, text } = readJob(job);
		return {
			content: [{ type: "text", text: `[job ${job.id} ${status}]\n${text}` }],
			details: {
				kind: "bash_output",
				id: job.id,
				exitCode: job.exitCode,
				command: job.command,
				...(job.outputPath ? { outputPath: job.outputPath } : {}),
				...(job.outputComplete === undefined ? {} : { outputComplete: job.outputComplete }),
				...(job.outputError ? { outputError: job.outputError } : {}),
				...(await commandChangesForJob(ctx, job.id)),
			},
		};
	},
};

/**
 * 任务还在跑时，一次 bash_output 什么时候答。
 *
 * 模型会轮询，而没有新输出时立刻答，每次拿回的就是「(no new output)」；边跑边打印的测试、安装，模型一轮请求的几秒里
 * 总攒下几行，「有新输出就答」等于每几秒一整轮请求。所以距上次读不到 30 秒时，只有任务结束或满 30 秒才答，中途的
 * 输出攒到那时一起给。第一次读、隔了 30 秒以上再读，有输出立刻给：开发服务器起没起来，要的就是那一行。按停止立刻返回。
 */
const NEWS_WAIT_MS = 30_000;

function waitForNews(job: BackgroundJob, signal: AbortSignal | undefined): Promise<void> {
	const stream = streams.get(job);
	if (!stream || job.finishedAt !== undefined || signal?.aborted) return Promise.resolve();
	const since = stream.readAt === undefined ? Infinity : Date.now() - stream.readAt;
	const recent = since < NEWS_WAIT_MS;
	if (!recent && stream.unread.size > 0) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			stream.wake.delete(news);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const news = () => {
			if (!recent || job.finishedAt !== undefined) done();
		};
		const timer = setTimeout(done, recent ? NEWS_WAIT_MS - since : NEWS_WAIT_MS);
		stream.wake.add(news);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * 一个后台任务此刻的状态，和模型上次读过之后的输出；读完游标移到末尾。bash_output 和结束时的送达共用它：
 * 送达就是替模型做了那一次读取。更早的部分模型已经看过，要回看就读完整日志。
 */
function readJob(job: BackgroundJob): { status: string; text: string } {
	const status =
		job.finishedAt === undefined
			? job.status
			: job.exitCode === null
				? job.error
					? `failed: ${job.error}`
					: "terminated"
				: `exited with code ${job.exitCode}`;
	const stream = streams.get(job);
	let text = job.output;
	let hint = "";
	if (stream) {
		text = stream.unread.render(MODEL_OUTPUT_CHARS);
		hint = fullLogHint(stream.unread, job.outputPath);
		markJobRead(job);
	}
	return { status, text: `${text || "(no new output)"}${hint}` };
}

/**
 * 这个任务到此为止的输出模型都看过了，不是经 bash_output：`monitor` 送达过。之后的 bash_output 从这之后开始，不再重发。
 *
 * `unsent` 是末尾没送出去的那截——`monitor` 还没等到收尾的一行，或填满 `max_events` 那一行之后的——仍算没读，所以命令怎么结束的
 * 那次送达不会从一行的中间开始。它从一行的开头起，或者不含换行，所以能从末尾倒推出它的位置。
 */
export function markJobRead(job: BackgroundJob, unsent = ""): void {
	const stream = streams.get(job);
	if (!stream) return;
	const end = stream.all.end;
	const breaks = unsent.split("\n").length - 1;
	stream.unread = new OutputBuffer(breaks === 0 ? { line: end.line, column: end.column - unsent.length } : { line: end.line - breaks, column: 0 });
	stream.unread.append(unsent);
	stream.readAt = Date.now();
}

/**
 * 刚起的任务接下来怎么办。会送达的地方明说：只被告知「用 bash_output 读」的模型会轮询，每问一次都是一整轮请求。
 * 子会话的任务没人送达，只能叫它自己读。
 */
function followUp(ctx: ToolContext, id: string): string {
	return ctx.background
		? "Keep working: its exit status and new output will be delivered to you as a message when it ends, so do not poll it. " +
				`Read it earlier with bash_output({ id: "${id}" }) only if you need its output before then.`
		: `Read its output with bash_output({ id: "${id}" }).`;
}
