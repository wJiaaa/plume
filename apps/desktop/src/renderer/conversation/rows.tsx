/**
 * 一条消息画成的一行。人说的话是气泡；agent 的是一列块——推理、正文、夹在两句话中间的调用——一轮收尾的那句底下有时间和复制。
 * 界面替人说的话（「继续」）什么都不画：那不是人说的；后台送回来的结果画成一行说明。
 */

import type { AssistantMessage, Message } from "@plume/contract";
import type { ConversationProps } from "@plume/contract/ui";
import { memo, useContext } from "react";
import { Markdown } from "../markdown/Markdown.tsx";
import { copyCodeBlock, ReplyActions, replyText as pluginReplyText } from "../plugins.tsx";
import { copyReply } from "../markdown/copy-reply.ts";
import { Transcript } from "./view-state.ts";
import { DeliveryRow } from "./DeliveryRow.tsx";
import { PeerLetterRow } from "./PeerLetterRow.tsx";
import { ForkAction } from "./ForkAction.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { useMessageEdits } from "./message-edits.ts";
import { restated, segments } from "./reply-segments.ts";
import { ThinkingBlock } from "./ThinkingBlock.tsx";
import { PluginToolCard, ToolCard } from "./ToolCard.tsx";
import { ToolCall } from "./ToolGroup.tsx";
import { LEGACY_TOOL_ROWS } from "./tool-view.ts";
import { sameRow, type TurnStats } from "./turns.ts";
import { UserBubble } from "./UserBubble.tsx";

type RowProps = Pick<ConversationProps, "renderUserMessage" | "replyText"> & {
	message: Message;
	/** 这条消息在会话里的位置：撤回、编辑、分叉按它认是哪一条。 */
	index: number;
	/** 人说的话里最后那一条：只有它能编辑。 */
	last?: boolean | undefined;
	/** 这一行有几块内容：最后一句话之后的调用归下面那一段，不归这句话。 */
	upTo: number;
	/** 回复开头的推理在上面单独成了一行时，正文这一行从它后面起。 */
	from?: number | undefined;
	viewKey: string;
	/** 不是这一轮的收尾：不是 `Run.closes` 那一行，或者这一轮还在跑。没有时间和复制那一行。 */
	continued: boolean;
	/** 一轮中间说完了的一句，见 `Run.pauses`：有时间和复制，没有整轮的统计。 */
	pauses?: boolean | undefined;
	/** 只是收尾那句的页脚，接在这一轮最后一行后面，见 `Run.trailer`。 */
	trailer?: boolean | undefined;
	/** 这一轮的账，页脚上的耗时和 tok/s。 */
	turnStats?: TurnStats | undefined;
	showThinking: boolean;
	/** 插件给这个工具登记了自己的卡片。 */
	ownCard: (name: string) => boolean;
};

/**
 * 只在自己那条消息变了时重画：转录每个 token 都重画，上面几百行都没变。消息是整条换掉而不是原地改的，按引用比正好；
 * `turnStats` 每次分组都是新对象，按数比，见 `sameRow`。
 */
export const MessageRow = memo(function MessageRow(props: RowProps) {
	const { message } = props;
	const transcript = useContext(Transcript);
	if (message.role === "user") {
		if (message.synthetic) {
			// 一次送达里可以既有后台结果、又有别的会话的信：各画各的那一行。
			const delivery = message.delivery?.length && transcript ? <DeliveryRow delivery={message.delivery} sessionId={transcript.sessionId} /> : null;
			const letters = message.peer?.length ? <PeerLetterRow letters={message.peer} stateKey={`peer-${props.index}`} /> : null;
			return delivery && letters ? (
				<>
					{delivery}
					{letters}
				</>
			) : (
				(delivery ?? letters)
			);
		}
		const fallback = <UserBubble message={message} index={props.index} last={props.last === true} />;
		return props.renderUserMessage ? props.renderUserMessage(message, fallback) : fallback;
	}
	if (message.role === "toolResult") return null;
	return <AssistantRow {...props} message={message} />;
}, sameRow);

function AssistantRow({
	message,
	index,
	upTo,
	from = 0,
	viewKey,
	continued,
	pauses,
	trailer,
	turnStats,
	showThinking,
	ownCard,
	replyText,
}: RowProps & { message: AssistantMessage }) {
	const edits = useMessageEdits();
	const transcript = useContext(Transcript);
	const visibleText = (text: string) => {
		const filtered = pluginReplyText(text);
		return replyText ? replyText(filtered, message) : filtered;
	};
	const own = message.content.slice(from, upTo);
	const pending = message.stopReason === "pending";
	const stats = continued ? undefined : turnStats;
	// 复制的是这一行画出来的话：被最终答复重说过的播报不算，见 `restated`。
	const texts = own.map((block) => (block.type === "text" && !restated(block, message.content) ? visibleText(block.text) : ""));
	const copied = texts.filter(Boolean).join("\n\n");
	return (
		// `group/msg` 让下面那行跟着悬停整条回复显出来。`empty:hidden`：只剩一块空正文的回复什么也画不出，不该占一份行距。
		// `data-plume-quote`：一条回复里选中的字可以引用，见 `QuoteMenu`。
		<div data-plume-quote="assistant" className="group/msg flex flex-col gap-2.5 empty:hidden">
			{/* 页脚那一行：话已经在上面画过了，这里只要它的字给复制用。 */}
			{!trailer &&
				segments(own).map((segment, position) => {
					if (segment.kind === "tools") {
						return segment.blocks.map((block) => {
							const call = { block, stopReason: message.stopReason };
							if (LEGACY_TOOL_ROWS) return ownCard(block.name) ? <PluginToolCard key={block.id} call={call} /> : <ToolCard key={block.id} call={call} />;
							return ownCard(block.name) ? (
								<PluginToolCard key={block.id} call={call} fallback={<ToolCall call={call} />} />
							) : (
								<ToolCall key={block.id} call={call} />
							);
						});
					}
					// 段在这一行里的位置；`index` 留给消息在会话里的位置（插件的 `messageId` 用它）。
					const { block, index: local, last } = segment;
					const at = from + local;
					if (block.type === "thinking") {
						// 只有推理的行在分组时就拿掉了（`withoutThinking`）；这里是夹在一条回复的话中间的那几段。
						if (!showThinking) return null;
						return (
							<ThinkingBlock
								key={at}
								stateKey={`${viewKey}:thinking:${at}`}
								text={block.thinking}
								redacted={block.redacted === true}
								startedAt={block.startedAt}
								durationMs={block.durationMs}
								// 字还在到：后面没有别的块了。
								live={pending && from + last === message.content.length - 1}
							/>
						);
					}
					// 最终答复会把同一条回复里先播报过的话再说一遍，播报就不再画了。
					if (block.type !== "text" || restated(block, message.content)) return null;
					// 插件让模型顺带写的标记（`ui.replyText`）不画；只剩标记的一段整段不画。
					const text = texts[local];
					if (!text) return null;
					return (
						<div key={`prose-${position}`}>
							<Markdown
								text={text}
								localImages
								streaming={pending && at === message.content.length - 1}
								reply={{
									messageId: `${index}:${message.timestamp}`,
									part: at,
									complete: message.stopReason === "stop" || message.stopReason === "toolUse",
									streaming: pending,
								}}
							/>
						</div>
					);
				})}
			{/*
			 * 只在一轮真正收尾的那句底下。一条回答常常是好几条回复——说要做什么、调工具、读结果、说下一件——中间那几句停在
			 * `toolUse` 上，不是回答的结尾；每句都挂一行的话，一条回答底下盖了四次时间。哪句是收尾由 `grouping.ts` 定（`Run.closes`）。
			 * 一轮中间说完的一句（`pauses`）也是说完了的一段：跑着的时候它也已经定了，不等这一轮收尾；它的数只说它自己。
			 */}
			{(!continued || pauses) && copied.trim() && (
				<MessageActions
					// 页脚单独成行时，悬停这一轮的哪一行都显出来：它说的是整轮，不是正下方那几个调用。
					className={trailer ? "-mt-1.5 group-hover/turn:opacity-100" : "-mt-1.5"}
					timestamp={message.timestamp}
					text={copied}
					copyText={() =>
						transcript && (message.stopReason === "stop" || message.stopReason === "toolUse")
							? copyReply(copied, (language, code) => copyCodeBlock(language, code, transcript.sessionId))
							: copied
					}
					durationMs={stats?.durationMs ?? message.durationMs}
					requestMs={stats?.requestMs ?? message.durationMs}
					sseDurationMs={stats?.sseDurationMs ?? message.sseDurationMs}
					tokens={stats?.outputTokens ?? message.usage.output}
					requests={stats?.requestCount}
				>
					{transcript && <ReplyActions sessionId={transcript.sessionId} from={stats?.startIndex ?? index} to={index + 1} />}
					{/* 只给落定的回复：停在工具调用上的那句分出去，新会话会以一个没有结果的调用结尾。 */}
					{edits?.fork && message.stopReason !== "toolUse" && message.stopReason !== "pending" && <ForkAction onFork={() => edits.fork!(index, message)} />}
				</MessageActions>
			)}
		</div>
	);
}
