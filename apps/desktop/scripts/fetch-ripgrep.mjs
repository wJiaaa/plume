/**
 * 把 ripgrep 放进 `vendor/ripgrep/<platform>-<arch>/`，安装包从那里带走它。
 *
 * 内置插件 plume.tools 的 `grep` 工具调 ripgrep，找不到就退回 JavaScript 逐文件扫描——慢几十倍，界面上
 * 看不出任何区别。从图标启动的应用 `PATH` 里只有系统目录，用户装没装 `rg` 都一样找不到，所以不随包带
 * 的话，每一份安装包都在走兜底。主进程经 `PLUME_RIPGREP` 把随包那份交给它（`src/main/ripgrep.ts`）。
 *
 * 版本和每个平台压缩包的 sha256 写死在下面：发版产物里的可执行文件不能是「下载时 GitHub 给了什么」。
 * 摘要取自 GitHub Release 自己公布的 `digest`。升级时一起换。
 *
 * 用法：
 *   node scripts/fetch-ripgrep.mjs                    本机这一份（开发时用）
 *   node scripts/fetch-ripgrep.mjs darwin-x64 ...     指定的几份
 * 打包时由 electron-builder 的 `beforePack`（`before-pack.mjs`）按正在打的平台和架构调用。
 *
 * 下载用 `curl`：它认 `https_proxy` 和系统代理，Node 的 `fetch` 不认——在要走代理的网络里后者
 * 只会超时。macOS、Linux 和 Windows 10 起都自带 curl 和 tar（Windows 的是认 zip 的 bsdtar）。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "15.2.0";

/** `<process.platform>-<process.arch>` → 发布包的目标三元组与它的 sha256。 */
const TARGETS = {
	"darwin-arm64": { triple: "aarch64-apple-darwin", ext: "tar.gz", sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4" },
	"darwin-x64": { triple: "x86_64-apple-darwin", ext: "tar.gz", sha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1" },
	"win32-x64": { triple: "x86_64-pc-windows-msvc", ext: "zip", sha256: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5" },
	"win32-arm64": { triple: "aarch64-pc-windows-msvc", ext: "zip", sha256: "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f" },
	// musl：静态链接，不挑发行版的 glibc 版本。
	"linux-x64": { triple: "x86_64-unknown-linux-musl", ext: "tar.gz", sha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c" },
	"linux-arm64": { triple: "aarch64-unknown-linux-musl", ext: "tar.gz", sha256: "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915" },
};

const VENDOR = fileURLToPath(new URL("../vendor/ripgrep/", import.meta.url));

/** electron-builder 的 `Arch` 枚举。 */
export const BUILDER_ARCH = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64" };

/** 放好以后的可执行文件路径；已经在、且是这个版本，就不再下载。 */
export function fetchRipgrep(key) {
	const target = TARGETS[key];
	if (!target) throw new Error(`[ripgrep] 没有 ${key} 的预编译包，可选：${Object.keys(TARGETS).join(", ")}`);
	const dir = join(VENDOR, key);
	const exe = join(dir, key.startsWith("win32") ? "rg.exe" : "rg");
	const stamp = join(dir, "VERSION");
	if (existsSync(exe) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION) return exe;

	const name = `ripgrep-${VERSION}-${target.triple}`;
	const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${name}.${target.ext}`;
	const work = mkdtempSync(join(tmpdir(), "plume-rg-"));
	try {
		const archive = join(work, `${name}.${target.ext}`);
		console.log(`[ripgrep] ${key}: ${url}`);
		execFileSync("curl", ["-fsSL", "--retry", "3", "-o", archive, url], { stdio: "inherit" });
		const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
		if (actual !== target.sha256) throw new Error(`[ripgrep] ${key} 的 sha256 对不上：期望 ${target.sha256}，实际 ${actual}`);
		/*
		 * Windows 上点名 System32 的 bsdtar：runner 的 PATH 里 Git 自带的 GNU tar 排在前面，它解不了
		 * zip，还会把 `C:\…` 里的冒号当成远程主机。
		 */
		const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
		execFileSync(tar, ["-xf", archive, "-C", work], { stdio: "inherit" });
		mkdirSync(dir, { recursive: true });
		copyFileSync(join(work, name, key.startsWith("win32") ? "rg.exe" : "rg"), exe);
		chmodSync(exe, 0o755);
		// MIT 与 Unlicense 双许可，随二进制一起带上许可文本。
		for (const file of ["COPYING", "LICENSE-MIT", "UNLICENSE"]) copyFileSync(join(work, name, file), join(dir, file));
		writeFileSync(stamp, `${VERSION}\n`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	return exe;
}

/**
 * electron-builder 的 `beforePack`：在复制 `extraResources` 之前，备好正在打的那一份。
 *
 * 按正在打的架构取，不拿本机那份充数：以后一次打两个架构时，每个架构各调一次，各放各的目录。
 * 失败就让打包失败：缺了 ripgrep 的安装包能装能用，只是搜索悄悄慢下来，没人会发现。
 */
export function beforePack(context) {
	const arch = BUILDER_ARCH[context.arch];
	fetchRipgrep(`${context.electronPlatformName}-${arch}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const keys = process.argv.slice(2);
	for (const key of keys.length ? keys : [`${process.platform}-${process.arch}`]) console.log(`[ripgrep] ${fetchRipgrep(key)}`);
}
