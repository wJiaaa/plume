/**
 * 今天是几号：跟在它所属的那条用户消息后面，不放系统提示词里，也不接在请求最末尾。
 *
 * 不放系统提示词：服务商的前缀缓存从最前面逐段匹配，里面有一个每天变一次的字符串，每天头一次请求整段对话都用不上缓存。
 * 不接在最末尾：那样它永远是「最后一条用户消息」，交错思考的模型会丢掉最后一条用户消息之前所有助手轮的推理，
 * 上一轮写出的正文和工具参数全按未缓存重付。
 *
 * 所以日期取那条用户消息自己的时间戳：第一条真人消息后面一定有，之后只在日期变了的那条后面再出现。同一份历史每次
 * 渲染出一模一样的字节，跨天也不改动已有的前缀。它在组请求时产生，不存进会话：渲染是确定的，不用存。
 */

import type { Message } from "@plume/contract";

/** 今天，按本地时区。模型的训练截止日期不是今天，这是它唯一的来源。 */
function today(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 在每个新日期的第一条真人消息后面接上环境信息。
 *
 * 用 `<env>` 包起来并说明它是什么：它在结构上是一条用户消息，不说清楚，模型会把它当成刚收到的指令。标 `synthetic`：
 * 它不是人说的。没有一条真人消息的历史（压缩后只剩摘要）接在第一条用户消息后面，模型照样知道今天几号。
 */
export function withEnvironment(messages: Message[]): Message[] {
	const humans = messages.filter((m) => m.role === "user" && !m.synthetic);
	const anchors = new Set<Message>(humans.length > 0 ? humans : messages.filter((m) => m.role === "user").slice(0, 1));
	const out: Message[] = [];
	let shown: string | undefined;
	for (const message of messages) {
		out.push(message);
		if (!anchors.has(message)) continue;
		const date = today(Number.isFinite(message.timestamp) && message.timestamp > 0 ? new Date(message.timestamp) : new Date());
		if (date === shown) continue;
		shown = date;
		out.push({
			role: "user",
			// i18n-exempt：发给模型的环境信息，不随界面语言变。
			content: [{ type: "text", text: `<env>\n今天是 ${date}。这是环境信息，不是用户的请求。\n</env>` }],
			timestamp: message.timestamp,
			synthetic: true,
		});
	}
	return out;
}
