# 沙箱

在这台机器能给的约束里跑 shell 命令（`@plume/sandbox`）。本体的一部分，插件换不掉：权限模式对应哪一档、提权怎么问人在 `@plume/agent`（`src/commands.ts`），插件的工具经 `ToolRun.exec` 跑命令、经 `ToolRun.escalate` 申请提权。这个包只认「命令、目录、档位」，不认会话、不认插件。

## 它做了什么

- **三种模式**：只读（除了 `/dev/null` 一概不许写）、能写项目目录（再加上项目目录和临时目录）、不设限。macOS 用 seatbelt，Windows 用受限令牌（经 koffi 调系统接口，由应用自己的运行时起一个 runner 进程做，只管住一部分：给 Everyone 写权限的位置照样能写；只读模式也给一个按工作区分的私有临时目录，PowerShell 才不会退成受限语言模式）；给不了要的模式时（包括 Linux：没有后端）报错，不悄悄不加沙箱就跑。
- **shell**：按会话宣布的模式选（`@plume/platform` 的 `commandShell`）。Windows 上受约束的命令跑在 PowerShell 里（Git Bash 在受限令牌下起不来），完全访问跑在 Git Bash 里；提权的命令仍用会话宣布的那个 shell。
- **环境**：命令用用户的 shell 跑，环境向登录 shell 要一份，从图标启动时也找得到用户装的工具（Windows 的 `PATH` 来自注册表，不问）；分页器、颜色、交互提示都关掉。
- **停得干净**：命令自成一个进程组，停的时候连它起的子进程一起停；Windows 上用 `taskkill /T /F` 停整棵进程树，起命令不弹控制台窗口。

## Windows 的 runner

受限令牌由单独的 runner 脚本造（`src/runner-entry.ts`，包导出 `@plume/sandbox/runner`）。桌面应用把它打成 agent 进程旁边的一个入口（`apps/desktop/src/main/sandbox-runner.ts`），启动时经 `useSandboxRunner` 告诉后端；koffi 是 `apps/desktop` 的生产依赖，只有 runner 进程加载它。从源码跑（测试）时后端直接起 `src/runner-entry.ts`。
