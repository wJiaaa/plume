/**
 * 逻辑入口经 ctx.serve 开给面板的接口，两个入口共用这一份类型。shell 跑在 agent 进程里，面板只是连上去看。
 */

import type { CallContext } from "@plume/contract";
import type { IWindowsPty } from "@xterm/xterm";
import type { DirectoryRequest } from "./open-directory.ts";

/** 一个 shell，面板区的一个终端标签。 */
export interface TerminalTab {
	id: string;
	/**
	 * 标签的序号：所有 shell 里唯一，旁边的关掉了也不变。
	 *
	 * 存序号不存名字：名字由面板按当前语言拼（「终端 2」），存下来的名字会停在创建时的语言里。
	 */
	number: number;
	/** 起在哪个目录。 */
	cwd: string;
	/** 前台跑着的程序，是 shell 自己时为空。 */
	process: string | null;
}

/** 历史带原始尺寸重放，ready 后按当前窗口接收新输出；shell 退出时最后一条是 exit。 */
export type TerminalOutput = { type: "data"; data: string; cols: number; rows: number } | { type: "ready" } | { type: "exit"; code: number };

export interface TerminalApi {
	/** 文件树请求在该会话的终端切换目录；面板准备好后领取，跨窗口也只执行一次。 */
	openDirectory(sessionId: string, directory: string): void;
	/** 代码块请求在该会话的终端执行一条命令，和目录请求排在同一处、同样只执行一次。 */
	runCommand(sessionId: string, command: string): void;
	watchDirectory(sessionId: string, call: CallContext): AsyncGenerator<DirectoryRequest | null, void>;
	takeDirectory(sessionId: string, id: number): boolean;
	/** 所有 shell，按打开顺序；之后每变一次推一份完整的，直到取消。 */
	watch(call: CallContext): AsyncGenerator<TerminalTab[], void>;
	/** 按稳定标签接回已有 shell；没有（包括 agent 重启后）才新建。目录失效时用主目录。 */
	open(tab: string, cwd: string, cols: number, rows: number): Promise<TerminalTab>;
	/**
	 * 连上一个已有的 shell，取消就是断开：shell 照常跑、照常记输出，下次连上时回放。
	 * shell 已经不在了就直接结束。尺寸给 0 表示还没量到，不改 shell 的尺寸。
	 */
	attach(id: string, cols: number, rows: number, call: CallContext): AsyncGenerator<TerminalOutput, void>;
	/** 这台机器的 pty 要怎么告诉 xterm（见 shell.ts 的 `windowsPtyFor`）；不是 Windows 时为空。 */
	windowsPty(): IWindowsPty | null;
	/** Plume 的窗口拿到焦点时调：Windows 上重读注册表里的环境，给之后开的标签用（十秒内最多读一次）；别的平台什么都不做。 */
	refreshEnv(): void;
	write(id: string, data: string): void;
	resize(id: string, cols: number, rows: number): void;
	/** 关闭标签并结束它绑定的 shell；组件卸载、换窗口只取消 attach，不调用这里。 */
	close(tab: string): void;
}
