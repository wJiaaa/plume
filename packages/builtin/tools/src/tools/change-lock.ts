import { words } from "../messages.ts";

// 项目可以嵌套，文件也可能经硬链接共享；同一进程的撤销和工具修改共用门闩。
let undoing = false;
let mutations = 0;
let prompts = 0;
const idle = new Set<() => void>();

function notifyIdle(): void {
	if (undoing || mutations || prompts) return;
	for (const done of idle) done();
	idle.clear();
}

/** 停用插件时先等进程真正退出，不能让下一次加载丢掉旧进程的保护。 */
export async function waitForChangesIdle(): Promise<void> {
	if (undoing || mutations || prompts) await new Promise<void>((resolve) => idle.add(resolve));
}

export function beginMutation(): () => void {
	if (undoing) throw new Error(words().undoBusy);
	mutations++;
	let released = false;
	return () => {
		if (!released) {
			released = true;
			mutations--;
			notifyIdle();
		}
	};
}

export function beginUndo(): () => void {
	if (undoing) throw new Error(words().undoBusy);
	if (mutations || prompts) throw new Error(words().undoRunning);
	undoing = true;
	return () => {
		undoing = false;
		notifyIdle();
	};
}

export function beginPrompt(): (() => void) | undefined {
	if (undoing) return undefined;
	prompts++;
	return () => {
		prompts--;
		notifyIdle();
	};
}
