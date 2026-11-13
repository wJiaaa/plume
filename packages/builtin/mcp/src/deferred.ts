/**
 * 已经改成按需搜索的会话。改过去就不改回来，免得工具表在会话中途来回变；存进插件数据目录，重开应用以后也不翻回去
 * （启动时服务还没连全，工具一时变少，只记在内存里的话第一轮会翻回直接列工具，作废一次提示缓存）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class DeferredSessions {
	private readonly file: string;
	private readonly ids: Promise<Set<string>>;
	private writing: Promise<void> = Promise.resolve();

	constructor(file: string) {
		this.file = file;
		this.ids = readFile(file, "utf8").then(
			(raw) => {
				const parsed: unknown = JSON.parse(raw);
				return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
			},
			() => new Set<string>(),
		);
	}

	async has(sessionId: string): Promise<boolean> {
		return (await this.ids).has(sessionId);
	}

	async add(sessionId: string): Promise<void> {
		const ids = await this.ids;
		if (ids.has(sessionId)) return;
		ids.add(sessionId);
		await this.save(ids);
	}

	async delete(sessionId: string): Promise<void> {
		const ids = await this.ids;
		if (ids.delete(sessionId)) await this.save(ids);
	}

	/** 排着写：先后两次改动不互相覆盖。写不进去只是重开后可能翻回去一次，不挡这一轮。 */
	private save(ids: Set<string>): Promise<void> {
		this.writing = this.writing.then(async () => {
			try {
				await mkdir(dirname(this.file), { recursive: true });
				const temp = `${this.file}.tmp`;
				await writeFile(temp, JSON.stringify([...ids]));
				await rename(temp, this.file);
			} catch {
				// 见上：记不下不影响这一轮。
			}
		});
		return this.writing;
	}
}
