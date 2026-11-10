import { describe, expect, it } from "vitest";
import { type CallContext, type Port, RpcChannel, remote, serve } from "../src/index.ts";

/** 内存里的一对端口：消息经结构化克隆、异步投递，和跨进程时一样。 */
function portPair(): [Port, Port] {
	const listeners: [Set<(message: unknown) => void>, Set<(message: unknown) => void>] = [new Set(), new Set()];
	const make = (self: 0 | 1): Port => ({
		post(message) {
			const copy = structuredClone(message);
			queueMicrotask(() => {
				for (const listener of listeners[self === 0 ? 1 : 0]) listener(copy);
			});
		},
		listen(listener) {
			listeners[self].add(listener);
			return () => listeners[self].delete(listener);
		},
	});
	return [make(0), make(1)];
}

function connect<T extends object>(target: T) {
	const [a, b] = portPair();
	const server = new RpcChannel(b);
	serve(server, target);
	const client = new RpcChannel(a);
	return { proxy: remote<T>(client), client, server };
}

describe("RPC", () => {
	it("普通调用拿到返回值，对端抛错时以 E_HANDLER 失败", async () => {
		const { proxy } = connect({
			add: (a: number, b: number) => a + b,
			fail: () => {
				throw new Error("坏了");
			},
		});
		expect(await proxy.add(1, 2)).toBe(3);
		await expect(proxy.fail()).rejects.toMatchObject({ code: "E_HANDLER", message: "坏了" });
		await expect((proxy as unknown as Record<string, () => Promise<unknown>>).missing?.()).rejects.toMatchObject({ code: "E_NOT_FOUND" });
	});

	it("方法返回 async generator 时，for await 逐个拿中间值，await 拿 return 值", async () => {
		const { proxy } = connect({
			async *count(to: number) {
				for (let i = 1; i <= to; i++) yield i;
				return "完成";
			},
		});
		const call = proxy.count(3);
		const seen: number[] = [];
		for await (const value of call) seen.push(value);
		expect(seen).toEqual([1, 2, 3]);
		expect(await call).toBe("完成");
		expect(await proxy.count(2)).toBe("完成");
	});

	it("取消会传到对端：signal 中止、generator 的 finally 执行，本地以 E_CANCELLED 失败", async () => {
		const events: string[] = [];
		const { proxy } = connect({
			async *run(_name: string, call: CallContext) {
				call.signal.addEventListener("abort", () => events.push("收到中止"));
				try {
					yield "开始";
					await new Promise((_resolve, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason)));
				} finally {
					events.push("收尾");
				}
			},
		});
		const call = proxy.run("任务");
		for await (const _value of call) {
			call.cancel();
			break;
		}
		await expect(call).rejects.toMatchObject({ code: "E_CANCELLED" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(events).toEqual(["收到中止", "收尾"]);
	});

	it("超时的请求以 E_TIMEOUT 失败，并通知对端停下", async () => {
		const [a, b] = portPair();
		let aborted = false;
		// 只要它在 b 上挂好处理器，不需要它的引用。
		// oxlint-disable-next-line no-new
		new RpcChannel(b, {
			request: (_payload, call) =>
				new Promise((resolve) => {
					call.signal.addEventListener("abort", () => {
						aborted = true;
						resolve(null);
					});
				}),
		});
		const client = new RpcChannel(a);
		await expect(client.request("x", { timeoutMs: 20 })).rejects.toMatchObject({ code: "E_TIMEOUT" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(aborted).toBe(true);
	});

	it("通道关闭时挂起的请求以 E_CLOSED 失败，对端正在处理的请求被中止", async () => {
		const [a, b] = portPair();
		let serverSignal: AbortSignal | undefined;
		const server = new RpcChannel(b, {
			request: (_payload, call) => {
				serverSignal = call.signal;
				return new Promise(() => undefined);
			},
		});
		const client = new RpcChannel(a);
		const pending = client.request("x");
		await new Promise((resolve) => setTimeout(resolve, 10));
		client.close("对端退出");
		server.close();
		await expect(pending).rejects.toMatchObject({ code: "E_CLOSED", message: "对端退出" });
		expect(serverSignal?.aborted).toBe(true);
	});
});
