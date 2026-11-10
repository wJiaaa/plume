/**
 * 设置页的「测试连接」和「拉取模型」：用已经保存的设置真发请求，key 不出 agent 进程。
 *
 * 测试发的是一次和对话同样形状的请求，而不是只列模型：设置页真正想问的是「对话能不能通」，只有经适配器发出的
 * 请求才答得了——适配器才知道端点学到过什么（用哪个 token 字段、拒收哪些参数），手拼的请求体只能证明手拼的能通。
 */

import { streamAssistant } from "@plume/llm";
import { sessionHeaders } from "@plume/llm/cache-routing";
import { USER_AGENT } from "@plume/llm/endpoint";
import { failureOf } from "@plume/llm/failure";
import { imageDimensions } from "@plume/llm/image-dimensions";
import { isImageModel } from "@plume/llm/image-models";
import { generateImages } from "@plume/llm/images";
import type { AssistantMessage, ModelConfig, ProviderConfig, StreamEvent } from "@plume/llm/types";
import type { FetchModelsResult, ProviderTestResult } from "@plume/contract";
import { text } from "./i18n.ts";
import { providerConfig, type StoredProvider, thinkingFor } from "./models.ts";

/** 第一个 token 最多等多久。 */
const ANSWER_TIMEOUT_MS = 30_000;
const LISTING_TIMEOUT_MS = 15_000;

/** 列模型的地址：`/v1/models`，不管 baseUrl 末尾带没带 `/v1`。 */
function modelsUrl(provider: StoredProvider): string {
	const base = provider.baseUrl.replace(/\/+$/, "");
	return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

/** 鉴权加上端点要的会话头，和真实请求带的一样。列模型没有会话，给一个临时的——有的端点没有就拒绝。 */
function listingHeaders(provider: StoredProvider): Record<string, string> {
	const apiKey = provider.apiKey ?? "";
	return {
		"user-agent": USER_AGENT,
		...(provider.api === "anthropic-messages" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${apiKey}` }),
		...sessionHeaders(provider.baseUrl, undefined),
	};
}

/**
 * 测一个供应商：测整个供应商时先列一次模型（不花钱；很多中转不开放列表，所以列不出来不算失败），再用第一个对话模型真发一次请求。
 * 发请求用的是这个模型的默认思考档位，和新会话发的一样——思考参数正是 Chat Completions 后面的 Gemini 以前出错的地方。
 * 点名测生图模型时画一张小图：按张计费，所以只在人点了那一个模型时画。
 */
export async function testProvider(provider: StoredProvider, targetModelId: string | undefined): Promise<ProviderTestResult> {
	const started = Date.now();

	let models: string[] | undefined;
	if (!targetModelId) {
		try {
			const listed = await fetch(modelsUrl(provider), { headers: listingHeaders(provider), signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) });
			if (listed.ok) {
				const body = (await listed.json()) as { data?: { id?: string }[] };
				models = body.data
					?.map((model) => model.id ?? "")
					.filter(Boolean)
					.slice(0, 200);
			}
		} catch {
			models = undefined;
		}
	}

	const config = providerConfig(provider);
	const configured = config.models;
	const model = targetModelId
		? configured.find((candidate) => candidate.modelId === targetModelId)
		: (configured.find((candidate) => !isImageModel(candidate)) ?? configured[0]);
	if (!model) {
		if (targetModelId) return { ok: false, latencyMs: Date.now() - started, message: text("provider.modelNotFound") };
		return models
			? { ok: true, latencyMs: Date.now() - started, message: text("provider.listed", { n: models.length }), models }
			: { ok: false, latencyMs: Date.now() - started, message: text("provider.needModel") };
	}

	if (isImageModel(model)) return drawOnce(config, model);

	const reply = await firstToken(config, model);
	return reply.ok
		? { ok: true, latencyMs: reply.latencyMs, message: text("provider.responded", { model: model.name || model.modelId }), ...(models ? { models } : {}) }
		: { ok: false, latencyMs: reply.latencyMs, message: reply.message, ...(models ? { models } : {}) };
}

/** 试画一张最多等多久：出图比第一个 token 慢得多。 */
const DRAW_TIMEOUT_MS = 180_000;

/**
 * 生图模型的测试：真画一张小图。对话请求测不了它——中转对生图模型的对话请求直接拒；Images API 也没有不花钱的「能不能用」。
 * 最低画质、只试一次，画出来的图不留。
 */
async function drawOnce(provider: ProviderConfig, model: ModelConfig): Promise<ProviderTestResult> {
	const started = Date.now();
	try {
		const result = await generateImages(
			provider,
			model,
			// i18n-exempt：发给生图模型的提示词
			{ prompt: "A single small red dot on a plain white background.", quality: "low" },
			{ retryAttempts: 1, signal: AbortSignal.timeout(DRAW_TIMEOUT_MS) },
		);
		const bytes = Buffer.from(result.images[0]?.data ?? "", "base64");
		const dims = imageDimensions(bytes);
		const size = dims ? `${dims.width}×${dims.height}` : `${Math.max(1, Math.round(bytes.length / 1024))} KB`;
		return { ok: true, latencyMs: Date.now() - started, message: text("provider.drew", { model: model.name || model.modelId, size }) };
	} catch (error) {
		const failure = failureOf(error);
		return { ok: false, latencyMs: Date.now() - started, message: [failure.summary, failure.detail?.slice(0, 300)].filter(Boolean).join(" · ") };
	}
}

/** 算作端点开始回答的事件。推理也算：那是思考模型的第一段输出。 */
const ANSWERED: ReadonlySet<StreamEvent["type"]> = new Set(["text_delta", "thinking_delta", "toolcall_start"]);

/**
 * 像对话那样发一次请求，拿到第一个 token 就停：只花几个 token，延迟也正是人感受到的「多久开始回复」。
 * 只试一次：重试是给对话扛抖动的，测试应该把抖动报出来。
 */
async function firstToken(
	provider: ProviderConfig,
	model: ModelConfig,
): Promise<{ ok: true; latencyMs: number } | { ok: false; latencyMs: number; message: string }> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, ANSWER_TIMEOUT_MS);
	const started = Date.now();
	let answeredAt: number | undefined;
	let final: AssistantMessage | undefined;
	const noAnswer = () => text("provider.noAnswer", { seconds: ANSWER_TIMEOUT_MS / 1000 });
	try {
		const thinking = thinkingFor(model, undefined);
		const stream = streamAssistant(
			provider,
			model,
			{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: started }], tools: [] },
			{ signal: controller.signal, thinking, retryAttempts: 1 },
		);
		// 读到结束而不是丢下不管，让适配器走它自己的中止路径收尾。
		for (;;) {
			const next = await stream.next();
			if (next.done) {
				final = next.value;
				break;
			}
			if (answeredAt === undefined && ANSWERED.has(next.value.type)) {
				answeredAt = Date.now();
				controller.abort();
			}
		}
	} catch (error) {
		return { ok: false, latencyMs: Date.now() - started, message: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
	if (answeredAt !== undefined) return { ok: true, latencyMs: answeredAt - started };
	const latencyMs = Date.now() - started;
	if (timedOut) return { ok: false, latencyMs, message: noAnswer() };
	if (final && final.stopReason !== "error" && final.stopReason !== "aborted") return { ok: true, latencyMs };
	return { ok: false, latencyMs, message: final?.errorMessage ?? final?.failure?.summary ?? noAnswer() };
}

/** 从供应商的 `/v1/models` 拉模型 id。认三种返回：OpenAI 的 `data`、有的中转的 `models`、直接一个字符串数组。 */
export async function fetchModels(provider: StoredProvider): Promise<FetchModelsResult> {
	try {
		const response = await fetch(modelsUrl(provider), { headers: listingHeaders(provider), signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) });
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 200);
			return { ok: false, models: [], error: `HTTP ${response.status}: ${detail || text("provider.listFailed")}` };
		}
		const body = (await response.json()) as { data?: { id?: string }[] } | { models?: { id?: string; name?: string }[] } | string[];
		let models: string[] = [];
		if (Array.isArray(body)) models = body.filter((model): model is string => typeof model === "string");
		else if (body && "data" in body && Array.isArray(body.data)) models = body.data.map((model) => model.id ?? "").filter(Boolean);
		else if (body && "models" in body && Array.isArray(body.models)) models = body.models.map((model) => model.id ?? model.name ?? "").filter(Boolean);
		models.sort((a, b) => a.localeCompare(b));
		return { ok: true, models };
	} catch (error) {
		return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
	}
}
