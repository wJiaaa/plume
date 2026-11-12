/**
 * `pnpm package`：用 electron-builder 打包（参数原样转过去，比如 `--mac --arm64 --x64`），打成了再核对每个包里的
 * 原生二进制是不是它那个架构的（check-native-arch.mjs）。
 *
 * macOS 上先定用什么签：钥匙串里有 make-signing-cert.sh 生成的身份「Plume Code Signing」（或 `MAC_SIGNING_IDENTITY`
 * 指定的）就用它，盖掉 electron-builder.yml 里兜底的 ad-hoc（`mac.identity: "-"`）；没有就 ad-hoc。为什么证书要紧见
 * make-signing-cert.sh：ad-hoc 签的版本每次更新在 macOS 看来都是新应用，权限全部重置。
 * 按名字找身份，不经 electron-builder 的 `CSC_LINK` 导入：26.15.3 里那条路用证书的密码去解它自己随机密码的临时钥匙串，
 * 必然失败。钥匙串由调用方准备好（CI 是 .github/scripts/prepare-signing.sh）。
 *
 * 核对单独一步、放在打包之后：按平台分的原生模块是挑着复制进去的，挑错了 electron-builder 不会报错，打出来的包能装
 * 能开，只有用那个架构的人才会碰上。打包失败就不核对，没有东西可查，再报一个错只会把第一个埋掉。
 *
 * Plume 的原生模块（本体沙箱的 koffi、插件里的 node-pty）都是 N-API 的预编译包，不按 Electron 重新编译，所以打完
 * 不用把 node_modules 编回本机架构。
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** make-signing-cert.sh 生成的证书里的名字。 */
const DEFAULT_IDENTITY = "Plume Code Signing";
const identity = process.env.MAC_SIGNING_IDENTITY?.trim() || DEFAULT_IDENTITY;

/**
 * 这个身份现在能不能用来签。问系统，不看环境变量：会出错的恰恰是变量设了、钥匙串没准备好，猜错的结果是悄悄 ad-hoc 签、
 * 发出去权限全重置。`-v` 只列有效的身份：不受信任的证书 find-identity 列得出、codesign 却不认，这里要和 codesign 一致。
 */
function identityAvailable() {
	const found = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
	return found.status === 0 && found.stdout.includes(identity);
}

const args = process.argv.slice(2);
if (process.platform === "darwin") {
	if (identityAvailable()) {
		args.push(`-c.mac.identity=${identity}`);
		console.log(`[package] 用「${identity}」签名：更新后 macOS 仍当它是同一个应用，权限留着`);
	} else {
		console.log(`[package] 钥匙串里没有「${identity}」，只 ad-hoc 签：macOS 会把这个包当成新应用、重置权限`);
		console.log("[package] 生成证书见 apps/desktop/scripts/make-signing-cert.sh");
	}
}

// Windows 上 electron-builder 是 .cmd，得经 shell 起。
const result = spawnSync("electron-builder", args, { stdio: "inherit", shell: process.platform === "win32" });
if (result.status !== 0) process.exit(result.status ?? 1);

const check = spawnSync(process.execPath, [join(import.meta.dirname, "check-native-arch.mjs")], { stdio: "inherit" });
process.exit(check.status ?? 1);
