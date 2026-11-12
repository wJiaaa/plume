/**
 * `koffi`，按 ES 模块里唯一行得通的方式加载。
 *
 * ES 模块里没有 `require`。`createRequire(import.meta.url)` 从这份代码实际所在的地方解析：源码里是 `src/`，
 * 打包好的应用里是 runner 那个入口（`app.asar/out/main/`），往上找到应用的 `node_modules`（koffi 是 `apps/desktop` 的生产依赖，
 * 原生的那份由 electron-builder 解到 `app.asar.unpacked`）。只有 runner 进程加载它，agent 进程不加载。
 * 用到才加载：静态 import 会让每个平台启动时都先去加载一个原生模块，而只有 Windows 用它。
 */

import { createRequire } from "node:module";

let cached: typeof import("koffi") | undefined;

export function koffi(): typeof import("koffi") {
	cached ??= createRequire(import.meta.url)("koffi") as typeof import("koffi");
	return cached;
}
