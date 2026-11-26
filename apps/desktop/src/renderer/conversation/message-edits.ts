/**
 * 消息底下那排的编辑、撤回、分叉：只有用户自己的会话有，由转录的主人（主对话）给。插件画的子会话转录默认不给，
 * 那里的一轮只有插件能发起；插件开了 `ConversationProps.reask`（侧边聊天）时给编辑重问（`aside`）和撤回，没有分叉。
 * 转录自己会把它清成 null，嵌在主对话卡片里的子转录不会借到主对话的这三样。
 */

import type { AssistantMessage, RevertPlan, UserMessage } from "@plume/contract";
import { createContext, useContext } from "react";

export interface MessageEdits {
	/**
	 * 子会话里的编辑重问：按钮和编辑框照侧边聊天的说法（「重新提问」），编辑框矮一些；改过文件时照样问要不要一起退回。
	 * 子会话有撤回（放回它自己的输入框，照样问要不要连文件一起撤回），没有分叉和 `attachImage`。
	 */
	aside?: boolean;
	/** 截掉这条和之后的，拿改过的字重新跑一轮。`files` 为真时先把截掉的那几轮改过的文件退回去。 */
	edit(index: number, message: UserMessage, text: string, files: boolean): Promise<void>;
	/** 截掉这条和之后的，把这条原样再问一遍（「重试」）：重问就是拿它自己替换它。 */
	retry(index: number, message: UserMessage): Promise<void>;
	/** 截掉这条和之后的，这条放回输入框。`files` 同 `edit`。 */
	revert?(index: number, message: UserMessage, files: boolean): Promise<void>;
	/** 截掉这条和之后的会碰到哪些文件，只演算。 */
	revertPlan?(index: number, message: UserMessage): Promise<RevertPlan>;
	/** 从这条分叉出一个新会话并打开它。 */
	fork?(index: number, message: UserMessage | AssistantMessage): Promise<void>;
	/** 发出去的图在看图器里标注完（`data:` URL）：作为附件挂到这个会话的输入框上，下一句照着它说。 */
	attachImage?(dataUrl: string): void;
}

export const MessageEditsContext = createContext<MessageEdits | null>(null);

export function useMessageEdits(): MessageEdits | null {
	return useContext(MessageEditsContext);
}
