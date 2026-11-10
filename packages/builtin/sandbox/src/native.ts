/**
 * `koffi`，按 ES 模块里唯一行得通的方式加载。
 *
 * ES 模块里没有 `require`。`createRequire(import.meta.url)` 从这份代码实际所在的地方解析：源码里是 `src/`，
 * 发出去的是插件的 `dist/index.mjs`，往上找到放着它的 `node_modules`（插件构建时把 `dependencies` 复制进 `dist/node_modules`）。
 * 用到才加载：静态 import 会让每个平台启动时都先去加载一个原生模块，而只有 Windows 用它。
 */

import { createRequire } from "node:module";

let cached: typeof import("koffi") | undefined;

export function koffi(): typeof import("koffi") {
	cached ??= createRequire(import.meta.url)("koffi") as typeof import("koffi");
	return cached;
}
