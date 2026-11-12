/** 给人读的会话导出：保留正文和工具摘要，省略思考与普通工具输出；附件只列名称，不读取或复制内容。 */
import type { AssistantMessage, CompactionMark, Message, SessionSummary, UserMessage } from "@plume/contract";

import { DELIVERED_HEADER } from "./background.ts";
import { text, type TextKey } from "./i18n.ts";

type ExportKey = Extract<TextKey, `export.${string}`> extends `export.${infer Key}` ? Key : never;
type Translate = (key: ExportKey, variables?: Readonly<Record<string, string | number>>) => string;

export function conversationMarkdown(
	input: {
		summary: SessionSummary;
		messages: readonly Message[];
		compactions: readonly CompactionMark[];
		exportedAt: Date;
		modelLabel?: (provider: string, model: string) => string;
		/** 注册这个工具的插件给的说法（`ToolDefinition.describe`）；没有时用这里认得的几种基本工具，再不然写工具名。 */
		describeTool?: (name: string, args: Record<string, unknown>) => string | undefined;
		/** 这次调用是替哪个工具调的（`ToolDefinition.forwards`）：这一行按被调的那个写。 */
		forwardTool?: (name: string, args: Record<string, unknown>) => { name: string; args: Record<string, unknown> } | undefined;
		/** 这次调用的结果里要引出来的那段（`ToolDefinition.exportResult`）。 */
		quoteResult?: (result: Extract<Message, { role: "toolResult" }>) => string | undefined;
	},
	locale: string,
): string {
	const language = locale.toLowerCase().startsWith("en") ? "en" : "zh-CN";
	const t: Translate = (key, variables) => text(`export.${key}`, variables, language);
	const label = input.modelLabel ?? ((provider: string, model: string) => `${provider}/${model}`);
	const models = new Set<string>();
	const results = new Map<string, Extract<Message, { role: "toolResult" }>>();
	for (const message of input.messages) {
		if (message.role === "assistant" && message.stopReason !== "pending") models.add(label(message.provider, message.model));
		if (message.role === "toolResult") results.set(message.toolCallId, message);
	}
	const head = [
		`# ${escapeInline(input.summary.title.trim() || t("untitled"))}`,
		[
			`- ${t("exported", { time: localTime(input.exportedAt) })}`,
			input.summary.cwd ? `- ${t("project", { path: escapeInline(input.summary.cwd) })}` : "",
			models.size ? `- ${t("models", { models: [...models].map(escapeInline).join(t("separator")) })}` : "",
		]
			.filter(Boolean)
			.join("\n"),
	];
	const body: string[] = [];
	let speaker: "user" | "assistant" | null = null;
	let model: string | null = null;
	let calls: string[] = [];
	const flush = () => {
		if (calls.length) body.push(calls.join("\n"));
		calls = [];
	};
	const say = (who: "user" | "assistant") => {
		if (speaker === who) return;
		flush();
		body.push(`## ${t(who)}`);
		speaker = who;
	};
	const divider = (text: string) => {
		flush();
		body.push(`*— ${escapeInline(text)} —*`);
		speaker = null;
	};
	const compactions = input.compactions.map((mark) => mark.keptFrom).sort((a, b) => a - b);
	let nextCompaction = 0;
	for (const [index, message] of input.messages.entries()) {
		while (nextCompaction < compactions.length && compactions[nextCompaction]! <= index) {
			nextCompaction++;
			divider(t("compacted"));
		}
		if (message.role === "user") {
			if (message.delivery?.length) {
				flush();
				body.push(...delivered(message, t));
				speaker = null;
			} else if (message.peer?.length) {
				flush();
				for (const letter of message.peer) body.push(`### ${t("peer", { from: escapeInline(letter.from) })}`, quote(letter.text));
				speaker = null;
			} else if (!message.synthetic) {
				const text = spoken(message);
				const files = attachmentNames(message, t);
				if (!text && !files.length) continue;
				say("user");
				if (text) body.push(closeOpenFence(text));
				if (files.length) body.push(t("attachments", { names: files.map(escapeInline).join(t("separator")) }));
			}
			continue;
		}
		if (message.role === "toolResult") {
			const conclusion = input.quoteResult?.(message)?.trim();
			if (conclusion) {
				flush();
				body.push(quote(conclusion));
			}
			continue;
		}
		if (message.stopReason === "pending") continue;
		const name = label(message.provider, message.model);
		if (model !== null && model !== name) divider(t("switched", { from: model, to: name }));
		model = name;
		for (const block of message.content) {
			if (block.type === "thinking") continue;
			if (block.type === "text") {
				if (!block.text.trim() || restated(block, message.content)) continue;
				say("assistant");
				flush();
				body.push(closeOpenFence(block.text.trim()));
			} else {
				say("assistant");
				const routed = input.forwardTool?.(block.name, block.arguments) ?? { name: block.name, args: block.arguments };
				const summary = (input.describeTool?.(routed.name, routed.args) || toolSummary(routed.name, routed.args)).replace(/\s+/g, " ").trim();
				calls.push(
					`- ${inlineCode(routed.name)}${summary && summary !== routed.name ? ` ${escapeInline(summary)}` : ""}${results.get(block.id)?.isError ? t("failed") : ""}`,
				);
			}
		}
		if (message.stopReason === "error" && message.errorMessage) {
			say("assistant");
			flush();
			body.push(`*${escapeInline(t("replyFailed", { reason: message.errorMessage.replace(/\s+/g, " ").trim() }))}*`);
		}
	}
	while (nextCompaction++ < compactions.length) divider(t("compacted"));
	flush();
	if (!body.length) body.push(t("empty"));
	return `${[...head, ...body].join("\n\n")}\n`;
}

function spoken(message: UserMessage): string {
	const skill = message.skillRef ? `/${message.skillRef.pluginId ? `${message.skillRef.pluginId}:` : ""}${message.skillRef.name}` : "";
	if (message.displayText !== undefined) return [skill, message.displayText.trim()].filter(Boolean).join(" ");
	return message.content
		.flatMap((block) =>
			block.type === "text" &&
			!/^\n\n(?:### |\[)(?:Attached (?:file|folder)|Attachment \d+)[:,]/.test(block.text) &&
			!/^\n\n(?:### |\[)Attachment \d+ of \d+/.test(block.text)
				? [block.text]
				: [],
		)
		.join("\n")
		.trim();
}

function attachmentNames(message: UserMessage, t: Translate): string[] {
	const names: string[] = [];
	let images = 0;
	for (const file of message.attachments ?? []) {
		if (!file || typeof file !== "object") continue;
		const image = file.kind === "image" || (file.kind === undefined && typeof file.mimeType === "string" && file.mimeType.startsWith("image/"));
		names.push(image ? t("image", { n: ++images }) : file.name);
	}
	const blocks = message.content.filter((block) => block.type === "image").length;
	while (images < blocks) names.push(t("image", { n: ++images }));
	return names;
}

/**
 * 一条运行时送达：宿主自己的外壳——每份按通用字段写一行（`title` 和收场），下面引出送给模型的原文。各份怎么写、带什么标签
 * 是交它的插件的事，这里不拆；宿主自己的抬头（`DELIVERED_HEADER`）不是正文，不写。
 */
function delivered(message: UserMessage, t: Translate): string[] {
	const lines = (message.delivery ?? []).map((report) => {
		const outcome = report.status === "failed" ? t("failed") : report.status === "aborted" ? t("aborted") : report.incomplete ? t("incomplete") : "";
		return `- ${escapeInline(report.title.replace(/\s+/g, " ").trim() || report.id)}${outcome}`;
	});
	const words = message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n\n")
		.trim();
	const body = (words.startsWith(DELIVERED_HEADER) ? words.slice(DELIVERED_HEADER.length) : words).trim();
	return [`### ${t("delivered")}`, lines.join("\n"), ...(body ? [quote(body)] : [])];
}

function restated(block: AssistantMessage["content"][number], content: AssistantMessage["content"]): boolean {
	return (
		block.type === "text" &&
		block.phase === "commentary" &&
		content.some((other) => other.type === "text" && other.phase === "final_answer" && other.text.trim() !== "")
	);
}

/** 基本文件和命令工具的说法；别的工具由注册它的插件给（`describeTool`），没给时写工具名。 */
function toolSummary(name: string, args: Record<string, unknown>): string {
	const str = (...keys: string[]) => keys.map((key) => args[key]).find((value): value is string => typeof value === "string");
	const path = str("path", "file", "filePath");
	const term = str("pattern", "query", "search");
	switch (name) {
		case "read":
			return path ? `Read ${path}` : "Read file";
		case "write":
			return path ? `Write ${path}` : "Write file";
		case "edit":
			return path ? `Edit ${path}` : "Edit file";
		case "ls":
			return `List ${str("path", "dir", "cwd") ?? "."}`;
		case "glob":
			return term ? `Find ${term}` : "Find files";
		case "grep":
			return term ? `Search "${term}"` : "Search";
		case "bash":
			return (str("description") ?? (str("command") ?? "bash").split("\n")[0]!.slice(0, 80)) || "Run bash command";
		case "bash_output":
			return args.kill === true ? "Stop job" : "Check job";
		default:
			return name;
	}
}

/** 行内代码的围栏比内容里最长的一串反引号还长。 */
function inlineCode(text: string): string {
	let length = 1;
	for (const match of text.matchAll(/\x60+/g)) length = Math.max(length, match[0].length + 1);
	const fence = "`".repeat(length);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** 中断的 Markdown 先合上围栏，避免后面的说话人、结论被吞进去。 */
function closeOpenFence(text: string): string {
	let open: string | null = null;
	for (const line of text.split("\n")) {
		const fence = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
		if (!fence) continue;
		const marks = fence[1]!;
		const rest = fence[2]!;
		if (open === null) {
			if (marks[0] === "`" && rest.includes("`")) continue;
			open = marks;
		} else if (marks[0] === open[0] && marks.length >= open.length && !rest.trim()) open = null;
	}
	return open === null ? text : `${text}\n${open}`;
}

function quote(text: string): string {
	return closeOpenFence(text.trim())
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
}

function escapeInline(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, " ").replace(/[\\\x60*_[\]<>|~#]/g, "\\$&");
}

function localTime(at: Date): string {
	const two = (value: number) => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}
