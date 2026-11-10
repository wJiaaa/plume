/**
 * 证明下下来的字节就是发布的那些。
 *
 * 地址是 GitHub 的、长度对得上，都说明不了内容：中间改写内容的代理、被污染的缓存、别人架的镜像都能给出一个完整、来路正确、
 * 却不是构建出来的那个文件。而这是应用里唯一一个下完会被运行的下载。所以 release 同时发布 `SHA256SUMS`，这里读回来对。
 * 校验值和文件来自同一个 release、同一条 TLS 连接，挡不住 GitHub 账号被盗，本来也不为挡那个；它堵的是从那里到这里的一路。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { say } from "./say.ts";

/** `sha256sum` 写出、CI 上传的名字。 */
export const CHECKSUM_ASSET = "SHA256SUMS";

/**
 * 解析 `sha256sum *` 的输出：每行一个摘要、空白、文件名，二进制模式读的文件名前面带 `*`，两种都认。
 * 认不出的行跳过而不是报错：以后在这个文件里加一行注释，不该让更新校验不了。
 */
export function parseChecksums(text: string): Map<string, string> {
	const digests = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
		if (match) digests.set(match[2] as string, (match[1] as string).toLowerCase());
	}
	return digests;
}

/** 磁盘上一个文件的 SHA-256，流式读，大包不进内存。 */
export async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

export type Verdict = { ok: true } | { ok: false; reason: "no-checksums" | "not-listed" | "mismatch"; message: string };

/**
 * 这个文件是不是 release 发布的那一个。三种不对分开说，它们不是一回事：
 * `no-checksums` release 没发校验文件；`not-listed` 文件不在里面，多半是名字对不上；`mismatch` 字节不对，这才是要紧的那种。
 */
export function verify(digests: Map<string, string>, name: string, actual: string): Verdict {
	if (digests.size === 0) return { ok: false, reason: "no-checksums", message: say("update.checksumsMissing") };
	const expected = digests.get(name);
	if (!expected) return { ok: false, reason: "not-listed", message: say("update.checksumNotListed", { name }) };
	if (expected !== actual.toLowerCase()) {
		return { ok: false, reason: "mismatch", message: say("update.checksumMismatch", { expected: expected.slice(0, 12), actual: actual.slice(0, 12) }) };
	}
	return { ok: true };
}
