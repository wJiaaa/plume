/**
 * 评测用哪个模型：读 Plume 自己的设置和 key 存放处（`PLUME_HOME`，默认 `~/.plume`），和应用走同一条解析路径。
 *
 * 评测自己不另读 key：认证方式和产品不一样的评测，可能产品坏了它照样通过。key 只在进程内交给 `@plume/llm`，不打印、不落盘。
 * 要换一套设置（比如另一台机器拷来的、或者只放了一个测试用供应商的目录），设 `PLUME_HOME` 指过去。
 *
 * 模型 id 写成设置里的 `<供应商 id>/<模型 id>`；不给就用设置里的默认模型。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelConfig, ProviderConfig } from "../../packages/core/llm/src/types.ts";
import { lookup, normalizeSettings, resolveModel, type StoredSettings } from "../../packages/core/agent/src/models.ts";
import { createVault, providerKeys } from "../../packages/core/agent/src/vault.ts";

export interface EvalModel {
	provider: ProviderConfig;
	model: ModelConfig;
	settings: StoredSettings;
}

function plumeHome(): string {
	return process.env.PLUME_HOME || join(homedir(), ".plume");
}

export async function loadModel(id?: string): Promise<EvalModel> {
	const home = plumeHome();
	const raw = await readFile(join(home, "settings.json"), "utf8").then(
		(text) => JSON.parse(text) as unknown,
		() => undefined,
	);
	const settings = await providerKeys(createVault(home)).withKeys(normalizeSettings(raw));
	// 点了名却不存在时不悄悄换成默认模型：那样跑出来的数字记在一个没跑过的模型名下。
	if (id && !lookup(settings, id)) {
		const ids = settings.providers.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.modelId}`));
		throw new Error(`设置里没有模型 ${id}（${home}）。可用的：${ids.slice(0, 8).join(", ") || "（没有）"}`);
	}
	return { ...resolveModel(settings, id), settings };
}
