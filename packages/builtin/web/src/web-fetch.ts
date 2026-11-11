/**
 * 读一个网页，不用为读网页问人。
 *
 * GET 在这台机器上什么都不改：不写文件、不起进程、不碰项目，影响只是一份 token 预算，所以不是 mutating。
 * 真正的风险是回来的内容——写给抓取它的模型当指令读的网页。审批卡上显示一个 URL 防不了这个（做决定时内容还不在屏幕上），
 * 防线在下游：正文用 `<fetched>` 包起来、标成数据。公网、内网、本机地址按同一套规则读。
 *
 * 剩下的是传输上的规矩，这里自己执行：只要 http(s)，URL 里不带账号密码，长度有限，跳转次数有限，不跟随跨源跳转，
 * 内容类型白名单，声明的 charset 必须认得。
 * body 流式读，超过上限当场断开，不先读完再判断大小。
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
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

export function webFetchTool(): ToolDefinition {
	return {
		name: "web_fetch",
		// i18n-exempt：发给模型的工具说明
		description:
			"Fetch a URL as readable text. Public, private and local addresses work; a redirect to another origin is refused, so fetch that address yourself.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "Absolute http(s) URL." },
				format: { type: "string", enum: ["text", "raw"], description: "Output format. Default text." },
			},
			required: ["url"],
			additionalProperties: false,
		},
		mutating: false,

		async execute(args, run): Promise<ToolOutput> {
			if (typeof args.url !== "string" || args.url.trim().length === 0) return errorResult("`url` is required.");
			if (args.url.length > MAX_URL_LENGTH) return errorResult(`URL is longer than ${MAX_URL_LENGTH} characters.`);

			const first = checkTarget(args.url);
			if ("error" in first) return errorResult(first.error);
			const origin = first.url.origin;

			let current = first.url;
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
					response = await get(current, AbortSignal.any([run.signal, deadline]));
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
				const checked = checkTarget(next.href);
				if ("error" in checked) return errorResult(checked.error);
				current = checked.url;
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

/** 只看传输上的规矩：协议、账号密码。地址是公网、内网还是本机不影响能不能读。 */
function refusal(url: URL): string | undefined {
	// i18n-exempt：发给模型的拒绝理由
	if (url.protocol !== "http:" && url.protocol !== "https:") return `不支持的协议 ${url.protocol}`;
	if (url.username || url.password) return "地址里带着账号密码";
	return undefined;
}

function checkTarget(input: string): { url: URL } | { error: string } {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return { error: `Not a valid URL: ${input}` };
	}
	const reason = refusal(url);
	return reason ? { error: `Refused: ${reason} (${url.href})` } : { url };
}

function get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
	const request = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const req = request(url, {
			method: "GET",
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
