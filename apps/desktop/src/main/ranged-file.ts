/**
 * 按 `<video>`、`<audio>` 要的方式发一个文件：Range 头要哪一段就给哪一段，回 206。
 *
 * `net.fetch(file://)` 不管有没有 Range 都整个文件回 200。Chromium 的媒体管线把这种源当成不能跳转的
 * （`seekable` 是 [0, 0]），拖进度条、按 ← →、点轨道都回到第一帧：文件面板里的音视频只能从头放。
 *
 * 一段一段从磁盘读，不整个读进来：1080p 的片子几十 MB，拖一下只要中间几百 KB。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/** 媒体元素发的那一种 `bytes=` 范围。别的写法（多段、写错的）整个文件给。 */
export function byteRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
	if (!match || (!match[1] && !match[2])) return null;
	// `bytes=-500` 是最后 500 个字节；`bytes=500-` 一直到文件尾。
	const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
	const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
	return start >= size || start > end ? "unsatisfiable" : { start, end };
}

export async function serveRanged(path: string, request: Request, type: string): Promise<Response> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) return new Response("not found", { status: 404 });
	const size = info.size;
	const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes" };
	const range = byteRange(request.headers.get("range"), size);
	if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
	const { start, end } = range ?? { start: 0, end: size - 1 };
	if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
	headers["content-length"] = String(size === 0 ? 0 : end - start + 1);
	const body =
		request.method === "HEAD" || size === 0 ? null : (Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream<Uint8Array>);
	return new Response(body, { status: range ? 206 : 200, headers });
}
