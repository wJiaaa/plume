/**
 * 每个会话冻结的那份系统提示词和工具表，和之后接进历史的增量（见 `update.ts`）。
 *
 * 增量消息不写进会话：会话存的是人和模型说过的话，这份是拼请求的方式。它们记在这里，按「跟在第几条消息后面」每次请求原样
 * 插回去，模型看到的历史和上一次发的逐字节一致。落盘是为了重开应用以后还是同一份：换成按磁盘现状新生成的，前缀从系统提示词
 * 起就对不上了。
 *
 * 什么时候作废，看历史本身：
 * - 开头那条消息换了：压缩把前面换成了摘要（反正要重写前缀），或撤回到了第一条。重新生成一份，之前的增量随之作废。
 * - 一条增量跟着的那条消息不在原处了：撤回、编辑重发截掉了它。从这一条起的增量都作废，模型看不到它们了，下一轮按模型此刻
 *   以为的各段重新比一次，该补的会自己补回来。
 *
 * 工具表同样冻结：装、卸、更新、重载带工具的插件时，宿主给的工具表当场就变（插件重载后它的工具还会排到末尾），每次请求都照实发的话，
 * 正在跑的会话的工具段立刻对不上，缓存从头作废。所以一轮里照冻结的那份原样发，只在一轮的开头（和比段同一时机）换成合并后的一份：
 * 原有的保持原来的顺序，新的接在后面。工具表变了缓存总要作废一次，目标是一轮里不变、顺序不无故变。一轮中间被卸下的工具还留在表里，
 * 模型调它会拿到宿主「没有这个工具」的结果，和「隐藏不等于禁用」一致。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, PromptSection, ToolSpec } from "@plume/contract";
import { currentSections, diffSections, promptSections, promptUpdateMessage, type SectionChange } from "./update.ts";

interface PromptUpdate {
	/** 跟在历史（宿主给的那份，压缩过的是摘要加之后的原文）里第几条消息后面。 */
	at: number;
	/** 那条消息的时间戳：撤回、编辑重发换掉了那个位置上的消息，就对不上了。 */
	timestamp: number;
	changes: SectionChange[];
}

interface FrozenPrompt {
	/** 冻结时历史第一条消息的时间戳。 */
	head: number;
	sections: PromptSection[];
	updates: PromptUpdate[];
	/** 模型此刻以为的工具表：一轮里原样发，一轮的开头按 `mergeTools` 换。 */
	tools: ToolSpec[];
}

/** 会话 id 当文件名用：只认这几种字符，别的不落盘。 */
const SESSION_ID = /^[\w-]+$/;

export class FrozenPrompts {
	private readonly held = new Map<string, FrozenPrompt>();
	/** 同一个会话的写盘按顺序来，后写的那份不会被先写的盖掉。 */
	private readonly writing = new Map<string, Promise<void>>();

	constructor(
		private readonly dir: string,
		private readonly warn: (message: string) => void,
	) {}

	/**
	 * 这一次请求怎么拼：`messages` 里插回还作数的增量，交给里层；里层交回的段和工具表经 `settle` 换回冻结的那份。
	 * 历史为空（还没有一条消息）时不冻结：那不是一次真的请求。
	 */
	async prepare(
		sessionId: string,
		messages: Message[],
	): Promise<{
		messages: Message[];
		settle(sections: PromptSection[], out: Message[], tools: ToolSpec[]): { sections: PromptSection[]; messages: Message[]; tools: ToolSpec[] };
	}> {
		const first = messages[0];
		if (!first) return { messages, settle: (sections, out, tools) => ({ sections, messages: out, tools }) };
		let frozen = await this.read(sessionId);
		if (frozen && frozen.head !== first.timestamp) frozen = undefined;
		if (frozen) {
			const kept = stillThere(frozen.updates, messages);
			if (kept.length !== frozen.updates.length) {
				frozen = { ...frozen, updates: kept };
				this.save(sessionId, frozen);
			}
		}
		const base = frozen;
		return {
			messages: base ? withUpdates(messages, base.updates) : messages,
			settle: (sections, out, tools) => {
				if (!base) {
					this.save(sessionId, {
						head: first.timestamp,
						sections: sections.map((section) => ({ ...section })),
						updates: [],
						tools: tools.map((tool) => ({ ...tool })),
					});
					return { sections, messages: out, tools };
				}
				let updates = base.updates;
				let frozenTools = base.tools;
				const last = messages.at(-1)!;
				/*
				 * 只在一轮的开头（历史末尾是一条用户消息：人的话、插话、送达）比：一轮里的每一步都比的话，模型改了 AGENTS.md
				 * 之后的下一步就会收到一条增量，夹在工具结果和它的下一条回复之间；这一轮做完再告诉它就够了。
				 */
				if (last.role === "user") {
					const changes = diffSections(
						currentSections(
							base.sections,
							updates.map((update) => update.changes),
						),
						promptSections(sections),
					);
					if (changes.length > 0) {
						updates = [...updates, { at: messages.length - 1, timestamp: last.timestamp, changes }];
						out = [...out, promptUpdateMessage(changes, last.timestamp)];
					}
					const merged = mergeTools(base.tools, tools);
					if (JSON.stringify(merged) !== JSON.stringify(base.tools)) frozenTools = merged;
					if (updates !== base.updates || frozenTools !== base.tools) this.save(sessionId, { ...base, updates, tools: frozenTools });
				}
				return { sections: base.sections.map((section) => ({ ...section })), messages: out, tools: frozenTools.map((tool) => ({ ...tool })) };
			},
		};
	}

	/** 会话删掉了：内存里的和盘上的都不要了。 */
	forget(sessionId: string): void {
		this.held.delete(sessionId);
		if (!SESSION_ID.test(sessionId)) return;
		this.queue(sessionId, () => rm(this.file(sessionId), { force: true }));
	}

	private file(sessionId: string): string {
		return join(this.dir, `${sessionId}.json`);
	}

	private async read(sessionId: string): Promise<FrozenPrompt | undefined> {
		const held = this.held.get(sessionId);
		if (held || !SESSION_ID.test(sessionId)) return held;
		// 还在写的那份等它写完再读，不读到半截。
		await this.writing.get(sessionId);
		const raw = await readFile(this.file(sessionId), "utf8").catch(() => undefined);
		const parsed = raw === undefined ? undefined : parse(raw);
		// 读盘期间别的请求已经放进来一份（同一个会话不会并发请求，这里只是不让旧的盖掉新的）。
		const now = this.held.get(sessionId);
		if (now) return now;
		if (parsed) this.held.set(sessionId, parsed);
		return parsed;
	}

	private save(sessionId: string, frozen: FrozenPrompt): void {
		this.held.set(sessionId, frozen);
		if (!SESSION_ID.test(sessionId)) return;
		const file = this.file(sessionId);
		const body = JSON.stringify(frozen);
		// 先写到旁边再换过去：写到一半退出的不留半截 JSON。
		this.queue(sessionId, async () => {
			await mkdir(this.dir, { recursive: true });
			await writeFile(`${file}.partial`, body);
			await rename(`${file}.partial`, file);
		});
	}

	/** 写不下只记一句：下次重开应用时重新生成一份，多花一次缓存，不影响这一次请求。 */
	private queue(sessionId: string, work: () => Promise<unknown>): void {
		// i18n-exempt：写给调试的人看的日志。
		const done = (this.writing.get(sessionId) ?? Promise.resolve()).then(work).then(
			() => undefined,
			(error: unknown) => this.warn(`冻结的系统提示词没存上（会话 ${sessionId}）：${error instanceof Error ? error.message : String(error)}`),
		);
		this.writing.set(sessionId, done);
		void done.then(() => {
			if (this.writing.get(sessionId) === done) this.writing.delete(sessionId);
		});
	}
}

/**
 * 一轮开头换上的工具表：按冻结的那份的顺序保留现在还在的（内容取现在的），现在有、冻结的那份没有的按现在的顺序接在后面，
 * 现在没有的去掉。只按名字认，不看对象是不是同一个。
 */
export function mergeTools(frozen: readonly ToolSpec[], current: readonly ToolSpec[]): ToolSpec[] {
	const now = new Map(current.map((tool) => [tool.name, tool]));
	const kept = frozen.flatMap((tool) => {
		const latest = now.get(tool.name);
		return latest ? [latest] : [];
	});
	const known = new Set(frozen.map((tool) => tool.name));
	return [...kept, ...current.filter((tool) => !known.has(tool.name))];
}

/** 还跟在原处的那几条增量：从第一条对不上的起，后面的都不作数了。 */
function stillThere(updates: readonly PromptUpdate[], messages: readonly Message[]): PromptUpdate[] {
	let kept = 0;
	while (kept < updates.length) {
		const { at, timestamp } = updates[kept]!;
		const anchor = messages[at];
		if (anchor?.role !== "user" || anchor.timestamp !== timestamp || (kept > 0 && at < updates[kept - 1]!.at)) break;
		kept++;
	}
	return updates.slice(0, kept);
}

/** 每条增量插在它跟着的那条消息后面，同一处有几条的按先后排。 */
function withUpdates(messages: readonly Message[], updates: readonly PromptUpdate[]): Message[] {
	if (updates.length === 0) return [...messages];
	const out: Message[] = [];
	let next = 0;
	messages.forEach((message, index) => {
		out.push(message);
		while (updates[next]?.at === index) {
			const update = updates[next++]!;
			out.push(promptUpdateMessage(update.changes, update.timestamp));
		}
	});
	return out;
}

function parse(raw: string): FrozenPrompt | undefined {
	try {
		const value = JSON.parse(raw) as Partial<FrozenPrompt>;
		if (typeof value?.head !== "number" || !Array.isArray(value.sections) || !Array.isArray(value.updates) || !Array.isArray(value.tools)) return undefined;
		if (!value.tools.every((tool) => typeof tool?.name === "string")) return undefined;
		if (!value.sections.every((section) => typeof section?.id === "string" && typeof section.text === "string")) return undefined;
		const updates = value.updates.every(
			(update) =>
				typeof update?.at === "number" &&
				typeof update.timestamp === "number" &&
				Array.isArray(update.changes) &&
				update.changes.every((change) => typeof change?.section === "string" && (typeof change.text === "string" || change.text === null)),
		);
		return updates ? (value as FrozenPrompt) : undefined;
	} catch {
		return undefined;
	}
}
