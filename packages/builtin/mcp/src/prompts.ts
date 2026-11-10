/**
 * MCP 服务的 prompt（服务端写好的一段提问模板）进输入框的 `/` 菜单：`/mcp:<服务>:<prompt> 参数`，发出去的是服务按参数
 * 填好的那段话。命令名只能是小写字母、数字、连字符，用 `:` 分段，所以名字要折一下。
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface PromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

export interface PromptEntry {
	/** 服务那边的名字，调 `prompts/get` 用。 */
	prompt: string;
	description: string;
	arguments: PromptArgument[];
}

const PAGES = 50;

export async function listPrompts(client: Client, timeout: number): Promise<PromptEntry[]> {
	if (!client.getServerCapabilities()?.prompts) return [];
	const out: PromptEntry[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < PAGES; page++) {
		const listed = await client.listPrompts(cursor ? { cursor } : undefined, { timeout });
		for (const prompt of listed.prompts) {
			out.push({
				prompt: prompt.name,
				description: prompt.description ?? prompt.title ?? prompt.name,
				arguments: (prompt.arguments ?? []).map((argument) => ({
					name: argument.name,
					...(argument.description ? { description: argument.description } : {}),
					...(argument.required ? { required: true } : {}),
				})),
			});
		}
		cursor = listed.nextCursor;
		if (!cursor) break;
	}
	return out;
}

/** 折成命令名的一段：小写，别的字符换成连字符。全是别的字符（中文名）时给空串，调用方换成编号。 */
export function commandSegment(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** 菜单里名字后面的参数提示：必填的 `<x>`，可选的 `[x]`。 */
export function argumentHint(entry: Pick<PromptEntry, "arguments">): string | undefined {
	if (entry.arguments.length === 0) return undefined;
	return entry.arguments.map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`)).join(" ");
}

export type BoundArguments = { ok: true; args: Record<string, string> } | { ok: false; missing: string[] };

/**
 * 命令后面那段字拆成参数。只有一个参数时整段都给它（`/mcp:x:summarize 这一段话` 不该只拿到第一个词）；
 * 否则 `name=value` 按名字给，其余按位置依次给还空着的，最后一个吃掉剩下的。
 */
export function bindArguments(entry: Pick<PromptEntry, "arguments">, rest: string): BoundArguments {
	const declared = entry.arguments;
	const args: Record<string, string> = {};
	const text = rest.trim();
	if (declared.length === 1 && declared[0] && text && !namedToken(text, declared)) {
		args[declared[0].name] = text;
	} else if (text) {
		const positional: string[] = [];
		for (const token of splitArguments(text)) {
			const named = namedToken(token, declared);
			if (named) args[named.name] = named.value;
			else positional.push(token);
		}
		const open = declared.filter((argument) => args[argument.name] === undefined);
		positional.forEach((value, index) => {
			const target = open[Math.min(index, open.length - 1)];
			if (!target) return;
			args[target.name] = args[target.name] === undefined ? value : `${args[target.name]} ${value}`;
		});
	}
	for (const [name, value] of Object.entries(args)) if (!value) delete args[name];
	const missing = declared.filter((argument) => argument.required && !args[argument.name]).map((argument) => argument.name);
	return missing.length > 0 ? { ok: false, missing } : { ok: true, args };
}

function namedToken(token: string, declared: readonly PromptArgument[]): { name: string; value: string } | null {
	const match = /^([A-Za-z_][\w-]*)=([\s\S]*)$/.exec(token);
	if (!match?.[1] || !declared.some((argument) => argument.name === match[1])) return null;
	return { name: match[1], value: (match[2] ?? "").trim() };
}

/** 引号把一组词括在一起，其余按空白分。不认反斜杠转义：这里敲的是路径和短语，`C:\Users\x` 丢了分隔符比多敲一个引号更糟。 */
export function splitArguments(rest: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let started = false;
	for (const character of rest) {
		if (quote) {
			if (character === quote) quote = null;
			else current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started || current) out.push(current);
			current = "";
			started = false;
			continue;
		}
		current += character;
	}
	if (started || current) out.push(current);
	return out;
}

/** `prompts/get` 回来的消息换成发出去的文字。命令只能展开成文字：图片、音频写一句说明。 */
export function promptText(messages: readonly { role: string; content: unknown }[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		const block = message.content as Record<string, unknown> | undefined;
		if (!block) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "resource") {
			const resource = block.resource as Record<string, unknown> | undefined;
			if (typeof resource?.text === "string") parts.push(resource.text);
			else if (resource?.uri) parts.push(`[resource ${String(resource.uri)}]`);
		} else if (block.type === "resource_link" && typeof block.uri === "string") parts.push(`[resource ${block.uri}]`);
		// i18n-exempt：发给模型的说明。
		else if (block.type === "image") parts.push("[image omitted]");
		else if (block.type === "audio") parts.push("[audio omitted]");
	}
	return parts.join("\n\n");
}
