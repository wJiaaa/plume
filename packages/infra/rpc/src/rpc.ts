/**
 * 两个进程之间的双向 RPC。只依赖一个能收发结构化克隆消息的 Port，
 * 所以 utilityProcess 的 parentPort、渲染进程的 MessagePort、测试里的内存管道都能用同一套。
 * 不依赖任何第三方库：它会被打进渲染进程。
 */

export type ErrorCode = "E_NOT_FOUND" | "E_CANCELLED" | "E_CLOSED" | "E_HANDLER";

export interface Port {
	post(message: unknown): void;
	/** 返回取消监听的函数。 */
	listen(listener: (message: unknown) => void): () => void;
}

export class RpcError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "RpcError";
		this.code = code;
	}
}

export function toRpcError(error: unknown, fallback: ErrorCode = "E_HANDLER"): RpcError {
	if (error instanceof RpcError) return error;
	if (error instanceof Error) return new RpcError(fallback, error.message);
	return new RpcError(fallback, String(error));
}

type Wire =
	| { k: "req"; id: number; p: unknown }
	/** 结果出来之前推送的中间值（流式返回）。 */
	| { k: "chunk"; id: number; v: unknown }
	| { k: "res"; id: number; ok: true; v: unknown }
	| { k: "res"; id: number; ok: false; e: { code: ErrorCode; message: string } }
	/** 发起方不要结果了。处理方据此停下手上的活。 */
	| { k: "cancel"; id: number };

export interface RequestOptions {
	/** 中止时向对端发取消，本地以 E_CANCELLED 失败。 */
	signal?: AbortSignal;
	/** 收到中间值时调用。 */
	onChunk?(value: unknown): void;
}

/** 处理方看到的这次调用。 */
export interface IncomingCall {
	/** 发起方取消或通道关闭时中止。 */
	signal: AbortSignal;
	/** 推送一个中间值给发起方。 */
	emit(value: unknown): void;
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: RpcError): void;
	onChunk: ((value: unknown) => void) | undefined;
	dispose(): void;
}

export interface RpcHandlers {
	request?(payload: unknown, call: IncomingCall): unknown;
}

export class RpcChannel {
	private seq = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly incoming = new Map<number, AbortController>();
	private readonly unlisten: () => void;
	private closedWith: RpcError | undefined;

	constructor(
		private readonly port: Port,
		private handlers: RpcHandlers = {},
	) {
		this.unlisten = port.listen((message) => this.receive(message as Wire));
	}

	setHandlers(handlers: RpcHandlers): void {
		this.handlers = handlers;
	}

	request(payload: unknown, options: RequestOptions = {}): Promise<unknown> {
		if (this.closedWith) return Promise.reject(this.closedWith);
		const { signal, onChunk } = options;
		if (signal?.aborted) return Promise.reject(cancelled(signal));
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				if (!this.pending.has(id)) return;
				this.settle(id)?.dispose();
				this.port.post({ k: "cancel", id } satisfies Wire);
				reject(cancelled(signal as AbortSignal));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, { resolve, reject, onChunk, dispose: () => signal?.removeEventListener("abort", onAbort) });
			try {
				this.port.post({ k: "req", id, p: payload } satisfies Wire);
			} catch (error) {
				// 参数无法结构化克隆（界面入口经 `ui.remote()` 传了函数、DOM 节点）时请求根本没发出去：撤下登记，不留到通道关闭。
				this.settle(id)?.dispose();
				reject(new RpcError("E_HANDLER", `参数无法传输：${toRpcError(error).message}`));
			}
		});
	}

	/** 关闭通道：挂起的请求全部以 E_CLOSED 失败，正在处理的请求被中止，之后的收发都被忽略。 */
	close(reason = "通道已关闭"): void {
		if (this.closedWith) return;
		this.closedWith = new RpcError("E_CLOSED", reason);
		this.unlisten();
		for (const id of [...this.pending.keys()]) {
			const pending = this.settle(id);
			pending?.dispose();
			pending?.reject(this.closedWith);
		}
		for (const controller of this.incoming.values()) controller.abort(this.closedWith);
		this.incoming.clear();
	}

	private settle(id: number): Pending | undefined {
		const pending = this.pending.get(id);
		this.pending.delete(id);
		return pending;
	}

	private receive(message: Wire): void {
		if (this.closedWith || typeof message !== "object" || message === null) return;
		switch (message.k) {
			case "req":
				void this.answer(message.id, message.p);
				return;
			case "cancel":
				this.incoming.get(message.id)?.abort(new RpcError("E_CANCELLED", "发起方已取消"));
				return;
			case "chunk":
				this.pending.get(message.id)?.onChunk?.(message.v);
				return;
			case "res": {
				const pending = this.settle(message.id);
				if (!pending) return;
				pending.dispose();
				if (message.ok) pending.resolve(message.v);
				else pending.reject(new RpcError(message.e.code, message.e.message));
			}
		}
	}

	private async answer(id: number, payload: unknown): Promise<void> {
		const controller = new AbortController();
		this.incoming.set(id, controller);
		const call: IncomingCall = {
			signal: controller.signal,
			emit: (value) => {
				if (!this.closedWith && !controller.signal.aborted) this.port.post({ k: "chunk", id, v: value } satisfies Wire);
			},
		};
		let reply: Wire;
		try {
			if (!this.handlers.request) throw new RpcError("E_NOT_FOUND", "对端不接受请求");
			reply = { k: "res", id, ok: true, v: await this.handlers.request(payload, call) };
		} catch (error) {
			const failure = toRpcError(error);
			reply = { k: "res", id, ok: false, e: { code: failure.code, message: failure.message } };
		} finally {
			this.incoming.delete(id);
		}
		// 发起方已经不等了（取消了），结果没人收。
		if (this.closedWith || controller.signal.aborted) return;
		try {
			this.port.post(reply);
		} catch (error) {
			// 返回值无法结构化克隆（比如带了函数）时，至少让调用方拿到一个明确的错误而不是一直等。
			const failure = toRpcError(error);
			this.port.post({ k: "res", id, ok: false, e: { code: "E_HANDLER", message: `返回值无法传输：${failure.message}` } } satisfies Wire);
		}
	}
}

function cancelled(signal: AbortSignal): RpcError {
	return signal.reason instanceof RpcError ? signal.reason : new RpcError("E_CANCELLED", "调用已取消");
}
