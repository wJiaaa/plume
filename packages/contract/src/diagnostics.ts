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

/** 后台进程只按所属会话和任务 id 操作，不能传 pid 或日志路径。 */
export interface BackgroundJobInfo {
	id: string;
	command: string;
	description?: string;
	startedAt: number;
	finishedAt?: number;
	exitCode: number | null;
	pid?: number;
	status: "running" | "stopping" | "exited" | "failed";
	error?: string;
	/** 每有新输出就叫醒这个会话开一轮（监视命令）：人得认得出哪一个在持续花钱。普通后台命令没有。 */
	wakes?: true;
}

export interface BackgroundJobsService {
	list(sessionId: string): BackgroundJobInfo[];
	/** 尾部输出；不标记为模型已读，不消费后台送达。 */
	output(sessionId: string, jobId: string): Promise<{ text: string; done: boolean; truncated: boolean; error?: string }>;
	stop(sessionId: string, jobId: string, force: boolean): boolean;
}

/**
 * 模型给一个会话安排的「以后再接着做」：`schedule_wakeup` 的一次性唤醒（`kind: "wakeup"`）或 `cron_create` 的定时触发，还没触发的那一个。
 * 只活在 agent 进程的内存里：退出应用、人按停止、撤回或编辑重发都会取消。
 */
export interface SessionWakeup {
	/** `wake-1`、`cron-2`，在会话里唯一。 */
	id: string;
	kind: "wakeup" | "cron";
	/** 到点时送给模型的那段话，模型写给自己的。 */
	prompt: string;
	/** 给人看的几个字（一次性唤醒必填）；没有时界面用 `prompt` 的第一行。 */
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

/** 服务 `session.wakeups`：读、取消会话里待触发的定时唤醒。内置插件 plume.tools 提供（它注册 `schedule_wakeup`、`cron_*` 这几件工具）。 */
export interface SessionWakeupsService {
	/** 按下一次触发的先后；会话没有、没安排过时是空数组。 */
	list(sessionId: string): SessionWakeup[];
	/** 取消一个；已经触发了、不存在时返回 false。 */
	cancel(sessionId: string, id: string): boolean;
}
