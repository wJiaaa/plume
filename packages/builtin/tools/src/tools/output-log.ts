/**
 * 命令的完整输出写进会话临时目录的 `tool-output/` 下：模型拿到的是截过的一份，截掉的部分在这里，标记里的行号就是这个文件的行号。
 * 不进上下文、不进会话存储；会话删掉时宿主连临时目录一起删。
 */

import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";

export interface OutputLog {
	path: string;
	append(text: string): void;
	/** 可以调多次，第一次之后都返回同一份结果。 */
	close(): Promise<OutputRecord>;
}

interface OutputRecord {
	outputPath: string;
	outputCharacters: number;
	/** 写完整了；磁盘满之类写不进去时为 false，`outputError` 说原因。 */
	outputComplete: boolean;
	outputError?: string;
}

/** 没有临时目录（直接调工具的测试）时不记。`wx` 加 0600：只新建、不覆盖别人的文件，别的用户读不到命令输出。 */
export async function createOutputLog(scratchDir: string | undefined): Promise<OutputLog | undefined> {
	if (!scratchDir) return undefined;
	const directory = join(scratchDir, "tool-output");
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${randomUUID()}.log`);
	const handle = await open(path, "wx", 0o600);
	const stream = handle.createWriteStream();
	let characters = 0;
	let error: string | undefined;
	let closed = false;
	const done = finished(stream).catch((cause: unknown) => {
		error = String(cause);
	});
	return {
		path,
		append(text) {
			characters += text.length;
			if (!closed && !error) stream.write(text);
		},
		async close() {
			if (!closed) {
				closed = true;
				stream.end();
			}
			await done;
			return { outputPath: path, outputCharacters: characters, outputComplete: !error, ...(error ? { outputError: error } : {}) };
		},
	};
}
