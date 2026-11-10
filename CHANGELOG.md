# 更新日志

这个文件由 `pnpm release` 生成，条目来自提交信息。写得含糊的提交在这里也含糊，所以值得在提交时就写清楚。

## [0.1.2] - 2026-11-10

<!-- plume:notes en -->
### Changes

- **Skills and connectors in the marketplace.** The sidebar's "Extensions" is now called "Marketplace", and besides plugins you can add skill collections and connectors (MCP servers) from it. Skills work as soon as they're installed; for a connector, fill in the values it asks for on its card and it connects. Optional values can be left empty, and anything you filled in can be changed or cleared later.
- **Links to temporary files in replies now open.** When Plume saved a report or the full output of a long command to the conversation's temporary folder, the file link in its reply did nothing. It now opens. A conversation also can no longer change or delete another conversation's temporary files without asking you.
- **The About page looks like it used to.** The app icon, version and "Check for Updates" are back at the top, and the update indicator shows a spinning arc again while an update is being prepared.
- Tooltips on the buttons of a notification banner are no longer hidden behind the banner.
- In Magpie's Agent page, the Plume icon is now the same size as the other app icons.

### For plugin authors

- The plugin SDK is on npm as `@plumeai/plugin-sdk`, so a plugin project can depend on it by version (`npm i -D @plumeai/plugin-sdk`).
- `plume-plugin check` now also checks the plugin rules besides types: imports only from the public interfaces, colors and styles only from theme tokens, and no hard-coded interface text.

<!-- plume:notes zh-CN -->
### 改动

- **插件市场里能添加技能和连接器了。** 侧栏的「扩展」改名为「插件市场」，除了插件，还能在这里添加技能合集和连接器（MCP 服务）。技能装上就能用；连接器装上后，在它的卡片里填好要求的值就能连上。可选的值可以不填，填过的也能随时改或清掉。
- **回复里指向临时文件的链接能点开了。** 以前 Plume 把报告、长命令的完整输出存进会话的临时目录后，回复里的文件链接点了没反应，现在能打开。另外，一个对话不能再不经过你就改、删别的对话的临时文件。
- **关于页恢复成原来的样子。** 顶上重新是应用图标、版本号和「检查更新」；准备更新时，更新圆点上重新有一段转动的弧线。
- 提示条上按钮的悬停说明不再被提示条挡住。
- 在 Magpie 的 Agent 页里，Plume 的图标不再比别的应用小一圈。

### 给插件作者

- 插件 SDK 发布到了 npm，包名 `@plumeai/plugin-sdk`，插件项目可以按版本依赖它（`npm i -D @plumeai/plugin-sdk`）。
- `plume-plugin check` 除了类型检查，也查插件规则：只引用公开接口，颜色和样式只用主题 token，界面文字不写死。

## [0.1.1] - 2026-11-10

<!-- plume:notes en -->
### Changes

- **macOS permissions now survive updates.** Earlier builds lost Screen Recording, Accessibility and similar permissions every time you installed a new version. Plume is now signed with a fixed certificate, so macOS treats each update as the same app. Moving from an earlier build to this one asks for those permissions one last time.
- **Updates arrive inside the app.** New versions are published on GitHub Releases, and Plume finds them for you and downloads and installs them from inside the app—no more reinstalling by hand.

The first launch after downloading is still blocked by macOS (Plume isn't notarized yet). Open System Settings › Privacy & Security and click "Open Anyway". On Windows, click "More info › Run anyway" in SmartScreen.

<!-- plume:notes zh-CN -->
### 改动

- **macOS 上更新后权限不再丢。** 之前每装一个新版本，屏幕录制、辅助功能这些权限都要重新给一遍。现在 Plume 用固定的证书签名，系统把更新后的应用认作同一个。从之前的测试版换到这一版时，还要最后再授权一次。
- **应用内就能更新。** 新版本发布在 GitHub Releases 上，Plume 会自己查到，在应用里下载、安装，不用再手动重装。

下载后第一次打开仍会被 macOS 拦下（还没有做苹果公证）：到「系统设置 › 隐私与安全性」点「仍要打开」。Windows 上 SmartScreen 提示时点「更多信息 › 仍要运行」。
