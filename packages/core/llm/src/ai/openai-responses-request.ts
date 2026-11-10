/**
 * Our messages, in the shape the Responses API wants.
 *
 * Purely a translation: no network, no state, no decisions beyond how each kind of content maps.
 * Separated from the streaming half because the two are read for different reasons — this one when
 * a message is not being sent correctly, the other when a reply is not being read correctly.
 */

import type { AssistantMessage, Message, ToolResultMessage, ToolSpec } from "../types.ts";
import { replayArguments } from "./openai-chat-completions-request.ts";
import type { ReasoningReplay } from "./reasoning-compat.ts";
import type { ToolPairing } from "./tool-pairing-compat.ts";
import type { ToolResultImages } from "./tool-result-images-compat.ts";
import { toolNameForReplay } from "./tool-names.ts";
import { hoistLocalRefs } from "./tool-schema.ts";

/**
 * Who this request is going to, so a handle from someone else can be told apart from our own.
 *
 * Every assistant message records the provider and model that produced it. A reasoning item id is
 * that provider's private handle on its own chain of thought — it means nothing to anyone else, and
 * is rejected rather than ignored when replayed to them.
 */
export interface ResponsesHome {
	provider: string;
	model: string;
	/**
	 * 这个模型收不收图片。省略按「收」算。
	 *
	 * 省略等于收，是因为老会话和大部分调用点并不知道这件事，而把「不知道」当成「不收」会把图片从本来好好
	 * 的请求里抹掉。反过来错的代价小：多发一张图给不收图的端点会被拒，而那正是下面要防的；漏判只是维持
	 * 现状。
	 */
	supportsImages?: boolean;
	/** Where a tool result's image goes; see `tool-result-images-compat.ts`. Omitted means inline. */
	toolImages?: ToolResultImages;
	/**
	 * 这个端点要不要每个助手轮都以推理项开头（没有就补一个合成的，见 `toResponsesInput` 的补位分支）。
	 * 省略按「要」算。
	 *
	 * 省略等于要，理由同 `supportsImages`：不知道的调用点维持原来的形状。适配器知道发往哪里，由它说
	 * 「不要」——补出来的那一项在官方 OpenAI 上是一次必然的 400（`maximum length 0`）。
	 */
	leadingReasoning?: boolean;
}

/**
 * Whether this turn was written by the model the request is going to.
 *
 * No `home` counts as ours: dropping a handle we cannot prove is foreign would break the upstreams
 * that require their own reasoning back (see the `reasoning_text` note below).
 */
function fromHome(message: AssistantMessage, home: ResponsesHome | undefined): boolean {
	if (!home) return true;
	return message.provider === home.provider && message.model === home.model;
}

/**
 * One tool result, in the shape Responses wants.
 *
 * `output` is a string or a list of `input_text` / `input_image` parts; images go as parts so a
 * vision model sees what the tool saw. Text-only results stay a string — the shape every endpoint
 * has always accepted — and a model that cannot read images gets the same line the user branch uses.
 *
 * Given `lifted`, the images are collected there instead, for a user message after the results
 * (`liftedImages`); the output keeps a marker in each image's place.
 */
function functionCallOutput(message: ToolResultMessage, blind: boolean, lifted?: unknown[]): unknown {
	const hasImages = message.content.some((c) => c.type === "image");
	if (!hasImages || blind || lifted) {
		const text = message.content
			.map((c) => {
				if (c.type === "text") return c.text;
				if (blind || !lifted) return blindImage(c.mimeType, c.data.length);
				lifted.push({ type: "input_image", image_url: `data:${c.mimeType};base64,${c.data}` });
				return `[image ${c.mimeType}: attached in the next message]`;
			})
			.join("\n");
		return { type: "function_call_output", call_id: message.toolCallId, output: text };
	}
	const output = message.content.map((c) =>
		c.type === "text" ? { type: "input_text", text: c.text } : { type: "input_image", image_url: `data:${c.mimeType};base64,${c.data}` },
	);
	return { type: "function_call_output", call_id: message.toolCallId, output };
}

function blindImage(mimeType: string, length: number): string {
	return `[图片未发送：这个模型不支持读图（${mimeType}，${length} base64 字符）]`;
}

/** The images `functionCallOutput` set aside, as one user message — or nothing. Empties `lifted`. */
function liftedImages(lifted: unknown[] | undefined): unknown[] {
	if (!lifted || lifted.length === 0) return [];
	const images = lifted.splice(0);
	return [{ type: "message", role: "user", content: [{ type: "input_text", text: "Image(s) returned by the tool results above:" }, ...images] }];
}

/**
 * 一个句柄能不能当 API 的 item id 用。
 *
 * Responses 只接受字母、数字、下划线和短横。中转自己生成的 id 不一定守这条——客户报过一次
 * `Invalid 'input[14].id' … this value contained additional characters`，而那串东西里混着一个
 * 肉眼看不出来的字符。
 *
 * 不合规的句柄**丢掉**，不是原样发出去：它按定义就是不可用的，发过去只有一个结果——整个请求被拒，
 * 而那段历史每一轮都会被重新编码一次，于是那个对话再也说不了话。丢掉它只损失「供应商接回自己那条
 * 思维链」的能力，那本来就不是可移植的东西。
 */
function usableId(handle: string | undefined): string | undefined {
	return handle !== undefined && /^[A-Za-z0-9_-]+$/.test(handle) ? handle : undefined;
}

/**
 * 被打断的那一轮里没写完的推理块：最后一块，而且它是推理。
 *
 * 推理项的 id 在 `output_item.added` 时就记下了，`encrypted_content` 要到 `output_item.done` 才来。中途按停止
 * 或者断流，留在历史里的就是一个有 id、没密文的块；`store: false` 下回放这个 id，OpenAI 回
 * `Item with id 'rs_…' not found`，而且之后每一轮都是这句——会话就此报废。带着摘要文本的话还会多一样：
 * `content` 在官方端点上只能是空的，`maximum length 0` 让推理梯子一路往下退，整个进程里这个模型都受牵连。
 *
 * 认「最后一块」而不是认「没有密文」：没有密文的块也可能是写完了的（中转只给签名不给密文，那正是
 * 下面 `content` 分支要服务的），而被打断时还在写的只可能是最后那一块。前面已经写完的推理照常回放。
 * 同 `anthropic-messages-request.ts` 的 `untrustedSignatures`。
 */
function unfinishedReasoning(message: AssistantMessage): unknown {
	if (message.stopReason !== "aborted" && message.stopReason !== "error") return undefined;
	const last = message.content[message.content.length - 1];
	return last?.type === "thinking" ? last : undefined;
}

/**
 * 历史以助手的话收尾时补的那一句。
 *
 * 写成一句明确的指令而不是空串或标点：它会进模型的上下文，而模型读到一句说得通的话比读到一个孤零零的
 * 点更不容易被带偏。措辞只说「接着做」，不描述任何具体任务——这里不知道上面那段历史是在做什么。
 */
const CONTINUE_FROM_HERE = "（自动追加）接着上面的进度继续。";

/**
 * 助手轮缺推理项时补上的那一句，理由见下面 `toResponsesInput` 里的补位分支。
 *
 * 只陈述「这一轮没有推理记录」这件事，不替它编一段想法：这段文本会进模型的上下文，而一段伪造的思考
 * 比一个空位更能把它带偏。
 */
const SYNTHETIC_REASONING = "（自动追加）这一轮没有留下推理记录。";

/**
 * 一轮里的多个工具调用怎么排：成组（所有调用，然后所有结果）还是交错（一问一答）。
 *
 * 两家要求相反，见 `tool-pairing-compat.ts`。这里只负责按给定的那一档编码，选哪一档是那边的事。
 *
 * 这段原本写死交错，理由是把 Responses 翻译成 Chat Completions 的中转需要它——那个理由是真的，错的是
 * 把它当成了**普适**的形状：
 *
 *     an assistant message with 'tool_calls' must be followed by tool messages responding to
 *     each 'tool_call_id'. The following tool_call_ids did not have response messages: bash:0
 *
 * 代价是 2026-09-11 的两个报废会话。`api.deepseek.com` 的 Responses 要成组，交错排一律 400，而它报的是
 * `The reasoning_text in the thinking mode must be passed back to the API.`——一句跟工具无关的话。真实端点
 * 上二分过：一对调用/结果 200，第二对一加就 400；改成成组之后，推理项发不发、带不带文本，全都 200。
 *
 * 不管哪一档，这里都保证结果按**调用顺序**排，而不是按完成顺序。结果是各个工具跑完的时候记下来的，从日志
 * 重建的历史里它们按完成先后躺着；在这里配对意味着发出去的形状不取决于哪个工具更快。
 *
 * 一条结果如果在它前面的助手消息里找不到对应的调用——日志被截断、有人编辑掉了那次调用——保留在原位，不
 * 丢弃：它是历史，而凭空造一个调用去挂住它比原样传过去更糟。
 */
export function toResponsesInput(
	messages: Message[],
	home?: ResponsesHome,
	reasoning: ReasoningReplay = "replay",
	pairing: ToolPairing = "grouped",
): unknown[] {
	const input: unknown[] = [];
	/** 这个模型读不了图——见 `ResponsesHome.supportsImages`，不知道时按「能读」算。 */
	const blind = home?.supportsImages === false;
	/** Set when this endpoint refused images inside a tool result; see `ResponsesHome.toolImages`. */
	const lifted = home?.toolImages === "lifted" && !blind ? [] : undefined;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "user") {
			input.push({
				type: "message",
				role: "user",
				content: message.content.map((c) =>
					c.type === "text"
						? { type: "input_text", text: c.text }
						: blind
							? /*
								 * 这个模型不收图片：换成一行说明，而不是把图片发过去。
								 *
								 * 不是可选的礼貌，是会话存亡问题。图片不一定是用户贴的——`read` 工具读一个
								 * png 就会返回图片块，而那条 tool_result 会留在历史里，于是**之后每一轮**都
								 * 带着它，每一轮都被拒。一次误读能让整个会话再也说不了话。
								 *
								 * 说明里带上格式和大小，模型至少知道这里本来有个东西、以及它为什么看不到。
								 */
								{ type: "input_text", text: blindImage(c.mimeType, c.data.length) }
							: {
									type: "input_image",
									image_url: `data:${c.mimeType};base64,${c.data}`,
								},
				),
			});
			continue;
		}

		if (message.role === "assistant") {
			/*
			 * The results answering this turn: the run of tool messages directly after it.
			 *
			 * Bounded by the run rather than searched for across the whole history, because a call id
			 * is only unique within the provider that issued it — relays that name calls after the
			 * tool (`bash:0`) repeat themselves every turn, and a lookup by id alone would answer this
			 * turn's call with a result from three turns ago.
			 */
			const answers = new Map<string, ToolResultMessage>();
			let after = index + 1;
			for (; after < messages.length; after++) {
				const next = messages[after];
				if (next.role !== "toolResult") break;
				// First one wins, so a repeated id leaves the later copy where it was rather than
				// silently replacing the answer this call already had.
				if (!answers.has(next.toolCallId)) answers.set(next.toolCallId, next);
			}
			const paired = new Set<ToolResultMessage>();
			/** 成组档里攒下的结果，等这一轮的调用全排完再一起放。交错档下始终为空。 */
			const grouped: unknown[] = [];
			const own = fromHome(message, home);
			/** 这一轮的项从哪儿开始——轮排完之后要回头看它有没有以推理项开头。 */
			const turnAt = input.length;
			const unfinished = unfinishedReasoning(message);

			for (const c of message.content) {
				if (c.type === "thinking") {
					/*
					 * 这个端点已经说过它不收推理项——那就一个都不发。
					 *
					 * 不是形状不对，是它那边根本没有能放下这个东西的位置：四种写法（带 id、带 content、
					 * 带 summary、两个都带）全试过，全 400；删掉整项之后，同一段工具历史照样 200。
					 * 这个结论是撞出来的，怎么撞的见 `reasoning-compat.ts`。
					 */
					if (reasoning === "omit") continue;
					// 被打断时还没写完的那一块，整块不发，见 `unfinishedReasoning`。
					if (c === unfinished) continue;
					/*
					 * Someone else's reasoning does not go back at all.
					 *
					 * Not the id — the whole block. The id is unusable by definition, and the text is a
					 * different model's chain of thought, which this one has no business resuming. Both
					 * halves used to go anyway, and both were rejected: the id as
					 * `Invalid 'input[14].id' … invalid_value`, and the text — once the id had been
					 * stripped for being stale — as
					 * `Invalid 'input[32].content': array too long. Expected an array with maximum
					 * length 0`, because a reasoning item may only carry `content` on the endpoint that
					 * wrote it. Neither is retryable: the history is the request, so every turn after a
					 * model change failed the same way and the conversation could not be continued at
					 * all.
					 *
					 * The transcript still holds the text and still shows it; this is only about what
					 * crosses the wire. The Anthropic encoder has always done exactly this with a
					 * thinking block it cannot replay.
					 */
					if (!own) continue;
					/*
					 * With the provider's own item id, replayed exactly as it arrived. That id is what
					 * lets the provider pick its own chain of thought back up, and a summary offered in
					 * its place is not accepted as a substitute for it.
					 */
					const handle = usableId(c.signature);
					if (handle) {
						/*
						 * 只有 id、既没密文也没文本的不发。
						 *
						 * 上面说 id 是供应商接回自己思维链的那个句柄——那要它那边存着东西。我们发的是 `store: false`，
						 * 没有密文时这个 id 什么也指不到，OpenAI 回 `Item with id 'rs_…' not found`，每一轮都是。
						 * 它出现在模型推理了而请求里没要密文的时候：`supportsThinking: false` 却是推理模型、学到
						 * `reasoning-off` 后模型按默认档推理、学到 `include-encrypted`（且没有摘要）。没有文本，
						 * 下面那条「只给签名的中转要 `content`」的路也用不上——两样都没有，发它换不来任何东西。
						 */
						if (!c.encrypted && !c.thinking) continue;
						input.push({
							type: "reasoning",
							id: handle,
							summary: c.thinking ? [{ type: "summary_text", text: c.thinking }] : [],
							...(c.encrypted ? { encrypted_content: c.encrypted } : {}),
							/*
							 * 没有密文时，思考本身也要进 `content`。
							 *
							 * 一个推理项能拿回去的东西有三样：item id（供应商自己的句柄）、`encrypted_content`
							 * （原样可回放的那份）、和 `content` 里的 `reasoning_text`（文本本身）。`summary`
							 * 不算——它按定义是**对**推理的概括，要求原样回放的上游不接受它顶替：
							 *
							 *     The `reasoning_text` in the thinking mode must be passed back to the API.
							 *
							 * 有密文的时候端点认密文，这条分支就不发文本；上游只给签名不给密文时（中转把
							 * Responses 转译成别的协议时很常见）才发。
							 *
							 * 「有密文就够了」有一处已知的例外，写在这里免得下一个人重走一遍：`api.deepseek.com`
							 * 回的 `encrypted_content` 是 38 个字符的 `{uuid}-0`，全部日志里 194 个块一个不差都是
							 * 这个长度，而边上的思考最长 17178 字——它是个指向服务端自己那份的引用，不是载荷
							 * （对照：Claude 和 Grok 的密文长度随推理长度走，204 到 12659 不等）。前缀缓存一冷，
							 * 那个引用就什么也指不到，模型接不回自己那条思维链。
							 *
							 * **但那不是上面那句 400 的原因。** 这一点在真实端点上分离过：同一份被拒的请求，
							 * 推理项带上 `content.reasoning_text` 和不带，两种都是 400；真正的原因是助手轮没有
							 * 以推理项开头（见下面的补位分支）。所以这里维持不发——补发一份等于
							 * 把每段推理在请求里放两遍（`summary` 已经有一份），长会话上是实打实的钱，而换回来
							 * 的好处一个都没被证实过。要改它，先拿出「模型接得回思维链」的量法，别拿那句 400。
							 */
							...(!c.encrypted && c.thinking ? { content: [{ type: "reasoning_text", text: c.thinking }] } : {}),
						});
						continue;
					}
					/*
					 * No id — and the block still has to go back.
					 *
					 * This used to `continue`, on the reasoning that a reasoning item without the
					 * provider's handle cannot be replayed. True of OpenAI's own endpoint, which always
					 * names its items, so the branch never fired there. It fires on the relays that
					 * translate Responses into Chat Completions, and several of them stream reasoning
					 * without ever sending an `item.id` — dropping the block there does not degrade the
					 * request, it breaks it outright:
					 *
					 *     The `reasoning_text` in the thinking mode must be passed back to the API.
					 *
					 * Upstreams like DeepSeek require the thinking they produced to come back with the
					 * turn that followed it. With the block dropped there is nothing to send, so every
					 * turn after the first fails with a 400 that no retry can clear, and the only way
					 * out was to turn thinking off.
					 *
					 * So the text goes back without an id, as `reasoning_text` — `content` is where the
					 * model's actual reasoning lives (`summary` is a summary of it, which is not what is
					 * being asked for). Nothing is claimed about resuming a chain of thought; this is
					 * the transcript, in the field that holds it.
					 */
					if (!c.thinking && !c.encrypted) continue;
					/*
					 * 这个端点说过它只收带得动句柄的推理——这一块没有句柄，跳过。
					 *
					 * 中转把 Responses 翻译成 Anthropic 时会撞上这条：那边的 thinking 块要文本也要签名，
					 * 而换过模型之后 `stripStaleHandles` 把签名剥了，两样都拿不出来。发过去只会 400，
					 * 而且是 `signature: Field required` 和 `thinking: Field required` 轮流报——补哪个都
					 * 补不齐，因为缺的那样东西我们真的没有。
					 */
					if (reasoning === "handled") continue;
					input.push({
						type: "reasoning",
						/*
						 * `summary` 也给一份。
						 *
						 * 这里原本是空数组，只往 `content` 里放。两个字段读起来像是同一句话的两种说法，实际
						 * 哪个被读走取决于对面：要求原样回放的上游读 `content`（`summary` 是概括，顶不了），
						 * 而把 Responses 翻译成别的协议的中转往往只认 `summary`——只给 `content` 时它翻译出来
						 * 的是一个没有文本的思考块，报 `thinking.thinking: Field required`。
						 *
						 * 两个都给不会被拒（实测过），那就都给。
						 */
						summary: c.thinking ? [{ type: "summary_text", text: c.thinking }] : [],
						...(c.thinking ? { content: [{ type: "reasoning_text", text: c.thinking }] } : {}),
						...(c.encrypted ? { encrypted_content: c.encrypted } : {}),
					});
				} else if (c.type === "text") {
					if (!c.text) continue;
					/*
					 * No `id`, deliberately.
					 *
					 * The provider's own item id was replayed here, and it bought nothing: on an input
					 * item of type `message` the id is optional, exists only to reference an item the
					 * provider is storing, and we store our own sessions (`store: false`). What it cost
					 * was every request that reached a different endpoint than the one that issued it —
					 * a relay routed to another upstream, a model changed mid-conversation — coming back
					 * as `Invalid 'input[14].id' … Expected an ID that contains letters, numbers,
					 * underscores, or dashes`. The text is what matters and the text is all that goes.
					 */
					input.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: c.text }],
						// 不带的话，模型分不清自己哪句是播报、哪句是答复。
						...(c.phase ? { phase: c.phase } : {}),
					});
				} else {
					input.push({
						type: "function_call",
						call_id: c.id,
						name: toolNameForReplay(c.name),
						arguments: replayArguments(c),
					});
					const answer = answers.get(c.id);
					if (!answer) continue;
					paired.add(answer);
					// 交错：结果紧跟着它自己的调用。成组：先攒着，这一轮的调用全排完再一起放。
					if (pairing === "interleaved") input.push(functionCallOutput(answer, blind, lifted));
					else grouped.push(functionCallOutput(answer, blind, lifted));
				}
			}

			/*
			 * 这一轮一个推理项都没有——补一个，否则 `api.deepseek.com` 会把整个请求拒掉。
			 *
			 * 它在思考模式下要求**每个助手轮由一个推理项开头**，而它对这条的违反只有一句话可说：
			 *
			 *     The `reasoning_text` in the thinking mode must be passed back to the API.
			 *
			 * 一句听起来在讲某个字段、实际在讲位置的话。2026-09-15 在真实端点上分离过（历史取自被它报废的那个会话压缩后的 18 条）：
			 *
			 *     原样（助手轮前面没有推理项）                    400
			 *     在那条助手消息前插一个合成推理项                200
			 *     把那条助手消息的角色换成 user                   200
			 *     把那条助手消息整个删掉                          200
			 *     推理项带不带 `content.reasoning_text`           两种都 400 —— 跟这个字段无关
			 *
			 * 最后一行是这条注释存在的理由：错误原文点名的那个字段，加上或去掉都不改变结果。
			 *
			 * 补在编码这一层，不是补在压缩那一层。压缩那条合成的助手确认消息（`runtime/compaction/compaction.ts` 的
			 * `summaryMessages`）只是第一个撞上来的，产生「没有推理的助手轮」的路子还有好几条：换模型之后
			 * 别人的推理被整块丢掉、`reasoning` 退到 `handled` 档而这一轮的块没有句柄、以及模型自己想都没想
			 * 就直接答了。堵住其中一个出口，剩下的照样能让一个会话再也说不了话。
			 *
			 * 只在顶格（`replay`）补。`omit` 那档的端点一个推理项都不收，`handled` 那档只收带得动句柄的，
			 * 而补出来的这个两样都不是——在那两档补等于拿一个必被拒的请求去换另一个。
			 *
			 * 也只在要它的端点上补（`home.leadingReasoning`）。这条原来是全局默认，官方 OpenAI 为此每个进程、
			 * 每个模型都先吃一次 `maximum length 0` 的 400，退一格再重发；不认得这种项的端点换个说法拒，就直接
			 * 判死。补位是 DeepSeek 一家的规矩，不该让所有端点替它付钱——哪些端点要，由适配器判断。
			 *
			 * 文本是合成的，而且说明了自己是合成的。它会进模型的上下文，所以只说「这一轮没有留下推理记录」
			 * 这件事实，不替它编一段想法——凭空写一段“它当时在想什么”，比缺这一项更糟。
			 */
			if (reasoning === "replay" && home?.leadingReasoning !== false && input.length > turnAt && !input.slice(turnAt).some((item) => (item as { type?: string }).type === "reasoning")) {
				input.splice(turnAt, 0, {
					type: "reasoning",
					summary: [],
					content: [{ type: "reasoning_text", text: SYNTHETIC_REASONING }],
				});
			}

			input.push(...grouped);

			// Anything in that run which answered no call here, in the order it was recorded.
			for (let at = index + 1; at < after; at++) {
				const result = messages[at] as ToolResultMessage;
				if (!paired.has(result)) input.push(functionCallOutput(result, blind, lifted));
			}
			input.push(...liftedImages(lifted));
			index = after - 1;
			continue;
		}

		// A result with no assistant message before it — the head of a truncated history.
		input.push(functionCallOutput(message, blind, lifted), ...liftedImages(lifted));
	}

	/*
	 * 最后一项不能是助手说的话。
	 *
	 * `api.deepseek.com` 的 Responses 拒收这种 input，而且报的还是那句
	 * `The reasoning_text in the thinking mode must be passed back to the API.`——跟推理没有半点关系。
	 * 实测（2026-09-11）：同一段历史，原样发 400；只把末尾那条助手消息去掉，200；末尾补一条 user，200；
	 * **只有 user + assistant 两项也照样 400**，所以跟历史长短、跟推理项都无关，就是这个形状本身。
	 *
	 * 语义上它也确实是另一回事：以助手消息收尾的 input 是在说「接着这句往下写」，而我们每一次请求要的都是
	 * 新的一轮。这两件事在别的端点上可能都收，在这里只收后者。
	 *
	 * **这是防御性的**：把生产日志翻过，这个形状目前没有真的发出去过（子 Agent 的收尾路径
	 * `runtime/sub-agent/sub-agent-run.ts` 的 `finalDemand()`、压缩路径 `runtime/compaction/compaction.ts` 的 summarize 都已经各自
	 * 追加了一条 user 消息）。留这道闸是因为它的失败方式太隐蔽：报出来的是一句指向推理的话，谁看都不会
	 * 想到是末项的角色不对——这一天已经为同一句谎话付过两次代价了。
	 */
	const last = input[input.length - 1] as { type?: string; role?: string } | undefined;
	if (last?.type === "message" && last.role === "assistant") {
		input.push({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: CONTINUE_FROM_HERE }],
		});
	}

	return input;
}

export function toResponsesTools(tools: ToolSpec[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: hoistLocalRefs(tool.parameters),
		strict: false,
	}));
}
