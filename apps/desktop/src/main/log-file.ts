/**
 * 运行日志：agent 进程的输出（插件的 `ctx.log`、`console`、崩溃时的堆栈）和窗口里的告警、报错（界面入口渲染出错、
 * 订阅失败），一行一条追加进数据目录的 `logs/plume.log`。从图标打开的应用没有终端，排查插件看这一份。
 *
 * 启动时超过上限就挪成 `plume.log.1`（只留一份旧的），之后不再轮换：一次运行写不满几 MiB，不值得边写边切。
 * 写日志失败（磁盘满、目录没权限）只丢这一条，不影响应用。
 */

import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 5 * 1024 * 1024;

export type LogWriter = (source: string, text: string) => void;

/** @param dir 数据目录 */
export function openLogFile(dir: string): LogWriter {
	const logs = join(dir, "logs");
	const file = join(logs, "plume.log");
	try {
		mkdirSync(logs, { recursive: true });
		if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LIMIT) renameSync(file, `${file}.1`);
	} catch {
		// 轮换不了就接着往旧文件里写。
	}
	const stream = createWriteStream(file, { flags: "a", mode: 0o600 });
	stream.on("error", () => {});
	return (source, text) => {
		const at = new Date().toISOString();
		const lines = text.trimEnd().split("\n");
		stream.write(`${lines.map((line) => `${at} [${source}] ${line}`).join("\n")}\n`);
	};
}
