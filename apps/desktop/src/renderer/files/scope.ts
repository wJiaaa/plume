/**
 * 回复里的文件签要知道的那场对话：哪个会话（读文件、找文件都按会话）、它的工作目录（相对路径的基准），
 * 以及这场对话里读过、改过、写过的文件的路径（对得上就当场画成文件签，不用等磁盘）。
 *
 * 由画对话的地方提供；别处画的 Markdown（文件面板里的文档）没有它，路径照旧是普通的字。
 */

import type { Message } from "@plume/contract";
import { createContext, useContext } from "react";
import { lineFile, toolLine } from "../conversation/tool-lines.ts";

export interface FileScopeValue {
	sessionId: string;
	cwd: string;
	touched: readonly string[];
}

export const FileScope = createContext<FileScopeValue | null>(null);

export function useFileScope(): FileScopeValue | null {
	return useContext(FileScope);
}

/**
 * 这场对话里成功的调用对着的文件（插件经 `ToolLine.file` 说的；列目录的不算），按写来的样子，没有解析：
 * 绝对路径，或相对会话的工作目录。
 */
export function touchedPaths(messages: readonly Message[]): string[] {
	const failed = new Set<string>();
	for (const message of messages) if (message.role === "toolResult" && message.isError) failed.add(message.toolCallId);
	const answered = new Set<string>();
	for (const message of messages) if (message.role === "toolResult") answered.add(message.toolCallId);
	const paths = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || !answered.has(block.id) || failed.has(block.id) || toolLine(block.name)?.kind === "list") continue;
			const file = lineFile(block.name, block.arguments);
			if (file) paths.add(file.path);
		}
	}
	return [...paths];
}
