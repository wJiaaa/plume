/**
 * `monitor`：起一条长期跑的命令，它一边跑一边把新输出的行送给模型。
 *
 * `run_in_background` 的 bash 只在命令结束时送一次——构建正合适，`tail -f`、watch 模式的编译器却永远不结束，每一行都可能是要紧的那行。
 * 跑命令的事全是 bash 的：审批和风险判断（`authorizeCommand`）、沙箱、日志、任务表（`launchJob`）。这里只管拿输出怎么办。
 *
 * 怎么办由花费定：每次送达碰上空闲的会话就开一轮，一轮要把整段前缀重发一遍——一行一轮的话，一个话多的日志会是会话里最贵的东西。
 * 所以行要凑成批、批与批隔开、每批有上限，说明里叫模型在命令里先滤一遍。下面的数就是这笔预算，各自写着在为什么付钱。
 */

import type { DeliveryDetails } from "../delivery.ts";
import { backgroundJobs, type BackgroundJob, type BackgroundJobs } from "./background-jobs.ts";
import { attribute, authorizeCommand, launchJob, markJobRead } from "./bash.ts";
import { errorResult } from "./result.ts";
import type { BackgroundChannel, SandboxProcess } from "@plume/contract";
import type { Tool, ToolResult } from "./types.ts";

/**
 * 第一行新输出之后，等多久把同一阵的其余行凑齐。
 *
 * 输出是一阵一阵来的——一段栈、重新构建打出的摘要——行与行隔几毫秒。第一行就送，一阵就是两次送达、两轮；等一秒就是一次，
 * 照着日志做事的人察觉不到这一秒。
 */
const GATHER_MS = 1_000;
/**
 * 同一个 monitor 两次送达至少隔多久；这期间来的行等下一批。
 *
 * 一条话多的命令能花掉几轮就靠它封顶：不管打印多快，一分钟最多六轮。十秒对「重新构建失败了」仍然够快，那是有人会盯着等的最慢的事；
 * 再长，「编译好了告诉我」就不值得了。
 */
const MIN_INTERVAL_MS = 10_000;
/**
 * 一次送达最多带多少字；超了留最新的行、只数一下其余的。
 *
 * 送达留在历史里，之后每一轮都重发。4000 字约一千 token，放得下一整个带栈的错误，又小到一个用满行数上限的 monitor 不会让上下文翻倍。
 * 留最新的，因为监视的东西最新的状态才是现在为真的；更早的在磁盘上的完整日志里。
 */
const DELIVERY_MAX_CHARS = 4_000;
/** 单行截在这里：打成一行的压缩包不能独自占满一次送达。 */
const LINE_MAX_CHARS = 1_000;
/** 还没换行的文字长到这么长就当一行：进度条永远不换行。 */
const PARTIAL_MAX_CHARS = 4_096;
/**
 * 多少行以后自己停。
 *
 * 最坏情况下每行都是单独一次送达——滤得很严的日志一分钟出一行——也就是单独一轮。一百轮已经超过任何监视值得的花费；
 * 要更多的应当滤得更严，或者要到一千行为止。
 */
const DEFAULT_MAX_EVENTS = 100;
const MAX_MAX_EVENTS = 1_000;
/**
 * 多久没输出就自己停。
 *
 * 安静不花 token，只占一个进程，所以这条是为了「忘了」而不是为了「花钱」——滤得好的 monitor 本来大部分时候就是安静的。
 * 十分钟够撑过两次编辑之间一次慢构建；一小时是一个被忘掉的 monitor 最多能占着的。
 */
const DEFAULT_IDLE_MS = 600_000;
const MAX_IDLE_MS = 3_600_000;
const MIN_IDLE_MS = 1_000;

interface MonitorArgs {
	command: string;
	description?: string;
	max_events?: number;
	idle_timeout?: number;
}

export const monitorTool: Tool<MonitorArgs> = {
	name: "monitor",
	/*
	 * 每次请求都发，所以只写决定要不要调、怎么调的。凑批的数、上限、怎么停，调过以后在结果里说。
	 */
	description:
		"Run a long-lived command — `tail -f` on a log, a build or test runner in watch mode, a polling loop — and get its new output lines delivered to you as messages while it runs. " +
		"Not for a command you are only waiting to finish: `bash` with `run_in_background` already reports when it ends. " +
		"Each delivery may cost a turn, so filter in the command to the lines you would act on, line-buffered (`grep --line-buffered`, `sed -u`) or the pipe holds them back: " +
		"`npm run dev 2>&1 | grep --line-buffered -E 'error|compiled'`.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "The command to run. stdout and stderr both count; every non-empty line is an event." },
			description: {
				type: "string",
				description:
					"What this watches, in 5-10 words and the user's language — it is the line the user reads instead of the command " +
					'("Watch the dev server for errors"), not the command or its flags.',
			},
			max_events: {
				type: "integer",
				description: `Stop after this many lines. Default ${DEFAULT_MAX_EVENTS}, max ${MAX_MAX_EVENTS}.`,
			},
			idle_timeout: {
				type: "integer",
				description: `Stop after this many milliseconds without output. Default ${DEFAULT_IDLE_MS}, max ${MAX_IDLE_MS}.`,
			},
		},
		required: ["command"],
		additionalProperties: false,
	},
	mutating: true,

	async execute(args, ctx): Promise<ToolResult> {
		if (typeof args.command !== "string" || !args.command.trim()) return errorResult("`command` is required.");
		/*
		 * 子会话拿不到送达渠道，输出没人收，这个工具就没有意义；plume.tools 已经不把它列给子会话（见 `index.ts`），这里是兜底。
		 * 在审批之前：问人一个注定做不成事的命令，是白问。
		 */
		const channel = ctx.background?.();
		if (!channel) {
			return errorResult("monitor is not available here: nothing would receive its output. Use bash with run_in_background and read it with bash_output.");
		}
		const refused = await authorizeCommand(args.command, args.description, ctx);
		if (refused) return refused;

		const started = await launchJob(args, { ...ctx, background: () => channel }, "monitor");
		if ("error" in started) return errorResult(started.error);
		const maxEvents = clamp(args.max_events, DEFAULT_MAX_EVENTS, 1, MAX_MAX_EVENTS);
		const idleMs = clamp(args.idle_timeout, DEFAULT_IDLE_MS, MIN_IDLE_MS, MAX_IDLE_MS);
		follow(started.job, started.process, backgroundJobs(ctx.state), channel, maxEvents, idleMs);
		const { id, outputPath } = started.job;
		return {
			content: [
				{
					type: "text",
					text:
						`Started monitor ${id}. Keep working: its new output lines will be delivered to you as messages, so do not poll it. ` +
						`They come in batches, at most one every ${MIN_INTERVAL_MS / 1000}s, each keeping the newest ${DELIVERY_MAX_CHARS} characters. ` +
						`It stops after ${maxEvents} lines or ${Math.round(idleMs / 1000)}s without output, or when the person presses Stop; ` +
						`stop it with bash_output({ id: "${id}", kill: true }) as soon as you no longer need it.`,
				},
			],
			details: { kind: "monitor", id, command: args.command, ...(outputPath ? { outputPath } : {}) },
		};
	},
};

function clamp(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.round(value), min), max);
}

/** 一批新输出：最新的那些行，和这一批一共几行、前面丢了几行；最后一批带着为什么停。 */
interface Batch {
	text: string;
	lines: number;
	dropped: number;
	stopped?: { reason: "max_events" | "idle"; limit: number };
}

/**
 * 把一个在跑的任务的输出分批送给模型，到了上限就停。
 *
 * 它自己结束不在这里送：自己退出的命令和别的后台任务一样由 bash 送（`reportEnd`），那次送达读的是上一批之后打印的——正是这里还没送的，
 * 因为每送一批都把任务标成已读。这里再送一次就是同样的行说两遍。
 */
function follow(job: BackgroundJob, process: SandboxProcess, jobs: BackgroundJobs, channel: BackgroundChannel, maxEvents: number, idleMs: number): void {
	let partial = "";
	let pending: string[] = [];
	let events = 0;
	let lastSent = -Infinity;
	let done = false;
	/** 到了自己的上限停下的：之后 `stop` 把它标成停过，但它最后那几批正是要告诉模型的。 */
	let selfStopped = false;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const deliver = (stopped?: Batch["stopped"]) => {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		if (pending.length === 0 && !stopped) return;
		const batch: Batch = { ...newest(pending), ...(stopped ? { stopped } : {}) };
		pending = [];
		lastSent = Date.now();
		markJobRead(job, partial);
		/*
		 * 送出那一刻再看一眼：攒着的这一会儿里有人用 bash_output 停了它，这批就不送了——停它的人不想再听它说话。
		 * 自己停下的不算，见 `selfStopped`。
		 */
		channel.report(() => (selfStopped || !jobs.wasStopped(job.id) ? monitorBlock(job, batch) : undefined), {
			id: job.id,
			title: job.description || job.command,
			status: "done",
			inline: true,
			details: {
				kind: "job",
				command: job.command,
				monitor: { lines: batch.lines, ...(stopped ? { stopped: stopped.reason } : {}) },
			} satisfies DeliveryDetails,
		});
	};
	const schedule = () => {
		if (flushTimer !== undefined) return;
		const now = Date.now();
		flushTimer = setTimeout(() => deliver(), Math.max(now + GATHER_MS, lastSent + MIN_INTERVAL_MS) - now);
		flushTimer.unref?.();
	};
	const end = () => {
		done = true;
		pending = [];
		clearTimeout(flushTimer);
		clearTimeout(idleTimer);
	};
	/*
	 * 到了自己的上限：最后一批说清为什么，然后进程走人。经 `stop`，它把任务标成不再送达，所以随后的退出不会再当成一个结束了的
	 * 后台命令送一遍——这一批就是那次送达。
	 */
	const finish = (reason: "max_events" | "idle", limit: number) => {
		if (done) return;
		selfStopped = true;
		deliver({ reason, limit });
		end();
		try {
			jobs.stop(job.id);
		} catch {
			// 停不掉的记在任务上了。
		}
	};
	const armIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => finish("idle", idleMs), idleMs);
		idleTimer.unref?.();
	};

	/*
	 * `partial` 是还没当成一行的全部，也是 `deliver` 留作未读的：平常一批是还在打印的那一行；到了 `max_events`，还有这一段剩下的。
	 * 两种情况它都从一行的开头起或不含换行，见 `markJobRead`。
	 */
	process.onOutput((chunk) => {
		if (done) return;
		armIdle();
		const text = partial + chunk;
		let from = 0;
		for (;;) {
			const at = text.indexOf("\n", from);
			if (at === -1 && text.length - from <= PARTIAL_MAX_CHARS) break;
			const raw = text.slice(from, at === -1 ? text.length : at);
			from = at === -1 ? text.length : at + 1;
			const line = clean(raw);
			if (!line) continue;
			pending.push(line);
			if (++events >= maxEvents) {
				partial = text.slice(from);
				finish("max_events", maxEvents);
				return;
			}
		}
		partial = text.slice(from);
		if (pending.length > 0) schedule();
	});
	process.onExit(end);
	process.onError(end);
	armIdle();
}

/** 一批里放得进一次送达的最新那些行，和更早的放不下的有几行。 */
function newest(lines: string[]): Omit<Batch, "stopped"> {
	let size = 0;
	let from = lines.length;
	while (from > 0 && size + lines[from - 1]!.length + 1 <= DELIVERY_MAX_CHARS) size += lines[--from]!.length + 1;
	return { text: lines.slice(from).join("\n"), lines: lines.length, dropped: from };
}

/** 一批 monitor 输出给模型的样子：丢了多少行、为什么停了都写在标签里面，模型读到的和它看见的行在一处。 */
function monitorBlock(job: BackgroundJob, batch: Batch): string {
	// i18n-exempt：送给模型的话，不随界面语言变。
	const dropped =
		batch.dropped > 0 ? [`[更早的 ${batch.dropped} 行超出单次送达的上限，没有放进来${job.outputPath ? `；完整输出在 ${job.outputPath}` : ""}]`] : [];
	const stopped =
		batch.stopped?.reason === "max_events"
			? [`[监视已停止：输出满了 max_events 的 ${batch.stopped.limit} 行，进程已结束]`]
			: batch.stopped?.reason === "idle"
				? [`[监视已停止：${Math.round(batch.stopped.limit / 1000)} 秒没有新输出（idle_timeout），进程已结束]`]
				: [];
	const body = [...dropped, ...(batch.text ? [batch.text] : []), ...stopped].join("\n");
	return (
		"你用 monitor 监视的命令有新输出，下面是上次送达之后的新行，不用拿 bash_output 去查。" +
		"只在这些输出需要你处理时才行动，否则一句话带过；用不着它了就用 bash_output 加 kill: true 停掉：\n\n" +
		`<monitor_events id="${job.id}" command="${attribute(job.command)}" lines="${batch.lines}" status="${batch.stopped ? "stopped" : "running"}">\n${body}\n</monitor_events>`
	);
}

// oxlint-disable-next-line no-control-regex -- 要匹配的就是终端转义序列
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// oxlint-disable-next-line no-control-regex -- 转义序列去掉以后剩下的控制字符
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** 一行在终端里最后留下的样子：颜色去掉，用 `\r` 重画的行（进度条、转圈）只留最后一次——不然每次重画都是一行。 */
function clean(raw: string): string {
	const line = raw
		.slice(raw.lastIndexOf("\r", raw.length - 2) + 1)
		.replace(ESCAPES, "")
		.replace(CONTROLS, "")
		.trimEnd();
	return line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line;
}
