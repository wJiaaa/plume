/**
 * 侧边聊天里还没被模型读到的话，按侧边聊天分开记，只在内存里（重开应用就没了）：
 *
 * - 排着的（`queued`）：会话在跑时按 ⌘回车、命令没声明插话、排队条拿过来的，等这一轮以完成收场、会话闲下来再一句一句发。
 *   本体的队不收插件建的会话，所以插件自己排。
 * - 插进去的（`steered`）：已经经 `ctx.sessions.steer` 交给本体，等模型做完手上这一步读到。本体在一轮收尾时把没读到的插话作废，
 *   所以这里记着，这一轮结束时还没在会话里出现的转进排着的队头，接着发，不丢。
 */

import type { Message, SessionMessage } from "@plume/contract";
import type { WaitingEntry } from "./api.ts";

interface Waiting {
	id: string;
	message: string | SessionMessage;
	steered: boolean;
	/** 插话时会话里已有几条消息：读到的那一条只会出现在它后面。 */
	at: number;
}

/** 一句话里的字，认读没读到它、排队条上那一行都用它。 */
function wordsOf(message: string | SessionMessage | Message): string {
	if (typeof message === "string") return message;
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: { type: string; text?: string }) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("\n\n");
}

export function createWaiting() {
	const lists = new Map<string, Waiting[]>();
	let nextId = 0;
	const listOf = (sideId: string) => lists.get(sideId) ?? [];
	const put = (sideId: string, list: Waiting[]) => {
		if (list.length > 0) lists.set(sideId, list);
		else lists.delete(sideId);
	};
	const entry = (message: string | SessionMessage, steered: boolean, at = 0): Waiting => ({ id: String(++nextId), message, steered, at });

	return {
		/** 排队条上画的：插进去的在前（它们先被读到），排着的按先后。 */
		list(sideId: string): WaitingEntry[] {
			const list = listOf(sideId);
			return [...list.filter((item) => item.steered), ...list.filter((item) => !item.steered)].map((item) => ({
				id: item.id,
				preview: ((typeof item.message !== "string" && item.message.displayText) || wordsOf(item.message)).replace(/\s+/g, " ").trim(),
				steered: item.steered,
				attachments: typeof item.message !== "string" && Boolean(item.message.attachments?.length || item.message.sessionRefs?.length),
			}));
		},
		hasSteered(sideId: string): boolean {
			return listOf(sideId).some((item) => item.steered);
		},
		hasQueued(sideId: string): boolean {
			return listOf(sideId).some((item) => !item.steered);
		},
		queue(sideId: string, message: string | SessionMessage): void {
			put(sideId, [...listOf(sideId), entry(message, false)]);
		},
		/** 记下一句插话；交给本体失败时用返回的 id 收回（`take`）。 */
		steered(sideId: string, message: string | SessionMessage, at: number): string {
			const added = entry(message, true, at);
			put(sideId, [...listOf(sideId), added]);
			return added.id;
		},
		/** 拿出一条（收回、移除、现在就发）；插进去的已经在本体手里，收不回来。 */
		take(sideId: string, id: string): { message: string | SessionMessage; words: string } | undefined {
			const list = listOf(sideId);
			const found = list.find((item) => item.id === id && !item.steered);
			if (!found) return undefined;
			put(
				sideId,
				list.filter((item) => item !== found),
			);
			return { message: found.message, words: wordsOf(found.message) };
		},
		/** 插话交给本体失败（这一轮已经在收尾）：改成排着的，放在队头。 */
		unsteer(sideId: string, id: string): void {
			const list = listOf(sideId);
			const found = list.find((item) => item.id === id);
			if (!found) return;
			put(sideId, [{ ...found, steered: false }, ...list.filter((item) => item !== found)]);
		},
		/** 排着的队头拿出来发；发不出去时用 `requeue` 放回队头。 */
		next(sideId: string): { id: string; message: string | SessionMessage } | undefined {
			const list = listOf(sideId);
			const found = list.find((item) => !item.steered);
			if (!found) return undefined;
			put(
				sideId,
				list.filter((item) => item !== found),
			);
			return { id: found.id, message: found.message };
		},
		requeue(sideId: string, taken: { id: string; message: string | SessionMessage }): void {
			put(sideId, [{ ...taken, steered: false, at: 0 }, ...listOf(sideId)]);
		},
		/**
		 * 会话里已经有了的插话拿掉：插话那一刻之后出现的人说的话，字一样就是它。返回有没有拿掉的。
		 * `ended`：这一轮收场了，还没读到的就不会再读到了，转进排着的队头（照插的先后）。
		 */
		read(sideId: string, messages: readonly Message[], ended: boolean): boolean {
			const list = listOf(sideId);
			const used = new Set<number>();
			const left: Waiting[] = [];
			let changed = false;
			for (const item of list) {
				if (!item.steered) {
					left.push(item);
					continue;
				}
				const words = wordsOf(item.message);
				const index = messages.findIndex((message, at) => at >= item.at && !used.has(at) && message.role === "user" && wordsOf(message) === words);
				if (index >= 0) {
					used.add(index);
					changed = true;
				} else left.push(item);
			}
			if (ended && left.some((item) => item.steered)) {
				changed = true;
				put(sideId, [...left.filter((item) => item.steered).map((item) => ({ ...item, steered: false })), ...left.filter((item) => !item.steered)]);
			} else put(sideId, left);
			return changed;
		},
		forget(sideId: string): void {
			lists.delete(sideId);
		},
	};
}
