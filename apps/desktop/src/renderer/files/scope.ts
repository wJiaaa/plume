/**
 * 回复里的文件签要知道的那场对话：哪个会话（读文件、找文件都按会话）、它的工作目录（相对路径的基准），
 * 以及这场对话里 read、edit、write 成功过的路径（对得上就当场画成文件签，不用等磁盘）。
 *
 * 由画对话的地方提供；别处画的 Markdown（文件面板里的文档）没有它，路径照旧是普通的字。
 */

import type { Message } from "@plume/contract";
import { createContext, useContext } from "react";

export interface FileScopeValue {
	sessionId: string;
	cwd: string;
	touched: readonly string[];
}

export const FileScope = createContext<FileScopeValue | null>(null);

export function useFileScope(): FileScopeValue | null {
	return useContext(FileScope);
}

/** 带着本机文件路径的工具。`path` 是绝对路径，或相对会话的工作目录。 */
const PATH_TOOLS = new Set(["read", "edit", "write"]);

/** 这场对话里 read、edit、write 成功过的路径，按写来的样子，没有解析。 */
export function touchedPaths(messages: readonly Message[]): string[] {
	const failed = new Set<string>();
	for (const message of messages) if (message.role === "toolResult" && message.isError) failed.add(message.toolCallId);
	const answered = new Set<string>();
	for (const message of messages) if (message.role === "toolResult") answered.add(message.toolCallId);
	const paths = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || !PATH_TOOLS.has(block.name) || !answered.has(block.id) || failed.has(block.id)) continue;
			const path = (block.arguments as Record<string, unknown>).path;
			if (typeof path === "string") paths.add(path);
		}
	}
	return [...paths];
}
