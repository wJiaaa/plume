/**
 * 每个会话最近关掉的那张选择卡，存在插件数据目录的 `dismissed.json`，重启后还关着。
 * 一个会话只记一张：人再开口以后，之前的卡都不再等人选（`outcomeOf`），要记的只有最新那张。
 */

import { readFile, rename, writeFile } from "node:fs/promises";

export class DismissedCards {
	private saving: Promise<void> = Promise.resolve();
	private readonly file: string;
	private readonly cards: Map<string, string>;
	private readonly warn: (message: string) => void;

	private constructor(file: string, cards: Map<string, string>, warn: (message: string) => void) {
		this.file = file;
		this.cards = cards;
		this.warn = warn;
	}

	/** `live` 是现有的会话：删会话时插件没在跑（删到一半退出）留下的，加载时清掉。 */
	static async open(file: string, live: () => Promise<Iterable<string>>, warn: (message: string) => void): Promise<DismissedCards> {
		const saved = await readFile(file, "utf8")
			.then((text) => JSON.parse(text) as unknown)
			.catch((error: NodeJS.ErrnoException) => {
				// i18n-exempt：插件数据读取失败的日志。
				if (error.code !== "ENOENT") warn(`关掉的选择卡没读出来：${String(error)}`);
				return {};
			});
		const entries = Object.entries(saved ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string");
		const store = new DismissedCards(file, new Map(entries), warn);
		if (entries.length > 0) {
			const kept = new Set(await live());
			for (const [sessionId] of entries) if (!kept.has(sessionId)) store.forget(sessionId);
		}
		return store;
	}

	entries(): Iterable<[string, string]> {
		return this.cards.entries();
	}

	set(sessionId: string, card: string): void {
		this.cards.set(sessionId, card);
		this.save();
	}

	forget(sessionId: string): void {
		if (this.cards.delete(sessionId)) this.save();
	}

	private save(): void {
		const body = JSON.stringify(Object.fromEntries(this.cards));
		this.saving = this.saving
			.then(async () => {
				await writeFile(`${this.file}.tmp`, body);
				await rename(`${this.file}.tmp`, this.file);
			})
			// i18n-exempt：插件数据写入失败的日志。
			.catch((error: unknown) => this.warn(`关掉的选择卡没存上：${String(error)}`));
	}
}
