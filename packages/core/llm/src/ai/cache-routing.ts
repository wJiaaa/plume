/**
 * 缓存路由键（`RequestOptions.cacheKey`）怎么带给服务商。
 *
 * 缓存命中是按机器算的。同一条对话前缀的请求被负载均衡打散到别的机器、号池中转换了一个上游账号，
 * 前缀再一样也是全价重算。路由键就是告诉服务商「这几次请求是同一条对话，送到同一处」。
 *
 * 不按端点区分，每个请求都带同一套，一共这几项：
 *
 *   - OpenAI 系两条链：请求头 `x-session-id`（OpenRouter 的粘性路由键）、
 *     请求头 `session_id`（Codex CLI 发的；sub2api 一类号池选账号先看它，其次 `conversation_id` 头和
 *     `prompt_cache_key`，都没有就随机分，见 Wei-Shaw/sub2api#1421）、请求体 `prompt_cache_key`
 *     （OpenAI 官方字段，Kimi、通用中转也认）。未知请求头各家都是忽略；严格端点对未知的请求体字段
 *     会 400 并点名它，撞一次就学会不发（`request-params-compat.ts` 的 `cache-key`），两个头照带。
 *   - Anthropic 协议：请求体 `metadata.user_id`，写成 Claude Code 的 JSON，
 *     Claude 号池类中转按其中的 `session_id` 粘住账号。缓存本身仍由
 *     `cache_control` 断点声明。
 *
 * 端点硬性要求的会话头（例如 OpenCode Go 的 `x-opencode-session`，缺了直接 400）另见 `sessionHeaders`：
 * 三种协议都带，没有 `cacheKey` 时也带。
 */

import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import type { DroppedParam } from "./request-params-compat.ts";

/** 这次请求要加到请求体和请求头里的东西。 */
export interface CacheRouting {
	body: Record<string, string>;
	headers: Record<string, string>;
}

const NONE: CacheRouting = Object.freeze({ body: Object.freeze({}), headers: Object.freeze({}) }) as CacheRouting;

/** `prompt_cache_key` 的上限，同 pi openai-prompt-cache.ts。 */
const BODY_KEY_MAX = 64;
/** 请求头的上限，取 OpenRouter `x-session-id` 的 256。 */
const HEADER_KEY_MAX = 256;

/** FNV-1a 32 位，两个种子拼成 16 位十六进制。只求稳定、分散，不求抗碰撞攻击——键本身不是秘密。 */
function digest(text: string): string {
	const run = (seed: number) => {
		let hash = seed;
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return (hash >>> 0).toString(16).padStart(8, "0");
	};
	return run(0x811c9dc5) + run(0x050c5d1f);
}

/**
 * 键放得进这个位置就原样用；放不进（超长，或有请求头容不下的字符）就压成「可读前缀-摘要」。
 *
 * 不照抄 pi 的截断：主会话 `<会话 id>` 和子代理 `<会话 id>-sub-<n>` 这类共享长前缀的键，截到 64 字符
 * 后会变成同一个，子代理和主会话被路由成同一条对话。摘要取的是整条键，区分得开。
 * 请求头的值必须是可见 ASCII，否则 `fetch` 直接抛 TypeError——整个请求发不出去。
 */
export function fitKey(key: string, maxLength: number): string {
	if (key.length <= maxLength && /^[\x21-\x7e]+$/.test(key)) return key;
	const hash = digest(key);
	const head = key.replace(/[^\x21-\x7e]/g, "").slice(0, Math.max(0, maxLength - hash.length - 1));
	return head ? `${head}-${hash}` : hash.slice(0, maxLength);
}

/**
 * OpenAI 系两条链这次该带什么。没有 `cacheKey` 返回空；请求体字段被这个模型拒过就只带请求头。
 */
export function cacheRouting(cacheKey: string | undefined, dropped: ReadonlySet<DroppedParam>): CacheRouting {
	if (!cacheKey) return NONE;
	const header = fitKey(cacheKey, HEADER_KEY_MAX);
	return {
		body: dropped.has("cache-key") ? {} : { prompt_cache_key: fitKey(cacheKey, BODY_KEY_MAX) },
		headers: { "x-session-id": header, session_id: header },
	};
}

let device: string | undefined;

/**
 * 这台机器的设备 id：64 位十六进制，形状同 Claude Code 的 `device_id`。
 *
 * 由主机名和用户目录算出来而不是随机生成再存盘：同一台机器上每次启动都是同一个，不用读写文件，
 * 也不带出任何可读的本机信息。主机名改了它跟着变，代价只是那之后的第一轮缓存路由换一处。
 */
function deviceId(): string {
	device ??= createHash("sha256").update(`plume-device\0${hostname()}\0${homedir()}`).digest("hex");
	return device;
}

/** Anthropic 协议这次该在请求体里加什么。没有 `cacheKey` 返回空，请求和从前一样。 */
export function anthropicMetadata(cacheKey: string | undefined): { metadata?: { user_id: string } } {
	if (!cacheKey) return {};
	return {
		metadata: {
			user_id: JSON.stringify({ device_id: deviceId(), account_uuid: "", session_id: fitKey(cacheKey, BODY_KEY_MAX) }),
		},
	};
}

/** OpenCode Go 的地址：目录里 `/zen/go` 和 `/zen/go/v1` 两种写法都有。Zen（`/zen/v1`）不要求会话头。 */
function isOpenCodeGo(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		const host = url.hostname.toLowerCase();
		const path = url.pathname.replace(/\/+$/, "").toLowerCase();
		return (host === "opencode.ai" || host.endsWith(".opencode.ai")) && (path === "/zen/go" || path === "/zen/go/v1");
	} catch {
		return false;
	}
}

/**
 * 端点硬性要求的会话头。三种协议都走这里，Anthropic 协议也不例外——
 * 这不是可选的路由提示，缺了请求就发不出去。
 *
 * 目前只有 OpenCode Go 的 `x-opencode-session`（缺了直接 400），写死。
 * 没有 `cacheKey`（压缩、测试连接这类一次性请求）时换成一个随机 id 而不是不带：随机 id 只是失去路由，
 * 请求照样能发。调用方每次请求算一次，重试沿用同一个结果。
 */
export function sessionHeaders(baseUrl: string, cacheKey: string | undefined): Record<string, string> {
	if (!isOpenCodeGo(baseUrl)) return {};
	return { "x-opencode-session": fitKey(cacheKey || randomUUID(), 256) };
}
