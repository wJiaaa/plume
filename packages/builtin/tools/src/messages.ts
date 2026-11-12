/** 给人看的文字（审批卡的标题和说明、提示条），两种界面语言写在一起。发给模型的话不在这里，不随界面语言变。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	escalate: (command: string) => `提权运行：${command}`,
	readSecret: (name: string) => `读取本机密钥文件：${name}`,
	readOutside: (name: string) => `读取当前项目之外的位置：${name}`,
	readSecretScope: "密钥按文件单独批准；同一目录下的其他密钥仍会再问一次。",
	readTreeScope: (grant: string) => `批准后，这个会话读取 ${grant} 里的文件不再询问。`,
	undoBusy: "正在撤销改动，请稍后重试。",
	undoRunning: "仍有任务或命令可能修改文件，请等它们结束后再撤销。",
	undoEmpty: "没有可撤销的变更。",
	undoInvalid: "变更记录无效或已损坏，不能撤销。",
	undoCommand: "命令执行期间观测到的变更需要手动审阅，不能自动撤销。",
	undoInterleaved: "文件在本轮操作之间存在其他修改，不能自动撤销。",
	undoOutside: "只能撤销当前项目内的普通文件。",
	undoModified: "文件或目录已有后续修改，已保留；请在差异视图中手动处理。",
	undoFailed: "撤销未完成，部分文件无法安全回滚，请检查文件改动。",
	changeMissing: "部分变更记录无法读取；未推测或补填历史差异。",
	changeSaveFailed: "文件已写入，但变更记录未能保存。重试前请重新读取文件。",
	changeWarning: (reason: string) => `未完整记录命令的文件差异：${reason}`,
	changeLargeFile: "存在超过 2 MiB 的文件或非普通文件。",
	changeBinary: "存在非 UTF-8 文本或二进制文件。",
	changeSecret: "存在凭据或环境文件；自动观测不会读取或保存其内容。",
	changeManyBefore: "工作区已有超过 200 个改动文件。",
	changeManyAfter: "命令影响超过 200 个文件，请在 Git 面板查看完整差异。",
	changeLargeBefore: "已有改动超过 16 MiB。",
	changeLargeAfter: "命令观测的内容超过 16 MiB，请在 Git 面板查看完整差异。",
	changeBackground: "命令仍在后台运行，文件差异会在进程结束后记录。",
	changeObserveFailed: "无法安全读取 Git 工作区。",
	wakeupsCancelled: (n: number) => `已停止，${n} 个定时唤醒一并取消。`,
	jobDone: "后台命令完成",
	jobFailed: "后台命令失败",
	jobExitCode: (code: number) => `退出码 ${code}`,
	jobKilled: "被终止",
	jobsEnded: (n: number) => `${n} 个后台命令结束`,
	jobsFailed: (n: number) => `${n} 个失败`,
	monitorLines: (n: number) => `监视到 ${n} 行新输出`,
	monitorStopped: "监视已停止",
	monitorIdle: "长时间没有输出",
	monitorMaxEvents: "达到行数上限",
	jobsUpdated: (n: number) => `${n} 个后台命令有新输出`,
	wakeupFired: "定时唤醒",
};

const en: typeof zhCN = {
	escalate: (command) => `Run with wider access: ${command}`,
	readSecret: (name) => `Read a credential file on this computer: ${name}`,
	readOutside: (name) => `Read outside the current project: ${name}`,
	readSecretScope: "Credentials are approved one file at a time; other keys in the same folder will still ask.",
	readTreeScope: (grant) => `Once approved, this session reads files in ${grant} without asking.`,
	undoBusy: "Changes are being undone. Please try again shortly.",
	undoRunning: "A task or command may still modify files. Wait for it to finish before undoing.",
	undoEmpty: "There are no changes to undo.",
	undoInvalid: "The change record is invalid or damaged and cannot be undone.",
	undoCommand: "Changes observed during a command need manual review and cannot be undone automatically.",
	undoInterleaved: "The file was changed between these operations and cannot be undone automatically.",
	undoOutside: "Only regular files inside the current project can be undone.",
	undoModified: "The file or directory has changed since. It was preserved; resolve it manually in the diff view.",
	undoFailed: "Undo was incomplete and some files could not be safely rolled back. Check the file changes.",
	changeMissing: "Some change records could not be read. No historical differences were inferred or backfilled.",
	changeSaveFailed: "The file was written, but its change record could not be saved. Read the file again before retrying.",
	changeWarning: (reason) => `Command file changes were not fully recorded: ${reason}`,
	changeLargeFile: "A file exceeds 2 MiB or is not a regular file.",
	changeBinary: "A file contains binary data or is not UTF-8 text.",
	changeSecret: "Credential or environment files were found; automatic observation does not read or store their contents.",
	changeManyBefore: "The workspace already has more than 200 changed files.",
	changeManyAfter: "The command affected more than 200 files. See the Git panel for the full diff.",
	changeLargeBefore: "Existing changes exceed 16 MiB.",
	changeLargeAfter: "Observed command contents exceed 16 MiB. See the Git panel for the full diff.",
	changeBackground: "The command is still running in the background. File changes will be recorded when the process exits.",
	changeObserveFailed: "The Git workspace could not be read safely.",
	wakeupsCancelled: (n) => (n === 1 ? `Stopped. ${n} scheduled wakeup was cancelled too.` : `Stopped. ${n} scheduled wakeups were cancelled too.`),
	jobDone: "Background command done",
	jobFailed: "Background command failed",
	jobExitCode: (code) => `exit code ${code}`,
	jobKilled: "killed",
	jobsEnded: (n) => (n === 1 ? `${n} background command ended` : `${n} background commands ended`),
	jobsFailed: (n) => `${n} failed`,
	monitorLines: (n) => (n === 1 ? `${n} new line from a monitor` : `${n} new lines from a monitor`),
	monitorStopped: "Monitor stopped",
	monitorIdle: "no output for a while",
	monitorMaxEvents: "line limit reached",
	jobsUpdated: (n) => (n === 1 ? `New output from ${n} background command` : `New output from ${n} background commands`),
	wakeupFired: "Scheduled wakeup",
};

/** 界面入口按 `useI18n().resolvedLocale` 取；逻辑入口用 `words()`。 */
export const MESSAGES: Record<Locale, typeof zhCN> = { "zh-CN": zhCN, en };

/** 现在的界面语言，插件加载时换成 `ctx.locale`；测试里直接调工具时是中文。 */
let locale: () => Locale = () => "zh-CN";

export function setLocaleSource(current: () => Locale): void {
	locale = current;
}

export function words(): typeof zhCN {
	return MESSAGES[locale()];
}
