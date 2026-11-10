/**
 * 一次请求：把模型的流变成一条落定的回复，流式草稿推给界面，重试说出来。
 *
 * 和循环分开，因为它回答的是另一个问题：循环决定还要不要再来一步，这里只管一个请求怎么收场。
 */

import { streamAssistant } from "@plume/llm";
import type { AssistantMessage, LlmContext, ModelConfig, ProviderConfig, RequestOptions } from "@plume/llm/types";
import type { RetryInfo, RetrySettled } from "./hiccups.ts";

/** 草稿快照最快多久推一次：每个 token 都推的话，长回复会把整条消息来回复制几千遍。 */
const DRAFT_INTERVAL_MS = 50;

export interface StreamTurn {
	provider: ProviderConfig;
	model: ModelConfig;
	context: LlmContext;
	options: Omit<RequestOptions, "onRetry">;
	/**
	 * 写着的回复的快照。写完时不清：草稿留到这条回复以 message 事件落进会话，两者在界面上是同一次换手。
	 * 先清再落盘，中间那一帧整条回复不见，下一帧重新挂上，每一步收尾都闪一下。只有流抛错时在这里清。
	 */
	draft(partial: AssistantMessage | undefined): void;
	/** 每个事件的快照，不节流，用来边流边落盘：节流掉的那些字，流停在半路时就再没有下一次推送带上它们。undefined 表示流完了。 */
	keep(partial: AssistantMessage | undefined): void;
	/** 要重试了：重试期间界面没有一个字，不说出来就和卡住了分不清。 */
	retry(info: RetryInfo): void;
	/** 那次中断收场了。没重试过的成功不报；没重试过就失败的要报，否则界面不知道刚才发生了什么。 */
	settled(info: RetrySettled): void;
	/**
	 * 人换了模型时叫一声（带上新模型的名字），返回退订。这次请求还什么都没说（连接中、等重试）就放手，换成新模型从同一处重发；
	 * 已经在写的不动。换模型多半正是因为这边一直连不上，只在下一个请求起才换的话，人要一直等这次重试等到放弃。
	 */
	onSwitch?(listener: (to: Pick<ModelConfig, "id" | "name">) => void): () => void;
}

/** 这次请求因为换了模型放手了：什么都没写进会话，调用方用新模型重发。`reply` 是放手时那条停下的回复，只给诊断记账。 */
export interface Switched {
	switched: true;
	reply?: AssistantMessage;
}

export async function streamTurn(turn: StreamTurn): Promise<AssistantMessage | Switched> {
	/*
	 * 次数按「一次中断」数：发请求、保连接两层重试各自从 1 数，原样透传的话屏幕上会数成 1、2、1、1、2。
	 * 接上过（出了字）再断是新的一次，从 1 数起，否则第二次断线只重试了一回，屏幕上却说「重试 2 次后恢复」。
	 */
	let retries = 0;
	let base = 0;
	let pending = false;
	const attempts = () => retries - base;
	const settle = (message: AssistantMessage) => {
		const failed = message.stopReason === "error";
		if (!pending && !failed) return;
		pending = false;
		// 等重试时被人停下：既没接上也没放弃，说成「已恢复」是在报一件没发生的事。
		const outcome = failed ? "gave_up" : message.stopReason === "aborted" ? "stopped" : "recovered";
		turn.settled({ outcome, attempts: attempts(), ...(message.failure ? { failure: message.failure } : {}) });
	};

	/*
	 * 换模型有自己的控制器：它的意思是「换个人重来」，不是「停」，不能和调用方的停止信号混在一起。只放手还什么都没说的请求，
	 * 重试从头再来（上一次写出的那截不留），所以每次重试都回到「还没说」。
	 */
	const release = new AbortController();
	let said = false;
	let switchedTo: string | undefined;
	const unsubscribe = turn.onSwitch?.((to) => {
		if (said || to.id === turn.model.id) return;
		switchedTo = to.name;
		release.abort();
	});
	const stop = turn.options.signal;
	const switched = () => release.signal.aborted && !stop?.aborted;
	const stream = streamAssistant(turn.provider, turn.model, turn.context, {
		...turn.options,
		signal: stop ? AbortSignal.any([stop, release.signal]) : release.signal,
		onRetry: ({ delayMs, reason, failure }) => {
			if (!pending) base = retries;
			retries += 1;
			pending = true;
			said = false;
			turn.retry({ attempt: attempts(), delayMs, reason, ...(failure ? { failure } : {}) });
		},
	});
	/** 放手：写着的草稿撤掉，不留一条「停下了」的空回复（那读起来像人按了停）；等着的那次重试照实收场，说换了模型。 */
	const letGo = (reply?: AssistantMessage): Switched => {
		turn.draft(undefined);
		if (pending) {
			pending = false;
			turn.settled({ outcome: "switched", attempts: attempts(), ...(switchedTo ? { switchedTo } : {}) });
		}
		return { switched: true, ...(reply ? { reply } : {}) };
	};
	let pushedAt = 0;
	/*
	 * 写完了的正文块，和最近一份快照。`text_end` 不带快照：正文写完到这条回复收尾之间界面收不到任何东西，分不清是写完了还是
	 * 停住了（有的网关在这里空一两秒）。所以拿最近那份快照推一次，之后每次推都给这些块标上 `ended`。只标在推出去的副本上：
	 * 适配器原地改块，块的身份一路不变，用它认；落盘的那份和最终消息不带这个标记。
	 */
	const ended = new WeakSet<object>();
	let latest: AssistantMessage | undefined;
	const marked = (message: AssistantMessage): AssistantMessage =>
		message.content.some((block) => ended.has(block))
			? { ...message, content: message.content.map((block) => (block.type === "text" && ended.has(block) ? { ...block, ended: true as const } : block)) }
			: message;
	try {
		while (true) {
			const next = await stream.next();
			if (next.done) {
				if (switched()) return letGo(next.value);
				settle(next.value);
				return next.value;
			}
			const event = next.value;
			const saying = event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta" || event.type === "toolcall_end";
			if (saying) said = true;
			// 接上以后第一段内容一到就说「恢复了」，不等这条回复写完：长回复要写好几分钟，连接早就好了。
			if (saying && pending) {
				pending = false;
				turn.settled({ outcome: "recovered", attempts: attempts() });
			}
			if (event.type === "text_end") {
				// 同一时刻只有一段正文在写，写完的就是最后那段。不节流：这一次正是要让界面马上知道。
				const block = latest?.content.findLast((candidate) => candidate.type === "text");
				if (!latest || !block) continue;
				ended.add(block);
				pushedAt = Date.now();
				turn.draft(marked(latest));
				continue;
			}
			if (!("partial" in event)) continue;
			latest = event.partial;
			turn.keep(event.partial);
			if (Date.now() - pushedAt >= DRAFT_INTERVAL_MS) {
				pushedAt = Date.now();
				turn.draft(marked(event.partial));
			}
		}
	} catch (error) {
		if (switched()) return letGo();
		turn.draft(undefined);
		throw error;
	} finally {
		unsubscribe?.();
		turn.keep(undefined);
	}
}
