/**
 * 媒体目录里一张图的缩略图：只算一次，算完落盘。
 *
 * 缩略图要解码整张原图、缩小、再编码回去，三件都是同步的，都跑在主进程上：一张几十毫秒，画廊一屏几十张一起进视口，
 * 这段时间整个应用都是哑的。Chromium 的缓存只在内存里、只认同一个地址，重开应用就要重付一遍；落到盘上才是付一次。
 *
 * 存在 `<媒体目录>/thumbs/<原图名去掉扩展名>.<边长>.png`。原图按内容命名、从不删除，缩略图也就不会成为孤儿，不用清扫。
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ThumbDeps {
	/** 原图的字节，拿不到就返回 null。 */
	source(): Promise<Uint8Array | null>;
	/** 缩到这个边长，返回 PNG；本来就比它小（或解不开）时返回 null，表示原样发回去。 */
	shrink(bytes: Uint8Array, edge: number): Uint8Array | null;
}

/** 缓存名里带边长：同一张图要 128 和 800 两种尺寸时，它们是两个文件，不会互相覆盖。 */
function thumbPath(dir: string, name: string, edge: number): string {
	return join(dir, "thumbs", `${name.replace(/\.[^.]+$/, "")}.${edge}.png`);
}

/** 同一张图的并发请求合流，不然一屏格子同时挂上去就是几十次同样的解码。 */
const running = new Map<string, Promise<Uint8Array | null>>();

/** 盘上那份，没有就 null。不跟随软链，和读原图同一道边界。 */
async function cached(dir: string, path: string): Promise<Uint8Array | null> {
	if (!(await lstat(join(dir, "thumbs")).catch(() => null))?.isDirectory()) return null;
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
	if (!handle) return null;
	try {
		return (await handle.stat()).isFile() ? await handle.readFile() : null;
	} catch {
		return null;
	} finally {
		await handle.close();
	}
}

/**
 * 盘上有就读盘上的（连原图都不读），没有就算一次、写下来。交回 null 时调用方发原图。
 * `name` 由调用方校验过（媒体名的格式），这里只拼路径。
 */
export async function mediaThumb(dir: string, name: string, edge: number, deps: ThumbDeps): Promise<Uint8Array | null> {
	const path = thumbPath(dir, name, edge);
	const hit = await cached(dir, path);
	if (hit) return hit;
	const inflight = running.get(path);
	if (inflight) return inflight;
	const work = (async () => {
		const bytes = await deps.source();
		if (!bytes) return null;
		const png = deps.shrink(bytes, edge);
		if (!png) return null;
		// 写不进去（盘满、只读）不该让这张图画不出来：这一次照样交货，下一次再算。
		await mkdir(join(dir, "thumbs"), { recursive: true })
			.then(() => writeFile(path, png))
			.catch(() => undefined);
		return png;
	})();
	running.set(path, work);
	try {
		return await work;
	} finally {
		running.delete(path);
	}
}
