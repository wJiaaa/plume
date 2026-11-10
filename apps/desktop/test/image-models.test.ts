/**
 * 生图模型在界面这边的规则：拉进来的生图模型不号称会思考、调工具；「第一个模型当默认」跳过它。
 * 选择器按类过滤（`model-grouping.ts` 的 `groupModels`）引了 `@plume/ui`，Node 直接跑不了 .tsx，不在这里测。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelConfig } from "../src/renderer/models/store.ts";
import { importedModel } from "../src/renderer/settings/models/model-defaults.ts";
import { firstChatModelId } from "../src/renderer/settings/models/model-sync.ts";

const provider = { id: "relay", baseUrl: "https://relay.example" };
const model = (modelId: string): ModelConfig => importedModel(provider, modelId);
test("拉进来的生图模型只认图片输入，不号称会思考、调工具", () => {
	const drawn = importedModel(provider, "gemini-3.1-flash-image");
	assert.equal(drawn.supportsThinking, false);
	assert.equal(drawn.supportsTools, false);
	assert.equal(drawn.supportsImages, true);
});

test("第一个能对话的模型跳过生图模型", () => {
	assert.equal(firstChatModelId([model("gemini-3.1-flash-image"), model("gpt-5")]), "relay/gpt-5");
	assert.equal(firstChatModelId([model("gpt-image-1")]), null);
});
