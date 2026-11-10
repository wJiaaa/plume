/** Shared request/stream budget prevents nested retry loops from multiplying the configured limit. */
import { normalizeRetryPolicy, policyDelay, type RetryPolicy, type RetryPolicySource, type RetryFailure } from "../config/retry-policy.ts";
import { classifyFailure, durationMs, failureOf, FailureError, serverDelayMs, worthRetrying, type Failure } from "./failure.ts";

/** Explicit low-level attempt overrides (e.g. commit titles) retain their bounded lifetime. */
function resolvePolicy(policy: RetryPolicy | undefined, attempts: number | undefined): RetryPolicy {
	const normalized = normalizeRetryPolicy(policy);
	if (policy || attempts === undefined) return normalized;
	const retries = Number.isFinite(attempts) ? Math.max(0, Math.round(attempts) - 1) : 10;
	const upstream = { ...normalized.upstream, retries };
	return { upstream, network: { ...upstream } };
}

export class RetryBudget {
	private used = { network: 0, upstream: 0 };
	/**
	 * 自带上限的失败（`Failure.retryLimit`）各自重试过几次，按指纹记。
	 *
	 * 不能和 `used[kind]` 共用：那是同一类所有失败的总账。先连着 503 重试四次，轮到空回答时总账已经是
	 * 4，它自己一次没试就被判「用满了」。它的上限说的是「这一种重发了几次」，账得单独记。
	 */
	private limited = new Map<string, number>();
	private readonly read: () => RetryPolicy | undefined;
	private readonly attempts?: number;
	private cache?: { from: RetryPolicy | undefined; resolved: RetryPolicy };
	constructor(policy?: RetryPolicySource, attempts?: number) {
		this.read = typeof policy === "function" ? policy : () => policy;
		this.attempts = attempts;
	}
	/**
	 * The rules in force right now, not the ones this request started under.
	 *
	 * Normalising is not free and this is read on every attempt, so the result is kept until the
	 * settings object itself is replaced — which is what saving the settings page does.
	 */
	get policy(): RetryPolicy {
		const from = this.read();
		if (!this.cache || this.cache.from !== from) this.cache = { from, resolved: resolvePolicy(from, this.attempts) };
		return this.cache.resolved;
	}
	/**
	 * 还能不能再试一次。
	 *
	 * 失败可以选择传进来，因为有那么几种失败自己带着上限（见 `Failure.retryLimit`），而它比用户
	 * 的策略更有发言权的情形只有一种：重发不可能改变结果。两个数取更严的那个——用户设了 2 次就
	 * 是 2 次，这里不会把它放宽成 4。
	 *
	 * 不传也是对的：调用方手里没有分类结论时（还没发出去的那一次），问的就是纯粹的策略。
	 */
	available(kind: RetryFailure, failure?: Failure): boolean {
		const { retries } = this.policy[kind];
		if (retries !== null && this.used[kind] >= retries) return false;
		if (failure?.retryLimit === undefined) return true;
		return (this.limited.get(failure.fingerprint) ?? 0) < failure.retryLimit;
	}
	/** 传入 `failure` 时，自带上限的那种失败另记一笔，见 `limited`。 */
	next(kind: RetryFailure, failure?: Failure): { attempt: number; delayMs: number } {
		this.used[kind]++;
		if (failure?.retryLimit !== undefined) this.limited.set(failure.fingerprint, (this.limited.get(failure.fingerprint) ?? 0) + 1);
		return { attempt: this.used.network + this.used.upstream, delayMs: policyDelay(this.policy[kind], this.used[kind]) };
	}
}

export interface RetryOptions {
	budget?: RetryBudget;
	/** Total attempts, including the first. */
	attempts?: number;
	signal?: AbortSignal;
	/** Called before each wait, so a caller can tell the user what is happening. */
	onRetry?: (info: { attempt: number; delayMs: number; reason: string; failure?: Failure }) => void;
	/** Injected in tests so they do not sleep. */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * 这个请求要的是 SSE。200 而正文明摆着不是（见 `streamOrFailure`）的，当失败判，不交给流解析。
	 *
	 * 要调用方开口说，因为不是每个经过这里的请求都要流：一次性的 JSON 请求，200 加 JSON 就是成功。
	 */
	stream?: boolean;
}

/**
 * 值得再试一次吗——问的是 `failure.ts`，不是这里。
 *
 * 这两个函数从前各自守着一份白名单，是四份互不知情的判断里的两份。留下这层薄壳是因为调用点还在
 * 用它们的名字，而壳里已经换成了同一个分类器：认不出来的东西现在会被重试，而不是被拒之门外。
 */
export function isRetryableError(error: unknown): boolean {
	return worthRetrying(failureOf(error));
}

export function isRetryableStatus(status: number, body?: string): boolean {
	return worthRetrying(classifyFailure({ from: "status", status, body }));
}

/**
 * The longest wait for the server's own number worth sitting through inside one turn.
 *
 * A relay asking for an hour is not something to do silently. Five minutes is: the wait is shown
 * (`onRetry`), stop cuts it short, and the alternative — giving up, or coming back after one minute
 * to a server that said four — throws away the turn or spends a retry against the same wall. It was
 * one minute until a coding plan's rate window was measured at several.
 */
const MAX_SERVER_WAIT_MS = 5 * 60_000;

/** The ceiling of our own curve, for servers that say nothing: 2s, 5s, 12.5s, 31s, then a minute. */
const CURVE_MAX_MS = 60_000;

/** `x-should-retry: false`，见 `headerDelay` 里那段。 */
const saysDoNotRetry = (response: Response): boolean => /^(?:false|0)$/i.test(response.headers.get("x-should-retry")?.trim() ?? "");

/**
 * 响应头里服务器说的等待时间：标准的 `Retry-After`，和 OpenAI 系额外发的毫秒版 `retry-after-ms`。
 *
 * 两个都没有时，再看 OpenAI 的 `x-ratelimit-reset-requests` / `-tokens`（`6m0s` 这种写法）。只取
 * 对应的 `x-ratelimit-remaining-*` 已经是 0 的那一项：另一项的重置时间说的是「完全回满」要多久，
 * 不是这一次要等多久，拿它来等会白等几分钟。正文里写了等待时间的，正文优先。
 */
function headerDelay(response: Response, body?: string): number | null {
	/*
	 * `x-should-retry: false`：服务器给了等待时间，又说别再来。来不来由分类器判——终局的本来就不重试，
	 * 而中转在临时故障上也会顺手带这个头——但它给的时间不拿来等：那是「别来」，不是「过多久再来」。
	 */
	if (saysDoNotRetry(response)) return null;
	const ms = Number(response.headers.get("retry-after-ms"));
	if (Number.isFinite(ms) && ms > 0) return ms;
	const said = serverDelayMs(response.headers.get("retry-after"), body);
	if (said !== undefined) return said;
	let reset: number | null = null;
	for (const kind of ["requests", "tokens"]) {
		if (response.headers.get(`x-ratelimit-remaining-${kind}`)?.trim() !== "0") continue;
		const wait = durationMs(response.headers.get(`x-ratelimit-reset-${kind}`) ?? "");
		if (wait !== undefined) reset = Math.max(reset ?? 0, wait);
	}
	return reset;
}

/**
 * 配了策略时，这一次到底等多久：策略的间隔和服务器要求的，取大的那个。
 *
 * 一度只听策略、完全无视服务器（理由是设置页写着固定间隔「不受服务端建议影响」）。代价是：中转回
 * `reset_seconds: 54` 说一分钟内别来，默认 10 次、每次 5 秒的上游预算在 50 秒里全部撞在同一堵墙上，
 * 这一轮就此失败——而服务器明明说了再等几秒就好。取大值不会让等待比用户配的更短，只是不在服务器
 * 明说「还没好」的时候提前回去：用户配的是「最少等多久」，服务器说的是「最早什么时候有用」，两个都守。
 *
 * 服务器的数照旧封顶 `MAX_SERVER_WAIT_MS`，一个要求等一小时的中转不该让这一轮静默挂住；比封顶更长的用户
 * 间隔原样生效，那是用户自己的选择。等待仍走 `abortableSleep`，按停止立即醒。
 */
function withServerDelay(policyMs: number, serverMs: number | null | undefined): number {
	if (serverMs === null || serverMs === undefined || !(serverMs > 0)) return policyMs;
	return Math.max(policyMs, Math.min(serverMs, MAX_SERVER_WAIT_MS));
}

/**
 * How long to wait, honouring the server's own answer when it gives one.
 *
 * A server under load knows better than any curve we could pick, so its number wins outright —
 * only capped, never shortened. Ours is the fallback, and it starts where a person would expect a
 * retry to start rather than where a tight loop would: the first version began at 600ms and
 * tripled, which spent three attempts inside two and a half seconds and read as the app hammering
 * a server that had just said it was busy.
 */
export function retryDelay(attempt: number, response?: Response, body?: string): number {
	const said = response ? headerDelay(response, body) : (serverDelayMs(null, body) ?? null);
	if (said !== null) return Math.min(said, MAX_SERVER_WAIT_MS);
	// 2s, 5s, 12.5s, 31s, 60s — with jitter, so a fleet of clients does not return in lockstep.
	// The ceiling is applied *after* the jitter: capping first lets the ±25% push the result
	// back over the limit, which is what the test caught.
	const base = 2000 * 2.5 ** (attempt - 1);
	return Math.min(base * (0.75 + Math.random() * 0.5), CURVE_MAX_MS);
}

/**
 * Wait for the given delay, unless the signal aborts first.
 *
 * Plain `setTimeout` cannot be cancelled, so sleeping for 60 seconds against an un-abortable timer
 * would keep the turn alive for the whole minute even if the user pressed stop.
 */
function abortableSleep(ms: number, signal?: AbortSignal, customSleep?: (ms: number) => Promise<void>): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	if (customSleep) return customSleep(ms);
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/**
 * Perform a request, retrying everything except what is certain not to change.
 *
 * 成功的响应原样返回。其余一律抛 `FailureError`——包括 4xx：从前它们是被「原样返回，由调用方
 * 自己去报」的，而三个调用方拿到之后做的第一件事都是 `if (!response.ok) throw`，于是那个结论在
 * 路上被重新猜了一遍，猜出来的东西还不如原来准（一个 `HTTP 401: ...` 字符串在流那一层看起来像
 * 「没见过的连接问题」）。判断带着结论一起走。
 */
export async function fetchWithRetry(
	doFetch: typeof globalThis.fetch,
	url: string,
	init: RequestInit,
	options: RetryOptions = {},
): Promise<Response> {
	const attempts = options.budget ? Infinity : Math.max(1, options.attempts ?? 3);
	let lastError: unknown;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (options.signal?.aborted) break;
		// 响应头到了以后再抛的（`streamOrFailure` 读开头那段时断线），不是「发不出去」，见 `FailureInput` 的 `sending`。
		let sent = false;
		try {
			const response = await doFetch(url, init);
			sent = true;
			let failure: Failure;
			let body: string | undefined;
			if (response.ok) {
				const checked = options.stream ? await streamOrFailure(response) : response;
				if (checked instanceof Response) return checked;
				failure = checked;
			} else {
				/*
				 * The body is read, off a clone, purely to find out what happened and how long to wait.
				 *
				 * 从前这一行写的是 `options.budget ? undefined : await response.clone().text()`——也就是
				 * 说下面这段讲「不读正文会把重试预算在几秒内烧光」的道理，只在没配重试策略的时候才作数，
				 * 而配了策略的人反而拿不到服务器自己说的等待时间。The relay puts `reset_seconds` in there
				 * and no `Retry-After` header. 用克隆读，调用方可能还要用的那个响应一个字节不动。
				 */
				body = await response.clone().text().catch(() => undefined);
				failure = classifyFailure({ from: "status", status: response.status, body });
			}
			// 头里说的等待时间分类器看不见（它只拿到正文），在这里补上，界面和下面的等待都用它。
			const said = headerDelay(response, body);
			if (said !== null) failure.retryAfterMs = said;
			// 正文里的等待时间是分类器读的，同样不作数；留着它，界面照样报出那个数，`retryStream` 也照它去等。
			else if (saysDoNotRetry(response)) delete failure.retryAfterMs;
			const canRetry = options.budget ? options.budget.available("upstream", failure) : attempt < attempts;

			if (!worthRetrying(failure) || !canRetry) {
				// 判断带着结论一起往上走，免得流那一层拿到一个字符串又重新猜一遍——猜错的那次会把
				// 一个 401 当成没见过的连接问题，然后无限重试下去。
				await response.body?.cancel().catch(() => undefined);
				throw new FailureError(failure);
			}

			// 配了策略：策略间隔和服务器要求取大，见 `withServerDelay`。没配：兜底曲线本来就听服务器的。
			const planned = options.budget?.next("upstream", failure);
			const retry = planned ? { ...planned, delayMs: withServerDelay(planned.delayMs, said) } : { attempt, delayMs: retryDelay(attempt, response, body) };
			const delay = retry.delayMs;
			// Release each failed response before an unlimited wait can accumulate connections.
			await response.body?.cancel().catch(() => undefined);
			options.onRetry?.({ ...retry, delayMs: delay, reason: failure.summary, failure });
			await abortableSleep(delay, options.signal, options.sleep);
			continue;
		} catch (error) {
			lastError = error;
			/*
			 * 上面那几行自己抛的，直接放走——它已经判过了，判的结果就是不再重试。
			 *
			 * 少了这一句是个死循环，而且是默认配置下就会撞上的那种：状态码那一路把 `FailureError`
			 * 抛在 `try` 里，于是被这个 `catch` 接住，而下面那行查的是 **network** 预算——它默认
			 * 是无限的。一个 upstream 预算已经用尽的 503 就这样被 network 的无限额度接着重试，永远
			 * 转下去。`retry-policy.test.ts` 整个文件挂住，一条都跑不出来。
			 */
			if (error instanceof FailureError) throw error;
			// 出自 `doFetch` 那一下的，只有这里能这样告诉分类器，见 `FailureInput` 的 `sending`。
			const failure = classifyFailure({ from: "transport", error, sending: !sent });
			// A cancelled turn is not a failed one; stop immediately rather than waiting to retry.
			if (options.signal?.aborted) throw error;
			// 带着结论抛：到了 `retryStream` 那层就不知道它出自发请求那一下，会把「发不出去」重新猜成断线。
			if (!worthRetrying(failure)) throw new FailureError(failure);
			if (options.budget ? !options.budget.available("network", failure) : attempt === attempts) throw error;
			const retry = options.budget?.next("network", failure) ?? { attempt, delayMs: retryDelay(attempt) };
			const delay = retry.delayMs;
			options.onRetry?.({ ...retry, reason: failure.summary, failure });
			await abortableSleep(delay, options.signal, options.sleep);
		}
	}

	/*
	 * How many attempts it took to give up, attached to the error.
	 *
	 * Without it a failure after five tries and a failure on the first look identical in the
	 * transcript, and they call for opposite things: one is a wobble worth continuing through, the
	 * other is something that is not going to work no matter how long you wait.
	 *
	 * 只在次数确切的时候说。配了预算时 `attempts` 是 `Infinity`，而在重试等待中按下停止正好会走到
	 * 这里——从前拼出来的是一句「已重试 Infinity 次」。
	 */
	if (lastError instanceof Error && Number.isFinite(attempts) && attempts > 1) {
		lastError.message = `${lastError.message}（已重试 ${attempts} 次）`;
	}
	throw lastError ?? new Error("请求已取消");
}

/** 明说是 JSON（含 `application/problem+json` 这类）或网页的 content-type。 */
const NOT_STREAM_TYPE = /^\s*(?:application\/(?:[\w.-]+\+)?json|text\/html)\b/i;

/**
 * 200 的响应是不是一条 SSE；不是的话，它是什么失败。
 *
 * 从前一律交给流解析：JSON 错误体、一页 HTML、一整份非流式的回答都解析不出一帧，落成「空回答」，
 * 同一个请求重发四次，原文丢掉——额度用完、地址填错，界面上都是同一句「服务商返回了空回答」。
 *
 * 只认 content-type **明说**是 JSON 或网页的。不能反过来凭「不是 event-stream」就拦：有的中转把 SSE
 * 标成 `text/plain`，甚至 `application/json`。
 *
 * 只看开头：读到能判断是不是 SSE 为止（一个 `data:` 或 `{` 就够）。是 SSE 的，读过的那几块原样放回去，
 * 后面照常一块一块交给流解析——那里有空闲闸看着，回答也是逐字出来的。整个读完再判，那条流就绕过了空闲闸，
 * 中途卡住时一直挂着，正常时也要等整条回答到齐才出字。开头这一小段没有空闲闸，但 undici 的 `bodyTimeout`
 * （`TRANSPORT_TIMEOUT_MS`）和停止信号都管得到它。不是 SSE 的那份是错误体或整份 JSON，有尽头，读完交给分类器。
 */
async function streamOrFailure(response: Response): Promise<Response | Failure> {
	if (!NOT_STREAM_TYPE.test(response.headers.get("content-type") ?? "") || !response.body) return response;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const head: Uint8Array[] = [];
	let text = "";
	let ended = false;
	try {
		while (!/[:{[<\n]/.test(text.trimStart())) {
			const { done, value } = await reader.read();
			if (done) {
				ended = true;
				break;
			}
			head.push(value);
			text += decoder.decode(value, { stream: true });
		}
		if (!ended && /^\s*(?:data|event|id|retry)?:/.test(text)) {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of head) controller.enqueue(chunk);
				},
				async pull(controller) {
					const { done, value } = await reader.read();
					if (done) controller.close();
					else controller.enqueue(value);
				},
				cancel: (reason) => reader.cancel(reason),
			});
			return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
		}
		while (!ended) {
			const { done, value } = await reader.read();
			if (done) ended = true;
			else text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} catch (error) {
		/*
		 * 读到一半断了，或者按了停止：往上抛，由 `fetchWithRetry` 当连接问题判、按停止退出。从前在这里吞掉，
		 * 把读到的半截当成「不是流」去分类——停止后先闪一句「收到的是一整份 JSON」的重试，断线扣的是 upstream 预算。
		 */
		await reader.cancel().catch(() => undefined);
		throw error;
	}
	if (/^\s*(?:data|event|id|retry)?:/.test(text)) return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
	return classifyFailure({ from: "empty", why: "not-stream", body: text });
}

/**
 * A tool call's id, invented if the provider did not supply one.
 *
 * The id is the only thing tying a call to its result and to the card on screen. A provider
 * that omits it — some relays drop `call_id` on a truncated stream — used to yield the empty
 * string for every such call, so they all collided on one entry: the newest call reset the
 * shared record to "running" and every earlier card in the transcript started spinning again,
 * all showing the same elapsed time because they were all reading the same object.
 *
 * The fallback is remembered per output index, because one call arrives across several events
 * and they have to agree on what it is called.
 */
export function toolCallId(given: unknown, outputIndex: number, invented: Map<number, string>): string {
	const supplied = String(given ?? "").trim();
	if (supplied) return supplied;
	let generated = invented.get(outputIndex);
	if (!generated) {
		generated = `plume-call-${outputIndex}-${Math.random().toString(36).slice(2, 10)}`;
		invented.set(outputIndex, generated);
	}
	return generated;
}

/**
 * Run a streamed request, and start it over if the stream itself dies.
 *
 * `fetchWithRetry` covers getting the connection; this covers keeping it. They are different
 * failures with the same cause and very different odds: a request that takes forty seconds to
 * stream a large reply is exposed to a dropped socket for the whole of it, and a long piece of
 * work is exactly where the replies are longest. Losing one there ends the turn — and with it a
 * plan the agent was eight steps into.
 *
 * Starting over is safe because nothing has happened yet. Tools are executed by the caller after
 * a complete reply arrives, so a half-streamed one has changed nothing; the only cost is the
 * tokens spent saying it again.
 *
 * `reset` is called before every attempt to clear whatever the last one accumulated. Anything
 * already emitted to the UI is replaced by what the retry emits, because each update carries the
 * whole message rather than a delta to apply.
 */
export async function* retryStream<T>(
	attempt: (attemptNumber: number) => AsyncGenerator<T, void>,
	options: {
		budget?: RetryBudget;
		attempts?: number;
		signal?: AbortSignal;
		reset: () => void;
		onRetry?: (info: { attempt: number; delayMs: number; reason: string; failure?: Failure }) => void;
		sleep?: (ms: number) => Promise<void>;
	},
): AsyncGenerator<T, void> {
	const attempts = options.budget ? Infinity : Math.max(1, options.attempts ?? 3);

	for (let number = 1; number <= attempts; number++) {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("请求已取消");
		options.reset();
		try {
			yield* attempt(number);
			return;
		} catch (error) {
			const failure = failureOf(error);
			/*
			 * 哪一条规则，由失败自己说了算。
			 *
			 * 从前这里一律记在 `network` 头上——流断了嘛。可流里跑的不止是断线：一个 503、一个流内
			 * error 事件、一次空回答，全都从这里经过，而它们该走的是「上游故障」那条规则。记错了账，
			 * 界面上两行设置就有一行永远不生效。
			 */
			const rule = failure.kind === "upstream" ? "upstream" : "network";
			const last = options.budget ? !options.budget.available(rule, failure) : number === attempts;
			if (last || options.signal?.aborted || !worthRetrying(failure)) throw error;
			/*
			 * 同上：配了策略时策略间隔和服务器要求取大。流里的错误（中转塞进 error 事件的 `reset_seconds`）
			 * 由分类器从原文里读成 `retryAfterMs`；没配策略时兜底曲线也要听它，从前这里一律忽略。
			 */
			const planned = options.budget?.next(rule, failure);
			const retry = planned
				? { ...planned, delayMs: withServerDelay(planned.delayMs, failure.retryAfterMs) }
				: { attempt: number, delayMs: failure.retryAfterMs ? Math.min(failure.retryAfterMs, MAX_SERVER_WAIT_MS) : retryDelay(number) };
			const delayMs = retry.delayMs;
			options.onRetry?.({ ...retry, delayMs, reason: failure.summary, failure });
			await abortableSleep(delayMs, options.signal, options.sleep);
		}
	}
}
