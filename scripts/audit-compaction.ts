/**
 * 压缩之后丢了多少，以及缓存隔多久还读得到。`session-audit.ts` 第 13、14 节。
 *
 * 第 13 节量压缩丢了多少。折叠掉的那段里读过、之后没改过的文件，压缩后又被 `read` 一遍，说明摘要和保留的尾部都没让模型确信它
 * 已经知道——这是摘要质量里唯一不靠人工判读的信号。`recall` 是另一面：原文还在，模型知道去取。用户把话再说一遍是第三面，量找不回
 * 的丢失。每个会话（含子会话）各量各的。
 *
 * 第 14 节给分叉摘要的「缓存还热」那条线（plume.compaction 的 `FORK_HOT_MS`）找依据：同一前缀隔了多久，服务商还读得到。
 */

import { KEEP_MIN } from "../packages/builtin/compaction/src/budget.ts";
import { FORK_HOT_MS } from "../packages/builtin/compaction/src/fork.ts";
import { estimateTokens } from "../packages/builtin/compaction/src/tokens.ts";
import type { Message, UsageCacheMissCause } from "../packages/contract/src/index.ts";
import { CACHE_NOISE_FLOOR_TOKENS } from "../packages/core/agent/src/usage-record.ts";

interface AuditCall {
	id: string;
	name: string;
	args: unknown;
	/** 发出它的那条助手消息在 `messages` 里的下标。 */
	at: number;
}

/** 一次写下边界的压缩：`at` 是压缩时已有多少条消息，`kept` 是从新往旧数原样留下的条数。 */
export interface AuditBoundary {
	at: number;
	kept: number;
}

export interface AuditStream {
	messages: Message[];
	/** 按会话里的顺序。 */
	calls: AuditCall[];
	boundaries: AuditBoundary[];
	resultChars(callId: string): number;
}

const median = (values: number[]) => (values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1]! : 0);

function pathOf(call: AuditCall): string | undefined {
	const args = call.args as { path?: unknown; file_path?: unknown } | undefined;
	const path = args?.path ?? args?.file_path;
	return typeof path === "string" ? path : undefined;
}

/**
 * 用户在压缩后不得不把话再说一遍：提到「之前说过」，或者折叠掉的某句原话又出现了。
 *
 * 重读文件量的是能找回的丢失；这一项量的是找不回的那种——约束、纠正、放弃过的路线只在用户的话里，摘要漏了，模型不会知道，
 * 只有用户会发现。关键词和字面相似都是启发式，只看改动前后的趋势。
 */
const REFER_BACK =
	/(之前说过|我说过|前面说过|之前说的|早就说|已经说过|一开始就说|上面说过|跟你说过|不是说了|I (?:already )?(?:said|told you)|as I said|I mentioned)/i;
/** 短于这个的不比相似度：「继续」「好的」本来就会反复说。 */
const RESTATE_MIN_CHARS = 12;
const RESTATE_SIMILARITY = 0.6;

function userText(message: Message): string | undefined {
	if (message.role !== "user" || message.synthetic) return undefined;
	const text = message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();
	return text || undefined;
}

function bigrams(text: string): Set<string> {
	const points = [...text.toLowerCase().replace(/[\s\p{P}]+/gu, "")];
	const out = new Set<string>();
	for (let at = 0; at + 1 < points.length; at++) out.add(points[at]! + points[at + 1]!);
	return out;
}

/** Dice 系数：两段话的二元组重合了多少。 */
export function restates(text: string, earlier: string): boolean {
	if ([...text].length < RESTATE_MIN_CHARS || [...earlier].length < RESTATE_MIN_CHARS) return false;
	const a = bigrams(text);
	const b = bigrams(earlier);
	if (a.size === 0 || b.size === 0) return false;
	let shared = 0;
	for (const gram of a) if (b.has(gram)) shared++;
	return (2 * shared) / (a.size + b.size) >= RESTATE_SIMILARITY;
}

export function afterCompaction(streams: AuditStream[]) {
	const kept: number[] = [];
	const tailTokens: number[] = [];
	let reads = 0;
	let foldedRereads = 0;
	let foldedRereadChars = 0;
	let recalls = 0;
	let userAfter = 0;
	let repeatedAfter = 0;
	for (const stream of streams) {
		const edits = stream.calls.filter((call) => call.name === "edit" || call.name === "write");
		stream.boundaries.forEach((boundary, index) => {
			const keptFrom = Math.max(0, boundary.at - boundary.kept);
			const until = stream.boundaries[index + 1]?.at ?? Number.POSITIVE_INFINITY;
			kept.push(boundary.kept);
			const folded = stream.messages
				.slice(0, keptFrom)
				.map(userText)
				.filter((text): text is string => text !== undefined);
			const nextAt = stream.boundaries[index + 1]?.at ?? stream.messages.length;
			for (const message of stream.messages.slice(boundary.at, nextAt)) {
				const text = userText(message);
				if (text === undefined) continue;
				userAfter++;
				if (REFER_BACK.test(text) || folded.some((earlier) => restates(text, earlier))) repeatedAfter++;
			}
			tailTokens.push(estimateTokens(stream.messages.slice(keptFrom, boundary.at)));
			// 折叠掉的那段里每个文件最后一次读在哪；保留的尾部里读过的，压缩后还看得见，不算。
			const lastFolded = new Map<string, number>();
			const visible = new Set<string>();
			for (const call of stream.calls) {
				if (call.at >= boundary.at) break;
				const path = call.name === "read" ? pathOf(call) : undefined;
				if (path === undefined) continue;
				if (call.at < keptFrom) lastFolded.set(path, call.at);
				else visible.add(path);
			}
			const decided = new Set<string>();
			for (const call of stream.calls) {
				if (call.at < boundary.at || call.at >= until) continue;
				if (call.name === "recall") recalls++;
				if (call.name !== "read") continue;
				reads++;
				const path = pathOf(call);
				const last = path === undefined ? undefined : lastFolded.get(path);
				// 每个文件只看压缩后的第一次读；再往后的重读归第 3 节。
				if (path === undefined || last === undefined || visible.has(path) || decided.has(path)) continue;
				decided.add(path);
				// 中间改过的，内容确实变了，重读是对的。
				if (edits.some((edit) => pathOf(edit) === path && edit.at > last && edit.at < call.at)) continue;
				foldedRereads++;
				foldedRereadChars += stream.resultChars(call.id);
			}
		});
	}
	return {
		boundaries: kept.length,
		keptMedian: median(kept),
		keptMin: kept.length ? Math.min(...kept) : 0,
		keptBelowMin: kept.filter((count) => count < KEEP_MIN).length,
		tailTokensMedian: median(tailTokens),
		reads,
		foldedRereads,
		foldedRereadChars,
		recalls,
		userAfter,
		repeatedAfter,
	};
}

const minutes = (ms: number) => `${+(ms / 60_000).toFixed(1)}m`;

/** 分桶的上沿（毫秒）。第二道线就是 `FORK_HOT_MS`，桶照着它切才看得出线两侧的差别。 */
export const LIFETIME_BUCKETS = [
	{ label: "≤1m", to: 60_000 },
	{ label: `1m–${minutes(FORK_HOT_MS)}`, to: FORK_HOT_MS },
	{ label: `${minutes(FORK_HOT_MS)}–10m`, to: 600_000 },
	{ label: "10m–1h", to: 3_600_000 },
	{ label: ">1h", to: Number.POSITIVE_INFINITY },
] as const;

/** 一次有上一次可比的主请求：花销表里记下的缓存诊断，加上它和上一次之间隔了多久。 */
export interface LifetimeRequest {
	model: string;
	idleMs: number;
	/** 理应从缓存读到的前缀：上一次和这一次输入总量里小的那个。 */
	expected: number;
	/** `hit` 是读到了缓存、没记下未命中；其余是记下的未命中原因（`diagnoseCache`）。 */
	cause: "hit" | UsageCacheMissCause;
}

interface LifetimeCell {
	hit: number;
	/** 本地前缀核对过没变，服务商没读到。 */
	lost: number;
	/** 分不清是谁的问题：这次请求没有前缀指纹（重启后的第一次），或者变的是 thinking 档位这类参数。 */
	unproven: number;
}

/**
 * 每个模型、每个间隔桶里，本该命中的请求有几次真的命中。
 *
 * 按模型而不是服务商分：走本地中转时服务商只有一个，缓存寿命取决于中转背后的上游。
 *
 * 只数前缀有理由命中的那些：压缩、撤回、换模型和本地改写都不算，它们没命中不说明缓存寿命。
 */
export function cacheLifetime(requests: readonly LifetimeRequest[]): Map<string, LifetimeCell[]> {
	const byModel = new Map<string, LifetimeCell[]>();
	for (const request of requests) {
		if (request.expected <= CACHE_NOISE_FLOOR_TOKENS) continue;
		const kind = request.cause === "hit" ? "hit" : request.cause === "provider" ? "lost" : request.cause === "unknown" ? "unproven" : undefined;
		if (!kind) continue;
		let cells = byModel.get(request.model);
		if (!cells) byModel.set(request.model, (cells = LIFETIME_BUCKETS.map(() => ({ hit: 0, lost: 0, unproven: 0 }))));
		cells[LIFETIME_BUCKETS.findIndex((bucket) => request.idleMs <= bucket.to)]![kind]++;
	}
	return byModel;
}
