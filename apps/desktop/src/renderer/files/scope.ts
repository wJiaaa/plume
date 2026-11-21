/**
 * 回复里的文件签要知道的那场对话：哪个会话（读文件、找文件都按会话）、它的工作目录（相对路径的基准），
 * 以及这场对话里读过、改过、写过的文件的路径（对得上就当场画成文件签，不用等磁盘）。
 *
 * 由画对话的地方提供；别处画的 Markdown（文件面板里的文档）没有它，路径照旧是普通的字。
 */

import type { Message } from "@plume/contract";
import { createContext, useContext, useMemo } from "react";
import { lineFile, toolKind } from "../conversation/tool-lines.ts";

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
 * 画一场对话的地方交给 `FileScope` 的那一份。消息每落一条（每个工具结果都是一条）都要重新数一遍碰过的文件，但多半还是那几个：
 * 按内容记住，路径没变就还是同一个对象。换成新对象的话，转录里每一个读它的组件（文件签、代码块、人的气泡）都跟着重画，
 * 窗口里挂着的二十轮在每条消息落地的那一下整片重画一遍。
 */
export function useFileScopeValue(sessionId: string, cwd: string, messages: readonly Message[]): FileScopeValue {
	// 路径里不会有 NUL，拿它连起来比内容。
	const key = useMemo(() => touchedPaths(messages).join("\0"), [messages]);
	return useMemo(() => ({ sessionId, cwd, touched: key ? key.split("\0") : [] }), [sessionId, cwd, key]);
}

/**
 * 这场对话里成功的调用对着的文件（插件经 `ToolLine.file` 说的；列目录的不算），按写来的样子，没有解析：
 * 绝对路径，或相对会话的工作目录。
 */
function touchedPaths(messages: readonly Message[]): string[] {
	const failed = new Set<string>();
	for (const message of messages) if (message.role === "toolResult" && message.isError) failed.add(message.toolCallId);
	const answered = new Set<string>();
	for (const message of messages) if (message.role === "toolResult") answered.add(message.toolCallId);
	const paths = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || !answered.has(block.id) || failed.has(block.id) || toolKind(block.name) === "list") continue;
			const file = lineFile(block.name, block.arguments);
			if (file) paths.add(file.path);
		}
	}
	return [...paths];
}
