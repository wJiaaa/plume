/**
 * 测试和冒烟共用的假 Anthropic Messages 服务。数组按请求次序回复，超出重复最后一条；函数按请求内容路由并发会话。
 * 每次请求的请求体都记下来，用来检查模型实际收到了什么（系统提示词、工具列表、工具结果）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeReply {
	text?: string;
	/** 将工具参数分块并延时发送，供真实界面验证流式草稿。 */
	stream?: { chunkSize: number; delayMs: number };
	toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
	/** 不回流，直接回这个 HTTP 状态码（比如 503、401）。 */
	status?: number;
	/** 写完内容不收尾，一直挂着，直到客户端断开：用来在流到一半时按停止。 */
	hang?: boolean;
	/** 撞上输出上限：stop_reason 是 max_tokens。 */
	truncated?: boolean;
	/** 报的缓存读写 token，加在按请求体估的输入之外。 */
	cache?: { read?: number; write?: number };
}

export interface FakeModel {
	url: string;
	/** 收到的请求体，按顺序。 */
	readonly requests: Array<Record<string, unknown>>;
	close(): Promise<void>;
}

export async function fakeAnthropic(replies: FakeReply[] | ((request: Record<string, unknown>, index: number) => FakeReply)): Promise<FakeModel> {
	const requests: Array<Record<string, unknown>> = [];
	const frame = (type: string, rest: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;

	const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
		// 新窗口也会探测模型列表；假服务只实现 Messages，不把 GET 当成模型调用解析。
		if (request.method !== "POST") {
			response.writeHead(404).end();
			return;
		}
		// 整段收齐再解码：一个汉字的几个字节可能落在两块里，逐块转成字符串会把它拆成乱码。
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString("utf8");
		requests.push(JSON.parse(raw) as Record<string, unknown>);
		const reply =
			typeof replies === "function"
				? replies(requests[requests.length - 1]!, requests.length - 1)
				: (replies[Math.min(requests.length, replies.length) - 1] ?? { text: "" });
		const calls = reply.toolCalls ?? [];
		if (reply.status) {
			response.writeHead(reply.status, { "content-type": "application/json" });
			response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `fake ${reply.status}` } }));
			return;
		}

		const frames = [
			frame("message_start", {
				message: {
					id: `msg_${requests.length}`,
					usage: {
						input_tokens: Math.ceil(raw.length / 3.5),
						output_tokens: 1,
						...(reply.cache ? { cache_read_input_tokens: reply.cache.read ?? 0, cache_creation_input_tokens: reply.cache.write ?? 0 } : {}),
					},
				},
			}),
		];
		let index = 0;
		if (reply.text) {
			frames.push(
				frame("content_block_start", { index, content_block: { type: "text", text: "" } }),
				frame("content_block_delta", { index, delta: { type: "text_delta", text: reply.text } }),
				frame("content_block_stop", { index }),
			);
			index++;
		}
		for (const call of calls) {
			frames.push(frame("content_block_start", { index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } }));
			const args = JSON.stringify(call.args);
			const size = Math.max(1, reply.stream?.chunkSize ?? args.length);
			for (let at = 0; at < args.length; at += size)
				frames.push(frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: args.slice(at, at + size) } }));
			frames.push(frame("content_block_stop", { index }));
			index++;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (reply.hang) {
			response.write(frames.join(""));
			return;
		}
		const stop = reply.truncated ? "max_tokens" : calls.length > 0 ? "tool_use" : "end_turn";
		frames.push(frame("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: 10 } }), frame("message_stop"));
		if (reply.stream) {
			for (const chunk of frames) {
				if (response.destroyed) return;
				response.write(chunk);
				await new Promise((resolve) => setTimeout(resolve, reply.stream!.delayMs));
			}
			response.end();
		} else response.end(frames.join(""));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
				// 挂着的流（`hang`）不会自己断，不掐掉 close 永远等不到。
				server.closeAllConnections();
			}),
	};
}
