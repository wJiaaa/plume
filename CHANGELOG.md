# 更新日志

这个文件由 `pnpm release` 生成，条目来自提交信息。写得含糊的提交在这里也含糊，所以值得在提交时就写清楚。

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
