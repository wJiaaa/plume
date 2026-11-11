/**
 * 在 RpcChannel 上暴露一个对象、调用对端的对象。消息是 `{ method, args }`。
 *
 * 约定：
 * - 被调方法的最后一个参数是 CallContext，由这里追加，调用方不用传。需要响应取消的方法把参数个数写死。
 * - 方法返回异步迭代器（如 async generator）时，每个值作为中间值推给调用方，迭代器的 return 值是最终结果。
 */

import { type IncomingCall, RpcError, type RequestOptions, type RpcChannel } from "./rpc.ts";

/** 被调方法收到的最后一个参数。 */
export interface CallContext {
	/** 调用方取消或通道关闭时中止。 */
	signal: AbortSignal;
}

/**
 * 一次远程调用。`await` 拿最终结果；方法返回异步迭代器时，还可以 `for await` 逐个拿中间值。
 */
export interface RemoteCall<Y, R> extends PromiseLike<R>, AsyncIterable<Y> {
	then<A = R, B = never>(
		onfulfilled?: ((value: R) => A | PromiseLike<A>) | null,
		onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
	): Promise<A | B>;
	catch<E = never>(onrejected?: ((reason: unknown) => E | PromiseLike<E>) | null): Promise<R | E>;
	finally(onfinally?: (() => void) | null): Promise<R>;
	/** 取消这次调用：对端收到中止信号，本地以 E_CANCELLED 失败。 */
	cancel(): void;
}

type RemoteMethod<F> = F extends (...args: infer A) => infer R
	? (
			...args: A extends [...infer Head, CallContext] ? Head : A
		) => R extends AsyncIterable<infer Y> ? RemoteCall<Y, AsyncReturn<R>> : RemoteCall<never, Awaited<R>>
	: never;

type AsyncReturn<R> = R extends AsyncGenerator<unknown, infer Return, unknown> ? Return : undefined;

/** 远端对象的代理：每个方法都变成 RemoteCall，末尾的 CallContext 参数由对端补上。 */
export type Remote<T> = { [K in keyof T]: RemoteMethod<T[K]> };

interface Invocation {
	method: string;
	args: unknown[];
}

/** 把 target 暴露在通道上。target 是函数时每次调用现取，适合会被替换的对象。 */
export function serve(channel: RpcChannel, target: object | (() => object)): void {
	channel.setHandlers({
		request: (payload, call) => {
			const { method, args } = payload as Invocation;
			return callMethod(typeof target === "function" ? target() : target, method, args, call);
		},
	});
}

/** 对端对象的代理。signal 中止时取消这个代理上所有进行中的调用。 */
export function remote<T extends object>(channel: RpcChannel, options: { signal?: AbortSignal } = {}): Remote<T> {
	return new Proxy(
		{},
		{
			// `then` 必须是 undefined，否则 `await proxy` 会把它当成 Promise。
			get: (_target, property) => {
				if (typeof property !== "string" || property === "then") return undefined;
				return (...args: unknown[]) => remoteCall((call) => channel.request({ method: property, args } satisfies Invocation, call), options.signal);
			},
		},
	) as Remote<T>;
}

/**
 * 调用方取消时让迭代器提前结束，它的 finally 能借此收尾。注意 generator 正卡在某个 await 上时，
 * return 要等它下一次 yield 才生效，所以长时间的等待（请求、子进程）要接 CallContext.signal 自己中断。
 */
async function callMethod(target: object, method: string, args: unknown[], call: IncomingCall): Promise<unknown> {
	const fn = Object.hasOwn(target, method) || method in Object.getPrototypeOf(target) ? (target as Record<string, unknown>)[method] : undefined;
	if (typeof fn !== "function" || method === "constructor") throw new RpcError("E_NOT_FOUND", `没有方法 ${method}`);
	const context: CallContext = { signal: call.signal };
	const result: unknown = await fn.apply(target, [...args, context]);
	if (!isAsyncIterable(result)) return result;
	const iterator = result[Symbol.asyncIterator]();
	const stop = () => void iterator.return?.();
	call.signal.addEventListener("abort", stop, { once: true });
	try {
		while (true) {
			const next = await iterator.next();
			if (next.done) return next.value;
			call.emit(next.value);
		}
	} finally {
		call.signal.removeEventListener("abort", stop);
	}
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return typeof value === "object" && value !== null && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function";
}

/**
 * 立即发出请求。只 `await` 不迭代的调用方不需要中间值，所以一旦有人 `then`/`catch` 而没人迭代，就不再缓存它们。
 */
function remoteCall<Y, R>(send: (options: RequestOptions) => Promise<unknown>, external?: AbortSignal): RemoteCall<Y, R> {
	const controller = new AbortController();
	const abort = () => controller.abort(external?.reason);
	if (external?.aborted) abort();
	else external?.addEventListener("abort", abort, { once: true });

	const buffered: Y[] = [];
	let buffering = true;
	let wake: (() => void) | undefined;
	let settled = false;
	const result = send({
		signal: controller.signal,
		onChunk: (value) => {
			if (!buffering) return;
			buffered.push(value as Y);
			wake?.();
		},
	}).finally(() => {
		settled = true;
		external?.removeEventListener("abort", abort);
		wake?.();
	}) as Promise<R>;
	// 没人接结果时不要变成未处理的拒绝；真正的接收方在 then/catch/迭代里拿到错误。
	result.catch(() => undefined);
	let iterating = false;
	const settle = () => {
		if (!iterating) buffering = false;
		return result;
	};

	return {
		// 调用的结果既能 await（拿最终值），也能 for await（拿流式的中间值），所以有意做成 thenable。
		// oxlint-disable-next-line unicorn/no-thenable
		then: (onfulfilled, onrejected) => settle().then(onfulfilled, onrejected),
		catch: (onrejected) => settle().catch(onrejected),
		finally: (onfinally) => settle().finally(onfinally),
		cancel: () => controller.abort(),
		[Symbol.asyncIterator]: (): AsyncIterator<Y, R> => {
			iterating = true;
			return {
				next: async () => {
					while (buffered.length === 0 && !settled) await new Promise<void>((resolve) => (wake = resolve));
					wake = undefined;
					if (buffered.length > 0) return { done: false, value: buffered.shift() as Y };
					return { done: true, value: await result };
				},
				return: async () => {
					if (!settled) controller.abort();
					return { done: true, value: undefined as R };
				},
			};
		},
	};
}
