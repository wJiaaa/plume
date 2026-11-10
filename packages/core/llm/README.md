# @plume/llm

模型调用：Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 三种协议的流式适配，
以及重试、失败分类、思考档位、用量与价格。

代码在 `src/ai/`，连同它依赖的消息与服务商类型、`utils/sse.ts`、`utils/record.ts`、`utils/pricing.ts`、`config/retry-policy.ts` 和对应的测试。
`src/types/tool.ts` 只有 `ToolSpec` 和 `JsonSchema`：工具运行时不属于模型调用。

模型目录：`model-catalog.ts`、`model-catalog-format.ts`、`catalog/`（打包的快照和它的说明）。拉取和缓存在 `@plume/agent` 的 `model-catalog-sync.ts`，
缓存在 `~/.plume/model-catalog.json`，快照用仓库根目录的 `pnpm catalog:update` 刷新。

生图：`images/`（Images API 与 chat 两条路、比例和画质的各家说法、额度用完的判断、读图片头的宽高）、
`config/image-models.ts`（哪些模型是生图模型、一次调用指的是哪个），以及测试 `test/image-generate.test.ts`。
`images/types.ts` 后半段的 `ImagePointer`、`ImageGenerateDetails` 这里没人用。

入口是 `streamAssistant(provider, model, context, options)`：逐个产出流式事件，最后返回完整的助手消息。
测试连接、拉模型列表要发和对话一样的请求头，所以 `package.json` 另外导出了 `./endpoint`（`USER_AGENT`）和 `./cache-routing`（`sessionHeaders`）；生图从 `./images`（`generateImages`）、
`./image-models`、`./image-dimensions`、`./image-types` 进来。
压缩从主请求分叉写摘要时要核对这一次请求体的前缀和上一次一样、要知道这家服务商的缓存能留多久，所以还导出了 `./prefix-fingerprint`
（`payloadSegments`、`comparePrefix`，在 `src/ai/prefix-fingerprint.ts`）和 `./vendors`（`cacheHotMs`）。
这个包不依赖 Plume 内核，由 `plume.agent` 插件在 node 运行域里直接调用。

测试：`pnpm --filter @plume/llm test`。
