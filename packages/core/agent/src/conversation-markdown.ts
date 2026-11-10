/** 给人读的会话导出：保留正文和工具摘要，省略思考与普通工具输出；附件只列名称，不读取或复制内容。 */
import type { AssistantMessage, CompactionMark, Message, SessionSummary, UserMessage } from "@plume/contract";

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
			const detached = (message.details as { detached?: unknown } | undefined)?.detached;
			if (message.toolName === "task" && !message.isError && !detached) {
				const conclusion = message.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n")
					.trim();
				if (conclusion) {
					flush();
					body.push(quote(conclusion));
				}
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
				const routed = routedCall(block.name, block.arguments);
				const summary = toolSummary(routed.name, routed.args).replace(/\s+/g, " ").trim();
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

const REPORT = /^<(subagent_result|session_result)\b[^>]*>\n([\s\S]*)\n<\/\1>$/;
function delivered(message: UserMessage, t: Translate): string[] {
	const out: string[] = [];
	const reports = { subagent_result: [] as string[], session_result: [] as string[] };
	for (const block of message.content) {
		const match = block.type === "text" ? REPORT.exec(block.text.trim()) : null;
		if (match) reports[match[1] as keyof typeof reports].push(match[2]!.trim());
	}
	let agents = 0;
	let sessions = 0;
	for (const report of message.delivery ?? []) {
		if (report.kind === "job") {
			const key = !report.monitor ? "job" : report.monitor.stopped ? "monitorStopped" : "monitor";
			out.push(`- ${t(key, { command: escapeInline(report.description || report.command || ""), n: report.monitor?.lines ?? 0 })}`);
		} else if (report.kind === "wakeup") out.push(`- ${t("wakeup", { reason: escapeInline(report.description) })}`);
		else {
			const text = report.kind === "session" ? reports.session_result[sessions++] : reports.subagent_result[agents++];
			out.push(
				`### ${report.kind === "session" ? t("session", { title: escapeInline(report.description) }) : t("agent", { agent: escapeInline(report.agent || "agent"), task: escapeInline(report.description) })}`,
			);
			if (text) out.push(quote(text));
		}
	}
	return out;
}

function restated(block: AssistantMessage["content"][number], content: AssistantMessage["content"]): boolean {
	return (
		block.type === "text" &&
		block.phase === "commentary" &&
		content.some((other) => other.type === "text" && other.phase === "final_answer" && other.text.trim() !== "")
	);
}

function routedCall(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
	if (name !== "mcp_call" || typeof args.tool !== "string") return { name, args };
	return {
		name: args.tool,
		args: args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? (args.arguments as Record<string, unknown>) : {},
	};
}

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
		case "symbol":
			return str("name", "query", "symbol", "pattern") ? `Find definition of ${str("name", "query", "symbol", "pattern")}` : "Find definition";
		case "web_search":
			return str("query", "pattern", "search") ? `Search ${str("query", "pattern", "search")}` : "Search the web";
		case "web_fetch":
			return `Fetch ${str("url") ?? ""}`.trim() || "Fetch URL";
		case "bash":
		case "monitor":
			return (str("description") ?? (str("command") ?? "bash").split("\n")[0]!.slice(0, 80)) || "Run bash command";
		case "bash_output":
			return args.kill === true ? "Stop job" : "Check job";
		case "todo_write":
			return "Update task list";
		case "task":
			return str("description") ?? "Sub-agent task";
		case "skill":
			return `Skill: ${str("name") ?? ""}`.trim();
		case "image_generate":
			return str("prompt")?.trim() ? `Generate image ${str("prompt")!.trim().split("\n")[0]!.slice(0, 80)}` : "Generate image";
		default:
			return name.startsWith("mcp__") ? `${name.split("__")[1]}: ${name.split("__")[2]}` : name;
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
