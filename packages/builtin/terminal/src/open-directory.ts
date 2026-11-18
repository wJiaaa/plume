export interface DirectoryRequest {
	id: number;
	command: string;
}

/**
 * 交给终端的命令写进 shell 的那串字节，带着回车：按钮写的是「运行」，人看过命令、知道它从哪来，才按的。
 *
 * shell 开着括号粘贴（`bracketed`，xterm 的 `modes.bracketedPasteMode`）时包成一段粘贴再回车：zsh、bash 把整段一次放进
 * 编辑区，回车时作为一条命令执行。不包的话多行命令被当成一个个按键，一行一个续行提示，逐字回显成两千来块输出，
 * zsh 的语法高亮、自动建议还每个字跑一遍。没开（新 shell 还没起到提示符、cmd）时照旧原样打进去。换行按 xterm
 * 粘贴的规矩改成回车。
 */
export function typedCommand(command: string, bracketed: boolean): string {
	const text = command.replace(/\r?\n/g, "\r");
	return `${bracketed ? `\x1b[200~${text}\x1b[201~` : text}\r`;
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
	/** 存的是命令本身，回车由写进 shell 的那一头加，见 `typedCommand`。 */
	const run = (sessionId: string, command: string) => {
		pending.set(sessionId, { id: ++nextId, command });
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
