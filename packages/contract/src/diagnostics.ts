import type { AssistantMessage, Message, ToolSpec } from "@plume/llm/types";
import type { AgentEvent, TurnStop } from "./service.ts";

/** 会话的只读运行观察，不包含供应商配置、请求头和密钥。观察者失败不影响运行。 */
export interface SessionObservation {
	sessionId: string;
	/** 观察时已有的消息数；撤回时诊断记录跟着截断。 */
	at: number;
	timestamp: number;
	event:
		| Extract<AgentEvent, { type: "toolStart" | "approval" | "hiccups" | "notice" | "rewound" }>
		| { type: "request"; id: string; provider: string; model: string; systemPrompt: string; messages: Message[]; tools: ToolSpec[] }
		| { type: "response"; id: string; reply: AssistantMessage }
		| { type: "running"; running: boolean }
		/** 一轮收场了、为什么收场：完成、出错、被停下、用满步数、原地打转，退出应用时停下的是 `interrupted`。 */
		| { type: "turnEnd"; stop: TurnStop };
}

/**
 * 会话里登记着的一项后台任务（`ToolRun.track` 登记的），`ctx.sessions.jobs` 列出的样子。只按所属会话和任务 id 操作，不能传 pid 或日志路径。
 */
export interface BackgroundJobInfo {
	id: string;
	command: string;
	description?: string;
	startedAt: number;
	finishedAt?: number;
	exitCode: number | null;
	pid?: number;
	/** `stopping`：经 `ctx.sessions.stopJob`（或删会话）叫它停了，还没退出。 */
	status: "running" | "stopping" | "exited" | "failed";
	error?: string;
	/** 每有新输出就叫醒这个会话开一轮（监视命令）：人得认得出哪一个在持续花钱。普通后台命令没有。 */
	wakes?: true;
}

/** 一项后台任务的尾部输出（`ctx.sessions.jobOutput`）：给人看的，不算模型读过，也不消费它的送达。 */
export interface BackgroundJobOutput {
	text: string;
	/** 任务结束了、输出也写全了。 */
	done: boolean;
	/** 只给了尾部，前面还有。 */
	truncated: boolean;
	error?: string;
}

/**
 * 一个会话里约好的「以后再接着做」（`ToolRun.schedule`），还没触发的那一个：`kind: "wakeup"` 是到某个时刻的一次性唤醒，
 * `"cron"` 按 cron 表达式触发（一次或循环）。只活在 agent 进程的内存里：退出应用、人按停止、撤回或编辑重发截掉约它的那次调用都会取消。
 */
export interface SessionWakeup {
	/** `wake-1`、`cron-2`，在会话里唯一。 */
	id: string;
	kind: "wakeup" | "cron";
	/** 到点时要接着做的事，模型写给自己的。 */
	prompt: string;
	/** 给人看的几个字；没有时界面用 `prompt` 的第一行。 */
	reason?: string;
	/** 5 段 cron 表达式，本地时间；一次性唤醒没有。 */
	cron?: string;
	recurring: boolean;
	createdAt: number;
	/** 下一次触发的时刻。 */
	nextAt: number;
	/** 循环任务过期的时刻，之后不再触发。 */
	expiresAt?: number;
	/** 已经触发过几次。 */
	fired: number;
}
