/**
 * 沙箱 runner 的入口：`@plume/sandbox` 经 `ELECTRON_RUN_AS_NODE` 用应用自己的运行时起它，在 Windows 上造受限令牌、再起命令。
 * 只是一个单独打出来的脚本，agent 进程经 `useSandboxRunner` 告诉沙箱它在哪（`agent-process.ts`）。它要的 koffi 是应用的生产依赖，
 * 打包时原生的那份解到 `app.asar.unpacked`。
 */

import "@plume/sandbox/runner";
