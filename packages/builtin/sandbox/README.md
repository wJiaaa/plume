# 沙箱

在这台机器能给的约束里跑 shell 命令，作为服务 `sandbox` 给别的插件用（内置插件 plume.tools 的 bash 就用它）。随应用发，不能停用。

## 它做了什么

- **三种模式**：只读（除了 `/dev/null` 一概不许写）、能写项目目录（再加上项目目录和临时目录）、不设限。macOS 用 seatbelt，Windows 用受限令牌（经 koffi 调系统接口，由应用自己的运行时起一个 runner 进程做，只管住一部分：给 Everyone 写权限的位置照样能写；只读模式也给一个按工作区分的私有临时目录，PowerShell 才不会退成受限语言模式）；给不了要的模式时（包括 Linux：没有后端）报错，不悄悄不加沙箱就跑。
- **shell**：按会话宣布的模式选（`@plume/platform` 的 `commandShell`）。Windows 上受约束的命令跑在 PowerShell 里（Git Bash 在受限令牌下起不来），完全访问跑在 Git Bash 里；提权的命令仍用会话宣布的那个 shell。
- **环境**：命令用用户的 shell 跑，环境向登录 shell 要一份，从图标启动时也找得到用户装的工具（Windows 的 `PATH` 来自注册表，不问）；分页器、颜色、交互提示都关掉。
- **停得干净**：命令自成一个进程组，停的时候连它起的子进程一起停；Windows 上用 `taskkill /T /F` 停整棵进程树，起命令不弹控制台窗口。

## 换成自己的

装一个提供服务 `sandbox` 的插件（`ctx.provide("sandbox", { run, looksDenied })`，接口见 `@plume/contract` 的 `SandboxService`）：非内置的提供方优先，用它的插件会按新的重新加载。
