/**
 * 把回调推来的值变成异步迭代，给经 RPC 流式返回的方法用。
 *
 * 一次给出攒下的一批：输出来得比通道送得快时，几块合成一次推送，不一块一个消息。调用方取消（signal 中止）
 * 或 end 之后，送完已经攒下的就结束；结束时退订。不能只靠迭代器的 return：卡在等下一个值时 return 不生效，
 * 所以等的时候也看着 signal。
 */
export async function* listen<T>(signal: AbortSignal, subscribe: (emit: (value: T) => void, end: () => void) => () => void): AsyncGenerator<T[], void> {
	let queue: T[] = [];
	let ended = false;
	let wake: (() => void) | undefined;
	const poke = () => {
		wake?.();
		wake = undefined;
	};
	const stop = () => {
		ended = true;
		poke();
	};
	signal.addEventListener("abort", stop, { once: true });
	const unsubscribe = subscribe((value) => {
		queue.push(value);
		poke();
	}, stop);
	try {
		while (true) {
			if (queue.length > 0) {
				const batch = queue;
				queue = [];
				yield batch;
				continue;
			}
			if (ended || signal.aborted) return;
			await new Promise<void>((resolve) => (wake = resolve));
		}
	} finally {
		signal.removeEventListener("abort", stop);
		unsubscribe();
	}
}
