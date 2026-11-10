/**
 * 转录末尾变了它才变的一个值。
 *
 * `useFollowBottom` 要回答「到底有没有新东西来」，而比较数组答不了：打开一个会话时 React 会拿到
 * 两遍同样的消息——一遍来自缓存，一遍是磁盘读完落地——两个数组是不同的对象、内容完全一样。按引用
 * 判断的未读标记把第二遍当成了新内容，于是一个谁都没往里加过东西的会话，一打开就是「有新内容」。
 *
 * 所以改问内容。两个数就够：有几条消息，最后一条多大。正在写的回复条数不变、大小在长；一条回复
 * 写完、下一条开始，条数变了。从磁盘重读的转录两个都不变。
 */

import type { Message } from "@plume/contract";

/**
 * 一条消息已经有多少，用随便哪种便宜又只增不减的单位。
 *
 * 正文和推理按长度算，因为它们是一个 token 一个 token 长的。其余都算一：工具调用要么有要么没有，
 * 参数在它显示出来之前就到齐了。
 */
function sizeOf(message: Message): number {
	switch (message.role) {
		case "user":
			return message.content.length;
		case "assistant":
			return message.content.reduce((total, block) => {
				if (block.type === "text") return total + block.text.length;
				if (block.type === "thinking") return total + block.thinking.length;
				return total + 1;
			}, 0);
		default:
			return 0;
	}
}

/**
 * 转录尾部的签名。
 *
 * `extra` 带上消息列表之外、同样算作新内容到来的东西——有几次工具运行、几次已经落定，委派的最终
 * 报告——因为它们不碰任何消息也会改变屏幕上的内容。
 *
 * 看两条而不是一条，这不是多此一举。调用了工具的回复，在工具结果落到它后面时仍是**进行中**的那条，
 * 而存储是原地更新它的：数组以 `[…, assistant(进行中), toolResult]` 结尾，真正在长的是倒数第二条。
 * 只问最后一条得到的是 `toolResult:<固定时间戳>:0`——只要那条回复还在继续，签名就一直冻着——而签名
 * 冻住，跟随底部的那个布局副作用就永远不跑。多看一条不花什么：两条消息本来就在手上，也没有哪个
 * 转录会同时有第三条在变。
 */
export function tailSignature(messages: readonly Message[], extra: string | number = ""): string {
	const last = messages[messages.length - 1];
	if (!last) return `-:${extra}`;
	const behind = messages[messages.length - 2];
	return `${last.role}:${last.timestamp}:${sizeOf(last)}:${behind ? `${behind.role}:${sizeOf(behind)}` : "-"}:${extra}`;
}
