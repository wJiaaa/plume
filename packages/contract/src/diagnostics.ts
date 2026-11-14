import type { AssistantMessage, Message, ToolSpec } from "@plume/llm/types";
import type { HookName } from "./plugin.ts";
import type { AgentEvent, TurnStop } from "./service.ts";

/**
 * 钩子的一层在一次钩子调用里做了什么。只记有没有改，不记改成了什么：观察里不因此多出参数、结果的内容。
 * 「改了」按值比较（同一个对象、或逐个字段一样都算没改），所以照原样展开再交下去不算改。
 */
export interface HookPass {
	plugin: string;
	order: number;
	/**
	 * `next`：往里交了；`answered`：没往里交，自己给了结果；`failed`：这一层抛了错。里层的错原样往外传时只记在出错的那一层，
	 * 外面的层照样是 `next`（和 `HookError` 的归因一样）。
	 */
	outcome: "next" | "answered" | "failed";
	/** 交给里层的和自己收到的不一样：改了参数，或在输入上设了别的（`approved`、`readOnly`……）。 */
	changedInput?: true;
	/** 交回外层的和里层交给它的不一样：改了结果。 */
	changedOutput?: true;
}

/** 一次钩子调用穿过的层，外层在前；一层交了几次（重试）就记几次。 */
export interface HookTrace {
	hook: HookName;
	layers: HookPass[];
	/**
	 * 最里层（本体）：`ran` 走到了；`stopped` 本体按外层设下的东西在某一层之前就停下、不再往里交（如外层设了 `readOnly`，写、改文件的工具不跑）。
	 * 没有时是某一层自己交了结果或出错，没走到最里层。
	 */
	inner?: "ran" | "stopped";
}

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
		/**
		 * 一次钩子调用经过了哪几层、每层做了什么，有插件挂了这个钩子时才有。`tool.execute`、`tool.approve` 带它所在的那次工具调用
		 * （`tool.approve` 一次调用里问几次就有几条），`model.context` 带组出来的那次请求（同 `request` 的 `id`；组了没发出去的不记），
		 * `prompt.submit` 两样都不带（每条要写进会话的消息一条，拦下的也记）。`step.end`、`context.compact` 不记。
		 */
		| ({ type: "hooks"; toolCallId?: string; requestId?: string } & HookTrace)
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
