/**
 * 插件的 `ctx.model.findImageModel` 和 `ctx.model.image`：用人配好的生图模型画图、改图。
 *
 * 走哪个端点、比例和画质怎么跟各家说在 `@plume/llm/images`；这里只管按设置找模型、把 key 留在这个进程里，
 * 再把结果和失败换成插件看得懂的样子。图存不存、存哪、怎么跟模型说，是调用的插件的事。
 */

import type { ImageModel, ImageModelMatch, ModelImageRequest, ModelImageResult } from "@plume/contract";
import { failureOf } from "@plume/llm/failure";
import { imageDimensions, sniffImageType } from "@plume/llm/image-dimensions";
import { isImageModel, resolveImageModel } from "@plume/llm/image-models";
import { generateImages } from "@plume/llm/images";
import type { ImageRequest } from "@plume/llm/image-types";
import type { ModelConfig, ProviderConfig } from "@plume/llm/types";
import { text } from "./i18n.ts";
import { lookup, providerConfig, type StoredSettings } from "./models.ts";

/**
 * 每张图最多试几次，第一次算在内——固定值，不跟设置里的重试策略。
 *
 * 那套策略是给对话写的：「网没好就一直等」对一句等着看的回复是对的。出图是一次付费调用，生图模型真正会给的失败是
 * 额度用完、几小时后才重置，无限重试会让这一轮一直挂着。重试两次够躲开一次抖动，再长就该如实报出来。
 */
const IMAGE_ATTEMPTS = 3;
const QUALITIES = new Set(["low", "medium", "high", "max"]);

const view = (provider: ProviderConfig, model: ModelConfig): ImageModel => ({
	id: model.id,
	name: model.name,
	modelId: model.modelId,
	provider: provider.name,
});

export function findImageModel(settings: StoredSettings, name: string | undefined): ImageModelMatch {
	const asked = typeof name === "string" && name.trim() ? name.trim() : undefined;
	const found = resolveImageModel(settings.providers.map(providerConfig), settings.imageModel ?? null, asked);
	if (found.row) return { model: view(found.row.provider, found.row.model) };
	return { reason: found.reason, candidates: found.candidates.map((row) => view(row.provider, row.model)) };
}

export async function drawImages(settings: StoredSettings, request: ModelImageRequest): Promise<ModelImageResult> {
	const ref = String(request.model);
	const found = lookup(settings, ref);
	if (!found) throw new Error(text("model.unavailable", { model: ref }));
	if (!isImageModel(found.model)) throw new Error(text("model.notImage", { model: found.model.name }));
	if (found.provider.api === "anthropic-messages") throw new Error(text("model.cannotDraw", { model: found.model.name }));
	if (!found.provider.apiKey) throw new Error(text("model.noKey", { name: found.provider.name }));
	const provider = providerConfig(found.provider);
	const model = provider.models.find((candidate) => candidate.id === ref);
	if (!model) throw new Error(text("model.unavailable", { model: ref }));

	const asked: ImageRequest = {
		prompt: String(request.prompt),
		...(request.images?.length ? { images: request.images.map(({ data, mimeType, name }) => ({ data, mimeType, ...(name ? { name } : {}) })) } : {}),
		...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
		...(request.quality && QUALITIES.has(request.quality) ? { quality: request.quality } : {}),
		...(request.count ? { count: request.count } : {}),
		...(request.background === "transparent" || request.background === "opaque" ? { background: request.background } : {}),
	};
	try {
		const result = await generateImages(provider, model, asked, {
			...(request.signal ? { signal: request.signal } : {}),
			retryAttempts: IMAGE_ATTEMPTS,
			onRetry: (info) => request.onRetry?.({ attempt: info.attempt, delayMs: info.delayMs, reason: info.reason }),
		});
		return {
			ok: true,
			images: result.images.map((image) => {
				const bytes = Buffer.from(image.data, "base64");
				return { data: image.data, mimeType: sniffImageType(bytes) ?? image.mimeType, ...imageDimensions(bytes) };
			}),
			route: result.route,
			...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
			...(result.failures?.length ? { failures: result.failures } : {}),
		};
	} catch (error) {
		if (request.signal?.aborted) throw error;
		const failure = failureOf(error);
		const detail = failure.detail ?? (error instanceof Error ? error.message : String(error));
		return {
			ok: false,
			failure: {
				summary: failure.summary,
				...(detail ? { detail: detail.slice(0, 2000) } : {}),
				...(failure.hint ? { hint: failure.hint } : {}),
				...(failure.retryAfterMs ? { retryAfterMs: failure.retryAfterMs } : {}),
			},
		};
	}
}
