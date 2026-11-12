import type { BackgroundJobsService, BackgroundJobInfo, FileContents, SessionObservation, SessionSummary, SessionWakeup } from "@plume/contract";

/** 后台任务进程树里在监听的一个端口；`url` 是能点开的本机地址（它自己打印过的，或问过确实是 HTTP 的）。 */
export interface ServiceEndpoint {
	address: string;
	port: number;
	pid: number;
	url?: string;
}

type DiagnosticJob = BackgroundJobInfo & { endpoints: ServiceEndpoint[] };

type Request = Extract<SessionObservation["event"], { type: "request" }>;
/** 一次请求实际发出去的系统提示词、消息和工具表。 */
export type RequestInput = Pick<Request, "systemPrompt" | "messages" | "tools">;
/**
 * 轨迹列表里的观察：请求不带整段历史，`messages` 是发出去的条数，`systemPrompt` 是系统提示词的指纹（正文在快照的 `prompts` 里），
 * 消息和工具表打开详情时经 `request` 取。
 */
export type TraceObservation = Omit<SessionObservation, "event"> & {
	event: Exclude<SessionObservation["event"], { type: "request" }> | (Omit<Request, keyof RequestInput> & { systemPrompt: string; messages: number });
};

export interface DiagnosticSnapshot {
	/** 没要轨迹（`read` 的 version 给 null）时没有。 */
	version?: string;
	/** 和上次给的 version 一样时没有，照旧用上次的。 */
	observations?: TraceObservation[];
	/** 系统提示词，按指纹一份，和 `observations` 一起给。 */
	prompts?: Record<string, string>;
	jobs: DiagnosticJob[];
	/** 问系统哪些端口在监听时失败了（端口只剩任务输出里打印过的）。 */
	discoveryError?: string;
	children: SessionSummary[];
	wakeups: SessionWakeup[];
}

export interface DiagnosticsApi {
	/**
	 * `version`：上次拿到的轨迹版本；null 表示不要轨迹（环境卡片里的几节和开关圆点只看任务和唤醒）。
	 * `ports`：要不要查后台任务的端口（要问系统，只在画得出端口的地方要）。
	 */
	read(sessionId: string, version: string | null, ports: boolean): Promise<DiagnosticSnapshot>;
	/** 一次请求实际发出去的内容，打开轨迹详情时取。 */
	request(sessionId: string, requestId: string): Promise<RequestInput>;
	output: BackgroundJobsService["output"];
	stop(sessionId: string, jobId: string, force: boolean): Promise<void>;
	/** 只读取该会话工具结果已登记的完整输出。 */
	fullOutput(sessionId: string, toolCallId: string): Promise<{ path: string; contents: FileContents }>;
	cancelWakeup(sessionId: string, wakeupId: string): Promise<boolean>;
}
