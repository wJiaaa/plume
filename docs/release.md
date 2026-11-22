# 打包、发版、发插件 SDK

## 打包：`pnpm package`

打安装包到 `apps/desktop/release/`，一次打两个架构：

- macOS：dmg 和给自动更新用的 zip（arm64 + x64）。钥匙串里有 `apps/desktop/scripts/make-signing-cert.sh` 生成的 `Plume Code Signing` 证书就用它签，没有就 ad-hoc。
- Windows：nsis 安装程序（x64 + arm64）。

打包怎么做：

- 用 electron-builder，Electron 按目标架构下载。
- 只构建内置插件。内置插件和插件 SDK 放进资源目录，市场插件不随应用发。
- `pnpm install` 会多装 darwin、win32 的 x64、arm64 原生包，插件构建时都带上，打包时按目标裁掉别的。
- 打包前按架构下载 ripgrep 一起放进去，要能连 GitHub。开发时用 `node apps/desktop/scripts/fetch-ripgrep.mjs` 下一份本机的，grep 工具也用上它。
- 打完由 `apps/desktop/scripts/check-native-arch.mjs` 核对内置插件、插件 SDK 里原生模块和 ripgrep 的架构，对不上就失败。

CI 见 `.github/workflows/package.yml`：手动触发或推 `v*` tag 时跑，macOS 用 secrets 里的证书签名，最后算出 `SHA256SUMS`；推 tag 时连同安装包发成这个仓库的 GitHub Release，正文取 `CHANGELOG.md` 里这一版那一节。

## 发版：`pnpm release <patch|minor|major|x.y.z> [--no-push]`

前提：在远端的默认分支上、工作区干净、和远端一致。

它依次做：

1. 把 `apps/desktop/package.json` 和其余非插件包的版本号改齐（`scripts/versions.mjs` 按目录算；插件的版本归插件自己）。
2. 用 git-cliff（`cliff.toml`）在 `CHANGELOG.md` 里生成这一版的提交列表。
3. 提交 `chore(release): vX`，打 tag（说明是 `scripts/changelog-section.mjs` 读出的那一节）。
4. 推送。这一节还没有手写的中英两段文案时停在推送前，效果同 `--no-push`；手推 `v*` tag 时 pre-push 钩子也查（`scripts/check-release-notes.mjs`）。

生成的提交列表只是原料，发出去的文案要手写：

- 写成 `<!-- plume:notes en -->`、`<!-- plume:notes zh-CN -->` 两段，英文在前。
- 两种语言各写一遍，不直译。
- 写给用的人：先说他遇到的现象，再说现在怎样。
- 关于页和更新对话框按界面语言只显示其中一段。

发版前跑一次 `pnpm catalog:update`，刷新随应用发的模型目录快照。

## 发插件 SDK 到 npm

```sh
git tag sdk-vX.Y.Z vX.Y.Z && git push origin sdk-vX.Y.Z
```

- `pnpm release` 不发 SDK，推 `v*` tag 也不发。要发时，在已经发了 Release 的那一版上另推 `sdk-v*` tag，由 `.github/workflows/package.yml` 的 `sdk` job 单独跑（不打包）。
- 用 npm 的 trusted publishing。登记的是 `package.yml`，所以这个 job 不拆成单独的文件。
- 发之前核对两件事，不对就失败：tag 和 `packages/sdk/plugin-sdk/package.json` 的版本号一致；应用 `vX.Y.Z` 的 Release 已经在了。原因：SDK 的类型来自宿主，先于宿主发布的话，插件就会用上用户手里的 Plume 还没有的接口。
- SDK 版本号随 `pnpm release` 和应用一起改，所以只能发某一版应用对应的 SDK。
- 本机也能发：`pnpm publish:sdk [--dry-run]`。和 CI 用同一份脚本（`packages/sdk/plugin-sdk/scripts/publish.mjs`），用 `npm login` 的账号；npm 上已有这个版本就跳过。
