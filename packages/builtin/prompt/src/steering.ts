/**
 * 插在一轮中间的那句话，发给模型时说清楚它是什么时候说的。
 *
 * 不说的话，它就是工具结果后面一条普通的用户消息，模型常把它读成一个新请求：回答完它就收尾，原来做到一半的任务被丢下。
 * 打断了这一轮的那句话（`interrupting`，排队条上的「现在就发」）是同一件事的另一种：它也是在模型工作时说的，只是会话为它
 * 停下了手上的事，模型读到它时自己的上一条回复停在半截。
 *
 * 只在拼请求时加，会话和界面里是人打的原话，同一份历史每次渲染出一样的字节，前缀缓存不受影响。只套人说的：`synthetic` 的
 * 送达和别的会话来信各有自己的说明。
 */

import type { Message, UserMessage } from "@plume/contract";

// i18n-exempt：下面四句是发给模型的话，不随界面语言变。
const BEFORE = "（插话）用户在你工作时发来了这条消息：";
const AFTER = "这是在当前任务进行中说的，不是新开的一轮对话。先据此调整并回应它；除非它要你停下或改做别的，回应之后接着把原来的任务做完。";
const BEFORE_INTERRUPT = "（打断）用户在你工作时发来了这条消息，并让你停下了手上的事：";
const AFTER_INTERRUPT =
	"你的上一条回复因此停在了半截，当时还在跑的工具也已被取消。照这条消息的意思办：它要你接着做，就从停下的地方接着做；它说了别的，就改做它说的。";

function saidWhileWorking(message: Message): message is UserMessage {
	return message.role === "user" && (message.steered === true || message.interrupting === true) && !message.synthetic;
}

export function withSteeringNote(messages: Message[]): Message[] {
	if (!messages.some(saidWhileWorking)) return messages;
	return messages.map((message) => {
		if (!saidWhileWorking(message)) return message;
		// 两样都有的（停完之后又被别的一轮当插话收了进去）按打断说：上一条回复确实是被它停下的。
		const [before, after] = message.interrupting ? [BEFORE_INTERRUPT, AFTER_INTERRUPT] : [BEFORE, AFTER];
		return { ...message, content: [{ type: "text", text: before }, ...message.content, { type: "text", text: after }] };
	});
}
