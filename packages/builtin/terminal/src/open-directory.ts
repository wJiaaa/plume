export interface DirectoryRequest {
	id: number;
	command: string;
}

/**
 * 交给终端的命令（文件树的切换目录、代码块的「在终端运行」）等所属会话的终端准备好再领取，切换会话不会送到
 * 别人的 shell。每个会话只留最近一条：人连点了两个按钮，执行的是后点的那个。`cd` 按新终端起的 shell 写切目录那一行
 * （见 shell.ts 的 `cdCommand`）。
 */
export function createDirectoryRequests(cd: (directory: string) => string) {
	const pending = new Map<string, DirectoryRequest>();
	const listeners = new Set<() => void>();
	let nextId = 0;
	const changed = () => {
		for (const listener of listeners) listener();
	};
	/** 带着回车写进去：按钮写的是「运行」，人看过命令、知道它从哪来，才按的。 */
	const run = (sessionId: string, command: string) => {
		pending.set(sessionId, { id: ++nextId, command: `${command}\r` });
		changed();
	};
	return {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		get(sessionId: string) {
			return pending.get(sessionId) ?? null;
		},
		open(sessionId: string, directory: string) {
			run(sessionId, cd(directory));
		},
		run,
		/** 写进 shell 前先领取，重挂或多个窗口不会重复执行。 */
		take(sessionId: string, id: number) {
			if (pending.get(sessionId)?.id !== id) return false;
			pending.delete(sessionId);
			changed();
			return true;
		},
	};
}
