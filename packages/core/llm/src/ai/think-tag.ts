/**
 * 写在 content 里的 `<think>…</think>`，流式切成思考。
 *
 * 单独一个文件，因为它是这条链上唯一一段**跨 chunk 带状态**的文本切分；其余的入站判断都是一帧看一帧的
 * 纯函数，在 `chat-delta.ts`。
 */

/**
 * 内联 `<think>` 切出来的思考块记在 `reasoningField` 上的标记。
 *
 * 它不是一个字段名：回放时编码那边见到它，就把思考按原样包回 `<think>…</think>` 放在正文前面（见
 * `openai-chat-completions-request.ts`）。MiniMax M2 的文档要求多轮里把带 `<think>` 的整段回答原样带回，
 * 拆成 `reasoning_content` 发回去它不认。
 */
export const THINK_TAG_FIELD = "<think>";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/** 切出来的一段：思考还是正文。 */
interface ThinkSegment {
	kind: "thinking" | "text";
	text: string;
}

/**
 * 把正文开头的 `<think>…</think>` 切成思考。
 *
 * 没开 reasoning parser 的 Ollama / vLLM 上的 Qwen3、R1，和默认配置的 MiniMax M2，都把推理写在 content 里。
 * 从前它们原样进正文：用户看见一大段思考，只有思考没有结论的一轮也不会被当成「没有回答」。
 *
 * 只认**正文最开头**（允许前导空白）的那个 `<think>`。正文中间出现的是模型在讨论这个标签，切了就是吞掉
 * 回答。标签会被 SSE 切开（`<thi` / `nk>`），所以开头那几个字和结尾那几个字要扣着等下一个 chunk。
 */
export class ThinkTagSplitter {
	/** 还没看到正文的第一个字 → 在 `<think>` 里 → 刚出 `</think>`、吃掉它后面的空行 → 正文。 */
	private state: "start" | "inside" | "after" | "text" = "start";
	private held = "";

	push(chunk: string): ThinkSegment[] {
		if (!chunk) return [];
		if (this.state === "text") return [{ kind: "text", text: chunk }];
		const out: ThinkSegment[] = [];
		let rest = chunk;
		if (this.state === "start") {
			const buffered = this.held + rest;
			const trimmed = buffered.trimStart();
			if (trimmed.startsWith(OPEN_TAG)) {
				this.state = "inside";
				this.held = "";
				rest = trimmed.slice(OPEN_TAG.length);
			} else if (OPEN_TAG.startsWith(trimmed)) {
				// 还看不出来：可能是 `<thi`，也可能只是几个空白。
				this.held = buffered;
				return out;
			} else {
				this.state = "text";
				this.held = "";
				return [{ kind: "text", text: buffered }];
			}
		}
		if (this.state === "inside") {
			const buffered = this.held + rest;
			const close = buffered.indexOf(CLOSE_TAG);
			if (close === -1) {
				const keep = partialSuffix(buffered, CLOSE_TAG);
				this.held = buffered.slice(buffered.length - keep);
				const thinking = buffered.slice(0, buffered.length - keep);
				if (thinking) out.push({ kind: "thinking", text: thinking });
				return out;
			}
			this.held = "";
			if (close > 0) out.push({ kind: "thinking", text: buffered.slice(0, close) });
			this.state = "after";
			rest = buffered.slice(close + CLOSE_TAG.length);
		}
		if (this.state === "after") {
			// `</think>` 后面跟着的空行是分隔，不是回答的一部分；留着会让回答从两行空白开始。
			rest = rest.trimStart();
			if (!rest) return out;
			this.state = "text";
		}
		out.push({ kind: "text", text: rest });
		return out;
	}

	/** 流结束：扣着的那一截按它所在的位置交出去。没闭合的 `<think>` 里的全是思考。 */
	end(): ThinkSegment[] {
		const held = this.held;
		this.held = "";
		if (!held) return [];
		return [{ kind: this.state === "inside" ? "thinking" : "text", text: held }];
	}
}

/** `text` 结尾有几个字可能是 `tag` 的开头。 */
function partialSuffix(text: string, tag: string): number {
	for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
		if (text.endsWith(tag.slice(0, length))) return length;
	}
	return 0;
}
