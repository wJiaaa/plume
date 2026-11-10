/**
 * 把 SDK 发到 npm（`pnpm publish:sdk`）。本机和 CI（.github/workflows/package.yml 的 sdk）走这同一份：
 *
 *   1. 生成类型声明（`pnpm --filter "@plumeai/plugin-sdk..." typecheck`）；
 *   2. `stage.mjs --npm` 整理出要发的目录（放在临时目录，发完删掉）；
 *   3. npm 上已经有这个版本就跳过：本机先发过，推 tag 后 CI 再跑不会失败；发出去的版本不可变，要发新的先升版本号；
 *   4. `npm publish`。在 GitHub Actions 里加 `--provenance`（经 OIDC 的 trusted publishing，不存 token）；本机用 `npm login`
 *      登录的账号发，没有 provenance。
 *
 *   pnpm publish:sdk [--dry-run] [--tag <标签>] [--otp <验证码>]    后面的参数原样交给 npm publish
 *
 * 版本号和应用一样，由 `pnpm release` 一起改；SDK 的类型来自宿主，先发了 SDK、宿主还没发布，插件就会用上用户手里的 Plume 没有的接口。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sdk = resolve(import.meta.dirname, "..");
const { name, version } = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
const passthrough = process.argv.slice(2);
// Windows 上 pnpm、npm 是 .cmd，要经 shell 起。
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });

function published() {
	try {
		return run("npm", ["view", `${name}@${version}`, "version"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim() === version;
	} catch (error) {
		// 包或版本不存在是 E404；别的错（网络、登录）不能当成没发过。
		if (String(error.stderr ?? "").includes("E404")) return false;
		process.stderr.write(error.stderr ?? "");
		throw error;
	}
}

if (published()) {
	console.log(`${name}@${version} 已经在 npm 上，跳过。要发新的先升版本号（pnpm release）。`);
	process.exit(0);
}

run("pnpm", ["--filter", "@plumeai/plugin-sdk...", "typecheck"]);
const out = mkdtempSync(join(tmpdir(), "plume-plugin-sdk-"));
try {
	run(process.execPath, [join(sdk, "scripts/stage.mjs"), out, "--npm"]);
	const provenance = process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : [];
	run("npm", ["publish", out, "--access", "public", ...provenance, ...passthrough]);
} finally {
	rmSync(out, { recursive: true, force: true });
}
