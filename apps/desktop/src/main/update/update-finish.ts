/**
 * 「立即重启」按平台做的事，平台调用由外面传进来。
 *
 * 和 updates.ts 分开，因为会出错的是这几步的先后，只有把它们换掉才测得了：
 * - macOS 先安排好替换（脚本等这个进程退出再换），再经 `before-quit` 退出，会话和终端照常收尾。
 * - Windows 也是退出：NSIS 安装程序发现 Plume 在跑会用 `Stop-Process` 杀掉它，那样 `before-quit` 不会跑，会话没写完、
 *   终端没关、agent 进程没停。确认安装程序起来了就自己退出，这些都能做完。
 */

export type PendingUpdate =
	/** macOS：解开的 `.app`，等着换掉装着的那个。 */
	| { kind: "bundle"; staged: string; target: string }
	/** Windows：NSIS 安装程序。 */
	| { kind: "installer"; file: string };

export interface FinishEffects {
	swapBundle(job: { staged: string; target: string }): Promise<void>;
	/** `shell.openPath`：起来了答 ""，否则答错误。 */
	openInstaller(file: string): Promise<string>;
	quit(): void;
}

export type FinishResult = { ok: true } | { ok: false; detail: string };

export async function finishUpdate(job: PendingUpdate, effects: FinishEffects): Promise<FinishResult> {
	try {
		switch (job.kind) {
			case "bundle":
				await effects.swapBundle(job);
				effects.quit();
				return { ok: true };
			case "installer": {
				const failure = await effects.openInstaller(job.file);
				if (failure) return { ok: false, detail: failure };
				effects.quit();
				return { ok: true };
			}
		}
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}
