import type { BackgroundJobsService, BackgroundJobInfo, FileContents, SessionObservation, SessionSummary, SessionWakeup } from "@plume/contract";

/** 后台任务进程树里在监听的一个端口；`url` 是能点开的本机地址（它自己打印过的，或问过确实是 HTTP 的）。 */
export interface ServiceEndpoint {
	address: string;
	port: number;
	pid: number;
	url?: string;
}

type DiagnosticJob = BackgroundJobInfo & { endpoints: ServiceEndpoint[] };

export interface DiagnosticSnapshot {
	version: string;
	observations?: SessionObservation[];
	jobs: DiagnosticJob[];
	/** 问系统哪些端口在监听时失败了（端口只剩任务输出里打印过的）。 */
	discoveryError?: string;
	children: SessionSummary[];
	wakeups: SessionWakeup[];
}

export interface DiagnosticsApi {
	/** `ports`：要不要查后台任务的端口（要问系统，只在画得出端口的地方要）。 */
	read(sessionId: string, version: string, ports: boolean): Promise<DiagnosticSnapshot>;
	output: BackgroundJobsService["output"];
	stop(sessionId: string, jobId: string, force: boolean): Promise<void>;
	/** 只读取该会话工具结果已登记的完整输出。 */
	fullOutput(sessionId: string, toolCallId: string): Promise<{ path: string; contents: FileContents }>;
	cancelWakeup(sessionId: string, wakeupId: string): Promise<boolean>;
}
