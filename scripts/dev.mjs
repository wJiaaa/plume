/**
 * 开发模式（`pnpm dev`，插件已经构建好）：把市场插件打进 .market/、在本机服务起来，再起 electron-vite dev，
 * 应用经 PLUME_MARKET_URL 从这里装市场插件。设了 PLUME_MARKET_URL 时用它，不起本机市场（比如直接连线上的）。
 */

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { buildMarket, serveMarket } from "./market-serve.mjs";

const repo = resolve(import.meta.dirname, "..");
let market;
if (!process.env.PLUME_MARKET_URL) {
	buildMarket(join(repo, ".market"));
	market = await serveMarket(join(repo, ".market"));
	console.log(`本机插件市场：${market.url}`);
}

const child = spawn("pnpm", ["--filter", "@plume/desktop", "dev"], {
	cwd: repo,
	stdio: "inherit",
	shell: process.platform === "win32",
	env: { ...process.env, ...(market ? { PLUME_MARKET_URL: market.url } : {}) },
});
// Ctrl-C 同时发给了子进程：这里不退，等它收拾完。
process.on("SIGINT", () => undefined);
child.on("exit", async (code) => {
	await market?.close();
	process.exit(code ?? 1);
});
