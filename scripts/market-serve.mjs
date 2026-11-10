/**
 * 在本机起一个插件市场，开发（scripts/dev.mjs）和冒烟（scripts/smoke.mjs）用：应用经 PLUME_MARKET_URL 读它，
 * 和读线上的 GitHub Pages 走同一条路（下载、核对、解开）。
 *
 * 目录用插件仓库的 scripts/build-dist.mjs 打，和发布的格式一样；只打这台机器的平台，插件要先构建好（pnpm build:plugins）。
 * 服务只听 127.0.0.1，应用只允许本机地址用 http。
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, normalize, resolve, sep } from "node:path";
import { MARKET_DIR } from "./market.mjs";

const repo = resolve(import.meta.dirname, "..");

/** 把构建好的市场插件打成静态目录放进 out（先清空）。 */
export function buildMarket(out) {
	execFileSync(process.execPath, [join(repo, MARKET_DIR, "../scripts/build-dist.mjs"), "--out", out, "--targets", `${process.platform}-${process.arch}`], {
		stdio: ["ignore", "ignore", "inherit"],
	});
}

/** 把 dir 当静态目录服务起来；url 是它的 marketplace.json。 */
export async function serveMarket(dir) {
	const root = resolve(dir);
	const server = createServer((request, response) => {
		const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		const file = join(root, normalize(path));
		if (!file.startsWith(root + sep)) return void response.writeHead(404).end();
		readFile(file).then(
			(bytes) => response.writeHead(200, { "content-length": bytes.length }).end(bytes),
			() => response.writeHead(404).end(),
		);
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return {
		url: `http://127.0.0.1:${server.address().port}/marketplace.json`,
		close: () =>
			new Promise((done) => {
				server.closeAllConnections();
				server.close(done);
			}),
	};
}
