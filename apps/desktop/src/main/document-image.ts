const LIMIT = 5 * 1024 * 1024;
const BUDGET = 32 * 1024 * 1024;

/** 只下载文档图片；缓存、并发和响应体都有上限，失败一分钟后可重试。 */
export function createDocumentImageLoader(fetch: (url: string, init?: RequestInit) => Promise<Response>): (url: unknown) => Promise<string | null> {
	const cache = new Map<string, { value: string | null; at: number }>();
	const pending = new Map<string, Promise<string | null>>();
	const waiting: (() => void)[] = [];
	let active = 0;
	let held = 0;

	const download = async (url: string): Promise<string | null> => {
		if (active >= 6) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			const signal = AbortSignal.timeout(9000);
			for (let redirects = 0; redirects <= 5; redirects++) {
				if (!httpsImage(url)) return null;
				const response = await fetch(url, { signal, redirect: "manual", credentials: "omit" });
				if ([301, 302, 303, 307, 308].includes(response.status)) {
					await response.body?.cancel();
					const location = response.headers.get("location");
					if (!location) return null;
					url = new URL(location, url).href;
					continue;
				}
				const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
				if (!response.ok || !/^image\/[a-z0-9.+-]+$/i.test(type) || Number(response.headers.get("content-length")) > LIMIT) {
					await response.body?.cancel();
					return null;
				}
				if (!response.body) return null;
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let size = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > LIMIT) {
						await reader.cancel();
						return null;
					}
					chunks.push(value);
				}
				return size ? `data:${type};base64,${Buffer.concat(chunks, size).toString("base64")}` : null;
			}
			return null;
		} catch {
			return null;
		} finally {
			active--;
			waiting.shift()?.();
		}
	};

	return async (url) => {
		if (!httpsImage(url)) return null;
		const hit = cache.get(url);
		if (hit && (hit.value !== null || Date.now() - hit.at < 60_000)) return hit.value;
		const already = pending.get(url);
		if (already) return already;
		const request = download(url)
			.then((value) => {
				held -= cache.get(url)?.value?.length ?? 0;
				cache.delete(url);
				cache.set(url, { value, at: Date.now() });
				held += value?.length ?? 0;
				for (const [key, entry] of cache) {
					if (cache.size <= 200 && held <= BUDGET) break;
					cache.delete(key);
					held -= entry.value?.length ?? 0;
				}
				return value;
			})
			.finally(() => pending.delete(url));
		pending.set(url, request);
		return request;
	};
}

function httpsImage(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password;
	} catch {
		return false;
	}
}
