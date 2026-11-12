# 代管探针

测试用插件，验证插件代管会话的接口（`ctx.sessions.launch({ steward: true })`、`post`、`respond`、`answer`，见 [agent-extension.md](../../../agent-extension.md)）真能从插件里用起来。不随应用发，也不进插件市场；`pnpm smoke` 的 `steward` 段构建、装上它，开发者也可以手动装上试。

## 它做了什么

面板「代管探针」代替「Plume 之外的人」：

- **没有会话时**：写下第一句话、点「开代管会话」，开一个由本插件代管的新会话并转过去。标题栏写着「由 代管探针 代管」。
- **在会话里**：写一句话点「转进会话」，这句话排进会话的队（闲着就开一轮），气泡上标「代管探针 转来」。
- **弹着的卡**：会话里弹出审批卡或等人给数据的卡时，面板上也列出来：审批卡能「允许这一次」或「拒绝」，等人给数据的卡能「交回」（写 JSON，或一句话交成 `{ "answer": 这句话 }`）或「拒绝」。人在桌面上点和面板上答，先到的算；面板代答的那次调用底下写「由 代管探针 代答」。挂在这个会话下面的子会话（模型派的子智能体、人开的侧边聊天）弹的卡也列在这里、也能代答，卡上注明是子会话弹的。
- **模型的回复**：面板列出模型在这个会话里的回复。

卡和回复都是逻辑入口经 `ctx.sessions.observe` 收到的，不读面板自己的 `session`：真正把会话接到外面的插件也只能这样拿到。人在会话菜单里「停止代管」以后，面板上再转话、答卡都会显示本体的拒绝。

## 手动装上

```sh
plume-plugin build packages/testing/steward-probe
plume-plugin install packages/testing/steward-probe
```

装进 `~/.plume/local-plugins/steward-probe`，用完在插件市场里卸掉。
