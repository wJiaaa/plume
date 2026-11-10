/**
 * 同工具、同参数、同结果：第三次纠正、第十次停止；翻页和切图测距只提醒，不据此停下真实工作。
 * 一步的成功 edit/write 先统一清零，测距脚本不算；人工新消息和压缩后也清零，「继续」沿用计数。
 * 替换仅作用于模型上下文，会话和卡片保留原文；旧替换不随清零撤销，保持请求前缀稳定。
 */

import { createHash } from "node:crypto";
import type { Message, ToolResultMessage } from "@plume/llm/types";

const REPEAT_WARN = 3;
const REPEAT_STOP = 10;
const INTENT_WARN = 12;
const PROBE_WARN = 5;
const PAGING_KEYS = new Set(["offset", "limit", "page", "cursor", "after", "before", "start", "skip", "count"]);

export class RepetitionWatch {
	private readonly counts = new Map<string, number>();
	private readonly warned = new Set<string>();
	private readonly intents = new Map<string, number>();
	private probes = 0;
	private probeWarned = false;
	readonly replaced = new Map<string, string>();
	private hint: string | undefined;

	/** 整步一起观察：同一步有真实改动时，旧观察先作废，再数这一批调用。 */
	observe(calls: { name: string; arguments: unknown }[], results: ToolResultMessage[]): void {
		if (calls.some((call, index) => isWorkspaceProgress(call.name, call.arguments, results[index]))) this.reset();
		let warning: { tool: string; kind: "exact" | "intent" | "probe" } | undefined;
		for (const [index, call] of calls.entries()) {
			const result = results[index];
			if (!result) continue;
			const key = `${call.name} ${stable(call.arguments)} ${sample(result)}`;
			const count = (this.counts.get(key) ?? 0) + 1;
			this.counts.set(key, count);
			if (!warning && count >= REPEAT_WARN && count < REPEAT_STOP && !this.warned.has(key)) {
				this.warned.add(key);
				warning = { tool: call.name, kind: "exact" };
			}
			if (count >= REPEAT_WARN) this.replaced.set(result.toolCallId, repeatNotice(count, call.name));
		}
		// 精确重复优先，但翻页的计数不能跟着跳过。
		for (const call of calls) {
			const key = intentOf(call.name, call.arguments);
			const count = (this.intents.get(key) ?? 0) + 1;
			this.intents.set(key, count);
			if (!warning && count >= INTENT_WARN && !this.warned.has(key)) {
				this.warned.add(key);
				warning = { tool: call.name, kind: "intent" };
			}
		}
		for (const call of calls) {
			if (!isProbe(call.name, call.arguments)) continue;
			this.probes += 1;
			if (!warning && this.probes >= PROBE_WARN && !this.probeWarned) {
				this.probeWarned = true;
				warning = { tool: call.name, kind: "probe" };
			}
		}
		this.hint = warning ? repeatHint(warning.kind, warning.tool) : undefined;
	}

	exhausted(): boolean {
		return [...this.counts.values()].some((count) => count >= REPEAT_STOP);
	}

	/** 取走就清掉：插件换掉自然结论时，提醒也不留到下一步。 */
	takeHint(): string | undefined {
		const hint = this.hint;
		this.hint = undefined;
		return hint;
	}

	reset(): void {
		this.counts.clear();
		this.warned.clear();
		this.intents.clear();
		this.probes = 0;
		this.probeWarned = false;
		this.hint = undefined;
	}
}

// i18n-exempt：发给模型的话，不随界面语言变。
function repeatHint(kind: "exact" | "intent" | "probe", tool: string): string {
	if (kind === "probe") {
		return (
			`（自动提示）你已经连续多次切图、读切片或做像素测距。` +
			`这类探测回答不了「为什么间距是这样」——去读对应的 CSS 和组件结构，基于已有证据下结论。` +
			`不要再写新的测距脚本，也不要再切图。`
		);
	}
	if (kind === "intent") {
		return (
			`（自动提示）你已经用不同的翻页参数把 \`${tool}\` 的同一个问题问了很多遍。` +
			`翻页不会把答案翻出来——要么它本来就不在这里，要么该换个问法。` +
			`换个工具、换个假设，或者直接说明当前卡在哪里、需要什么。`
		);
	}
	return (
		`（自动提示）你已经用同样的参数调用 \`${tool}\` 多次，每次得到的结果都一样。` +
		`再问一次不会有新信息。换一个思路：换个工具、换个假设，或者直接说明当前卡在哪里、需要什么。`
	);
}

// i18n-exempt：发给模型的话。
function repeatNotice(seen: number, tool: string): string {
	return (
		`（这是你第 ${seen} 次用同样的参数调用 \`${tool}\`，结果和前几次一字不差，` +
		`所以这里不再重复贴一遍。它不会因为你再问一次就改变——要么先去动它，要么换个问法。）`
	);
}

/**
 * 发给模型的历史里，把记下的那几条结果换成「这是第 N 次」。只在模型眼前还摆着一份一字不差的原文时换：
 * 那句话的意思是「前面有，去看前面的」，前面那几份要是已经被裁掉了，它就指向了空处。
 */
export function replaceRepeats(messages: Message[], replaced: ReadonlyMap<string, string>): Message[] {
	if (replaced.size === 0) return messages;
	const calls = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, `${part.name} ${stable(part.arguments)}`);
	}
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const notice = replaced.get(message.toolCallId);
		if (notice === undefined) return message;
		const fingerprint = calls.get(message.toolCallId);
		const content = sample(message);
		const original = messages.some(
			(other) =>
				other !== message &&
				other.role === "toolResult" &&
				!replaced.has(other.toolCallId) &&
				calls.get(other.toolCallId) === fingerprint &&
				sample(other) === content,
		);
		return original ? { ...message, content: [{ type: "text", text: notice }] } : message;
	});
}

/** 键的顺序不该决定两个一样的调用看起来一不一样。 */
function stable(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([key, item]) => `${key}:${stable(item)}`).join(",")}}`;
}

/** 剥掉翻页参数后比较问题；非对象参数没有页码可剥。 */
function intentOf(name: string, args: unknown): string {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return `${name} ${stable(args)}`;
	const kept = Object.entries(args as Record<string, unknown>).filter(([key]) => !PAGING_KEYS.has(key.toLowerCase()));
	return `${name} ${stable(Object.fromEntries(kept))}`;
}

const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif)\b/i;
const MEASURE = /numpy|PIL\.|Image\.open|cv2\.|histogram|non[-_]?white|getBoundingClientRect|band_\d+|row_inspect|box_line|pixel.?count|screencast/i;
// 两种分隔符都认：Windows 上模型写的是 `C:\…\band_1.png`。
const SLICE_NAME = /(?:^|[\\/])(?:band_\d+|row_inspect|box_line|icon_\d+)[^\\/]*\.(?:png|jpe?g|webp)$/i;

function commandOf(args: unknown): string {
	if (args === null || typeof args !== "object" || !("command" in args)) return "";
	return String((args as { command: unknown }).command);
}

function pathOf(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const record = args as { path?: unknown; file_path?: unknown; contents?: unknown };
	if (typeof record.path === "string") return record.path;
	if (typeof record.file_path === "string") return record.file_path;
	return "";
}

function contentsOf(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const record = args as { content?: unknown; contents?: unknown };
	if (typeof record.content === "string") return record.content;
	if (typeof record.contents === "string") return record.contents;
	return "";
}

/** 切图、读切片、像素测距算同一种探测；写新的测距脚本不算工作区推进。 */
function isProbe(name: string, args: unknown): boolean {
	if (name === "bash") {
		const command = commandOf(args);
		return IMAGE_FILE.test(command) && MEASURE.test(command);
	}
	if (name === "read") return SLICE_NAME.test(pathOf(args));
	if (name === "write") {
		const path = pathOf(args);
		const contents = contentsOf(args);
		return SLICE_NAME.test(path) || (path.endsWith(".py") && IMAGE_FILE.test(contents) && MEASURE.test(contents));
	}
	return false;
}

function isWorkspaceProgress(name: string, args: unknown, result: Message | undefined): boolean {
	if ((name !== "edit" && name !== "write") || result?.role !== "toolResult" || result.isError) return false;
	return !isProbe(name, args);
}

function sample(result: ToolResultMessage): string {
	return createHash("sha256")
		.update(JSON.stringify({ content: result.content, isError: result.isError }))
		.digest("hex");
}
