# 自动审核

「帮我批准」档下判断一次操作危不危险：看不出风险的放行，看得出的把理由写在卡上再问人。随应用发，不能停用。

## 它判断什么

- **命令**（`assessCommand`）：递归删除和强制的通配删除（项目里的相对路径、系统临时目录和会话临时目录里的草稿除外）、删根目录或家目录；强制推送、`reset --hard`、`clean -f`、`checkout .` 这类丢改动的 git 操作和 `rebase`；`sudo`、关机、格式化、`dd`、`chown`、改系统服务和定时任务；下载并直接执行（管道、`sh -c "$(curl …)"`、`bash <(curl …)`，PowerShell 的 `irm … | iex`、`iex (irm …)`）；读写密钥文件；写系统路径和 shell 启动文件；上传本机文件；发布包、清理 docker、删集群资源；用 `open` 启动程序；PowerShell 和 cmd 的递归删除（`Remove-Item -Recurse`、`rd /s`、`del /s`）和 Windows 的那些危险程序（`Format-Volume`、`Set-ExecutionPolicy`、`reg delete`、`schtasks /create`、`netsh advfirewall`、`Start-Process -Verb RunAs`……），按名字查表，不分大小写，程序名去掉目录和 `.exe`、`.cmd` 这类扩展名。`env`、`xargs`、`bash -c`、`eval`、`find -exec`、`powershell -Command`、`powershell -EncodedCommand`（解出来再判）、`cmd /c` 包着的命令按里面那条判。
- **按哪种语法读命令**：shell 可能是 PowerShell 的地方（Windows 上受约束的命令跑在 PowerShell 里，`PLUME_SHELL` 指向 PowerShell 时也是），一行按 bash 和 PowerShell 两种语法各判一遍，哪种读出危险都问人：PowerShell 里 `\` 是路径分隔符、转义是反引号，`echo "a\"; rm -rf ~; echo"` 在 bash 眼里是一个字符串，在 PowerShell 眼里是三条命令。其余地方只按 bash（zsh 同）读。
- **写文件**（`assessWrite`）：写项目外（系统临时目录和会话的临时目录不算）、写敏感路径、改 shell 启动文件。
- **读**：走到这里的读已经出了工作区（读的工具先判过），一律问人。没见过的种类也问人。

入口是 `assess(kind, subject, cwd)`，理由文字用 `riskText(code, params, locale)` 按界面语言取。

## 和本体的分工

本体存权限模式、定它的含义（完全访问、外层放行、答过「以后不再问」的直接放行，提权和只能由人答的只认人答），其余经钩子 `tool.approve` 问「这一步放不放行」、把审批卡弹给人；plume.tools 按权限模式给命令选沙箱（帮我批准下只能写项目目录和临时目录）。这个插件在 `tool.approve` 的 order 1000 上只管帮我批准：按上面的规则判，看不出风险的放行，命中的把理由（按界面语言）写在卡上再问人。请求批准档、提权、只能由人答的和插件的层自己问的不归规则判，照样问人。

## 不判的

- 网络请求和 MCP 工具：网页读取只发 GET，不弹审批；MCP 插件按工具的注解自己问。
