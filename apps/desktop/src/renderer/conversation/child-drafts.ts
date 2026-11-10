/** 可搬窗输入框按稳定标签保存文字、附件和引用，不把未发送内容交给模型。 */
import type { SessionReference } from "../composer/session-references.ts";
import type { DraftQuote } from "@plume/contract/ui";
import { KIND_LABEL } from "../composer/attachments/file-kind.ts";
import type { DraftAttachment } from "../composer/attachments/read.ts";

export interface ChildDraft {
	sessionRefs?: SessionReference[];
	text: string;
	attachments: DraftAttachment[];
	quotes: DraftQuote[];
}

export const EMPTY_CHILD_DRAFT: ChildDraft = { text: "", attachments: [], quotes: [] };
const PREFIX = "plume.child-draft:";
const drafts = new Map<string, ChildDraft>();
const focus = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => {
	for (const listener of listeners) listener();
};

export function subscribeChildDrafts(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function childDraft(key: string | undefined): ChildDraft {
	if (!key) return EMPTY_CHILD_DRAFT;
	if (!drafts.has(key)) drafts.set(key, read(localStorage.getItem(PREFIX + key)));
	return drafts.get(key)!;
}

function read(text: string | null): ChildDraft {
	if (!text) return EMPTY_CHILD_DRAFT;
	try {
		const value = JSON.parse(text) as ChildDraft;
		if (
			value &&
			typeof value.text === "string" &&
			(value.sessionRefs === undefined ||
				(Array.isArray(value.sessionRefs) && value.sessionRefs.every((ref) => ref && typeof ref.id === "string" && typeof ref.title === "string"))) &&
			Array.isArray(value.quotes) &&
			value.quotes.every(
				(quote) => quote && typeof quote.id === "string" && typeof quote.text === "string" && (quote.from === "user" || quote.from === "assistant"),
			) &&
			Array.isArray(value.attachments) &&
			value.attachments.every(
				(file) =>
					file &&
					typeof file.id === "string" &&
					typeof file.name === "string" &&
					typeof file.mimeType === "string" &&
					typeof file.isText === "boolean" &&
					(file.kind === undefined || (typeof file.kind === "string" && Object.hasOwn(KIND_LABEL, file.kind))) &&
					[file.data, file.text, file.path, file.label, file.from].every((item) => item === undefined || typeof item === "string"),
			)
		)
			return value;
	} catch {
		/* 损坏的存储不能让会话输入框无法打开。 */
	}
	return EMPTY_CHILD_DRAFT;
}

function save(key: string, draft: ChildDraft): void {
	if (draft.text || draft.attachments.length || draft.quotes.length || draft.sessionRefs?.length) localStorage.setItem(PREFIX + key, JSON.stringify(draft));
	else localStorage.removeItem(PREFIX + key);
}

export function setChildDraft(key: string, draft: ChildDraft): void {
	drafts.set(key, draft);
	try {
		save(key, draft);
	} catch {
		/* 内存里继续保留；搬窗前 flush 会报告失败并阻止交接。 */
	}
	changed();
}

/** 未挂载的输入框也能收下引用；首次显示时再消费聚焦请求。 */
export function seedChildQuote(key: string, quote: DraftQuote): void {
	const draft = childDraft(key);
	focus.add(key);
	setChildDraft(key, { ...draft, quotes: [...draft.quotes, quote] });
}

/** 回执条上收回的那句话放回输入框：换掉正写着的字（附件、引用留着），显示时聚焦到末尾。 */
export function seedChildText(key: string, text: string): void {
	focus.add(key);
	setChildDraft(key, { ...childDraft(key), text });
}

export function takeChildQuoteFocus(key: string): boolean {
	return focus.delete(key);
}

export function flushChildDrafts(): void {
	for (const [key, draft] of drafts) save(key, draft);
}

export function dropChildDraft(key: string): void {
	localStorage.removeItem(PREFIX + key);
	drafts.delete(key);
	focus.delete(key);
	changed();
}

if (typeof window !== "undefined")
	window.addEventListener("storage", (event) => {
		if (!event.key?.startsWith(PREFIX)) return;
		drafts.set(event.key.slice(PREFIX.length), read(event.newValue));
		changed();
	});
