/**
 * 读一个网页，不用为读网页问人。
 *
 * GET 在这台机器上什么都不改：不写文件、不起进程、不碰项目，影响只是一份 token 预算，所以不是 mutating。
 * 真正的风险是回来的内容——写给抓取它的模型当指令读的网页。审批卡上显示一个 URL 防不了这个（做决定时内容还不在屏幕上），
 * 防线在下游：正文用 `<fetched>` 包起来、标成数据。公网、内网、本机地址按同一套规则读。
 *
 * 剩下的是传输上的规矩，这里自己执行：只要 http(s)，URL 里不带账号密码，长度有限，跳转次数有限，不跟随跨源跳转，
 * 每一跳解析一次 DNS、连接固定到解析出的地址（`pinnedLookup`），内容类型白名单，声明的 charset 必须认得。
 * body 流式读，超过上限当场断开，不先读完再判断大小。
 */

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { join } from "node:path";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { ToolDefinition, ToolOutput } from "@plume/contract";
import { htmlToText } from "./html-text.ts";

const MAX_BYTES = 2 * 1024 * 1024;
/** 整条结果（外壳、正文、截断标记）不超过这么多字：一次抓取在上下文里占的地方有上限。 */
const RESULT_MAX_CHARS = 37_400;
/** 正文上限，给外壳和截断标记留 2000 字。 */
const MAX_TEXT = RESULT_MAX_CHARS - 2000;
const TRUNCATED = "\n\n… [truncated]";
/** 真实的 URL 都够用；一兆的查询串不算 URL。 */
const MAX_URL_LENGTH = 2048;
/** 跳转次数。`http → https → www → 规范地址` 三次绰绰有余，更长的是循环或者在耍花样。 */
const MAX_REDIRECTS = 3;
/** 每一跳的时限，连接、响应头、正文都算在内。 */
const HOP_TIMEOUT_MS = 30_000;
const USER_AGENT = "Plume/0.1";

function errorResult(output: string): ToolOutput {
	return { output, isError: true };
}

/**
 * @param resolve 解析主机名，测试里换掉；默认是系统 DNS。
 */
export function webFetchTool(resolve: (hostname: string) => Promise<string[]> = resolveAll): ToolDefinition {
	return {
		name: "web_fetch",
		// i18n-exempt：发给模型的工具说明
		description:
			"Fetch a URL as readable text. Public, private and local addresses work; a redirect to another origin is refused, so fetch that address yourself.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "Absolute http(s) URL." },
				format: { type: "string", enum: ["text", "markdown", "raw"], description: "Output format. Default text." },
			},
			required: ["url"],
			additionalProperties: false,
		},
		mutating: false,

		async execute(args, run): Promise<ToolOutput> {
			if (typeof args.url !== "string" || args.url.trim().length === 0) return errorResult("`url` is required.");
			if (args.url.length > MAX_URL_LENGTH) return errorResult(`URL is longer than ${MAX_URL_LENGTH} characters.`);

			const first = await checkTarget(args.url, resolve);
			if ("error" in first) return errorResult(first.error);
			const origin = first.url.origin;

			let current = first.url;
			let addresses = first.addresses;
			let response: IncomingMessage;
			let deadline: AbortSignal;
			// 接了连接却永远不回的服务器，不设时限就会把这次调用一直挂到人按停止。
			const failure = (error: unknown) =>
				deadline.aborted && !run.signal.aborted
					? `Timed out after ${HOP_TIMEOUT_MS / 1000}s waiting for ${current.href}`
					: error instanceof Error
						? error.message
						: String(error);
			for (let hop = 0; ; hop++) {
				deadline = AbortSignal.timeout(HOP_TIMEOUT_MS);
				try {
					// 每一跳自己处理，跳转才守得住同源和次数。
					response = await get(current, addresses, AbortSignal.any([run.signal, deadline]));
				} catch (error) {
					return errorResult(`Request failed: ${failure(error)}`);
				}

				const status = response.statusCode ?? 0;
				const location = status >= 300 && status < 400 ? response.headers.location : undefined;
				if (!location) break;
				response.destroy();
				if (hop >= MAX_REDIRECTS) return errorResult(`Too many redirects (more than ${MAX_REDIRECTS}).`);

				let next: URL;
				try {
					next = new URL(location, current);
				} catch {
					return errorResult(`Redirected to an address that cannot be parsed: ${location}`);
				}
				/*
				 * 离开原来那个源的跳转拒绝，不跟。
				 *
				 * 对这次抓取做的判断是对那个源做的；跟到另一个源就把判断带到了没做过判断的地方，也是把抓一个公开网页变成
				 * 抓别的东西的捷径。让模型对新地址再调一次，多花一次调用，判断的粒度和目的地的粒度保持一致。
				 */
				if (next.origin !== origin) {
					return errorResult(
						`Refused a redirect that leaves the original origin (${origin} → ${next.origin}). Fetch ${next.href} explicitly if that is what you want.`,
					);
				}
				const checked = await checkTarget(next.href, resolve);
				if ("error" in checked) return errorResult(checked.error);
				current = checked.url;
				addresses = checked.addresses;
			}

			const status = response.statusCode ?? 0;
			if (status < 200 || status >= 300) {
				response.destroy();
				return errorResult(`HTTP ${status} ${response.statusMessage ?? ""} for ${current}`);
			}

			const contentType = response.headers["content-type"] ?? "";
			const kind = classifyContentType(contentType);
			if (!kind) {
				response.destroy();
				// 二进制读进来是一堆替换字符，花光这一轮的预算什么也没说；拒绝时说清原因。
				return errorResult(`Unsupported content type "${contentType || "(none)"}" — this tool reads text.`);
			}

			let buffer: Buffer;
			try {
				buffer = await readBody(response, MAX_BYTES);
			} catch (error) {
				return errorResult(failure(error));
			}

			let raw: string;
			try {
				raw = decoderFor(contentType).decode(buffer);
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}

			const text = args.format === "raw" || kind === "text" ? raw : htmlToText(raw);
			const open = `<fetched url="${current}" content-type="${contentType}">\n`;
			const close = "\n</fetched>";
			// 外壳里的 URL 和 content-type 长短由对方定，跳转后的地址也不受 MAX_URL_LENGTH 约束；外壳超出余量时从正文里扣，整条仍不越线。
			const room = Math.min(MAX_TEXT, RESULT_MAX_CHARS - open.length - close.length - TRUNCATED.length);
			const saved = text.length > room ? await saveFull(text, run.scratchDir) : undefined;
			// i18n-exempt：发给模型的工具结果
			const hint = saved ? `\n\n[full text: ${saved} (${text.length} characters) — read or grep it for the part after the cut]` : "";
			const limit = room - hint.length;
			const clipped = text.length > limit ? `${text.slice(0, limit)}${TRUNCATED}` : text;

			return {
				output: `${open}${clipped}${close}${hint}`,
				details: { kind: "web_fetch", url: current.toString(), status, bytes: buffer.byteLength, ...(saved ? { outputPath: saved } : {}) },
			};
		},
	};
}

/**
 * 截掉的部分存进会话临时目录的 `tool-output/`（和 bash 的完整输出同一处），模型要后半段时 read 或 grep 它，不必再抓一次。
 * 写不进去（磁盘满之类）就当没存：结果照样返回，只是少一句提示。
 */
async function saveFull(text: string, scratchDir: string): Promise<string | undefined> {
	try {
		const directory = join(scratchDir, "tool-output");
		await mkdir(directory, { recursive: true });
		const path = join(directory, `${randomUUID()}.log`);
		await writeFile(path, text, { flag: "wx", mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}

async function resolveAll(hostname: string): Promise<string[]> {
	const entries = await lookup(hostname, { all: true });
	return entries.map((entry) => entry.address);
}

/** 只看传输上的规矩：协议、账号密码。地址是公网、内网还是本机不影响能不能读。 */
function refusal(url: URL): string | undefined {
	// i18n-exempt：发给模型的拒绝理由
	if (url.protocol !== "http:" && url.protocol !== "https:") return `不支持的协议 ${url.protocol}`;
	if (url.username || url.password) return "地址里带着账号密码";
	return undefined;
}

/**
 * 校验 URL，再解析一次 DNS，这一跳的连接只去这些地址。
 *
 * 解析失败不当成拒绝：请求本来就会失败，DNS 的报错比一句规则拒绝说得更清楚。
 */
async function checkTarget(input: string, resolve: (hostname: string) => Promise<string[]>): Promise<{ url: URL; addresses: string[] } | { error: string }> {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return { error: `Not a valid URL: ${input}` };
	}

	const reason = refusal(url);
	if (reason) return { error: `Refused: ${reason} (${url.href})` };
	const addresses = await resolve(url.hostname).catch(() => [] as string[]);

	return { url, addresses };
}

/**
 * 连接只去判定过的地址：请求的 `lookup` 不再问 DNS，直接交回 `checkTarget` 解析出的那一组。
 * 主机名照旧放在请求里，所以 HTTPS 的 SNI、证书校验和 Host 头都还是原域名。字面 IP 不经过 `lookup`，它本身就是被判定的地址。
 * 解析失败时这里是空的，连接照样失败，不会再解析一次。
 */
function pinnedLookup(addresses: readonly string[]): LookupFunction {
	return (hostname, options, callback) => {
		const entries = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
		const wanted = options.family === 4 || options.family === 6 ? entries.filter((entry) => entry.family === options.family) : entries;
		const first = wanted[0];
		if (!first) {
			callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "", 4);
			return;
		}
		if (options.all) (callback as unknown as (error: null, entries: { address: string; family: number }[]) => void)(null, wanted);
		else callback(null, first.address, first.family);
	};
}

function get(url: URL, addresses: readonly string[], signal: AbortSignal): Promise<IncomingMessage> {
	const request = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const req = request(url, {
			method: "GET",
			lookup: pinnedLookup(addresses),
			// 不复用连接池：池里的连接按主机名找，可能连着上一次解析出的地址。
			agent: false,
			signal,
			headers: {
				"user-agent": USER_AGENT,
				accept: "text/html,text/plain,*/*",
				"accept-encoding": "gzip, deflate, br",
			},
		});
		req.once("response", resolve);
		req.once("error", reject);
		req.end();
	});
}

/** 流式读 body，解压后的字节超过上限就断开连接，不先把整个响应读进内存再判断。 */
async function readBody(response: IncomingMessage, limit: number): Promise<Buffer> {
	const tooLarge = () => new Error(`Response is larger than the ${limit / 1024 / 1024} MB limit.`);
	const declared = Number(response.headers["content-length"]);
	const encoding = String(response.headers["content-encoding"] ?? "identity")
		.trim()
		.toLowerCase();
	// 声明的长度是压缩后的，只有没压缩时能直接拿来判断。
	if (encoding === "identity" && Number.isFinite(declared) && declared > limit) {
		response.destroy();
		throw tooLarge();
	}
	const decoder =
		encoding === "gzip" || encoding === "x-gzip"
			? createGunzip()
			: encoding === "deflate"
				? createInflate()
				: encoding === "br"
					? createBrotliDecompress()
					: undefined;
	if (!decoder && encoding !== "identity") {
		response.destroy();
		throw new Error(`Unsupported content encoding "${encoding}".`);
	}
	const body: Readable = decoder ? pipeline(response, decoder, () => {}) : response;
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for await (const chunk of body) {
			size += (chunk as Buffer).length;
			if (size > limit) throw tooLarge();
			chunks.push(chunk as Buffer);
		}
	} finally {
		if (size > limit || !response.complete) {
			response.destroy();
			body.destroy();
		}
	}
	return Buffer.concat(chunks);
}

/** 这个工具能读成文字的几类正文。 */
function classifyContentType(contentType: string): "html" | "text" | undefined {
	const mime = contentType.replace(/;.*$/s, "").trim().toLowerCase();
	if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
	if (mime.startsWith("text/")) return "text";
	if (mime === "application/json" || mime === "application/xml" || mime.endsWith("+json") || mime.endsWith("+xml")) {
		return "text";
	}
	// 空的 content-type 不保证是文字；当成文字，一张 PNG 就成了几万个替换字符。
	return undefined;
}

/**
 * 按响应声明的 charset 解码。
 *
 * 声明了 `TextDecoder` 不认识的 charset 时报错，不退回 UTF-8：把 Shift_JIS 当 UTF-8 解出来是一页乱码，模型会很有把握地总结一堆噪音。
 * 报错说出是哪个 charset，人能据此处理。
 */
function decoderFor(contentType: string): InstanceType<typeof TextDecoder> {
	const charset = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1]?.trim().toLowerCase();
	if (!charset) return new TextDecoder("utf-8");
	try {
		return new TextDecoder(charset);
	} catch {
		throw new Error(`Unsupported charset "${charset}" — refusing rather than returning mojibake.`);
	}
}
