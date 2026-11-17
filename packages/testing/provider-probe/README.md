# 供应商探针

测试用插件，验证插件提供模型供应商的接口（`ctx.providers.provide`，见 [agent-extension.md](../../../agent-extension.md)）真能从插件里用起来。不随应用发，也不进插件市场；`pnpm smoke` 的 `providers` 段构建、装上它，开发者也可以手动装上试。

## 它做了什么

启用时读数据目录（`~/.plume/plugin-data/example.provider-probe/`）里的 `providers.json`：一个供应商数组，字段同模型设置里的供应商，外加明文的 `apiKey`。这些供应商接在设置 › 模型的列表后面，标着由插件「供应商探针」提供；在设置页改连接、模型、开关或删除，都写回这份文件，不进 Plume 自己的 `settings.json`。文件只在启用时读一次，手改后要在插件市场停用再启用。

## 手动装上

```sh
plume-plugin build packages/testing/provider-probe
plume-plugin install packages/testing/provider-probe
```

装进 `~/.plume/local-plugins/provider-probe`，先写好 `providers.json` 再启用，用完在插件市场里卸掉。
