/**
 * 打出来的每个包带的原生二进制，是不是给它要跑的那台机器的。
 *
 * 一台机器一次打两个架构（mac 上 arm64 + x64，Windows 上 x64 + arm64），另一个架构的二进制靠 pnpm 的
 * supportedArchitectures 装上、打包时按目标挑。挑错了打包不会失败、应用照样能装能开，只有用那个架构的人走到加载它的
 * 那一步（开终端、起沙箱、搜索、写插件）才坏。所以打完逐个读二进制自己的文件头核对，不按它放在哪个目录推断——放在
 * arm64 包里的不一定是 arm64 的文件，要查的正是这个。
 *
 * 查的是：
 * - 内置插件、插件 SDK（资源目录的 builtin/、plugin-sdk/）和 app.asar.unpacked 里的 `.node`，
 *   以及 node-pty 这类一个包里放各平台 `prebuilds/` 的那份目录里的程序：架构要对；声明了别的平台、架构的包不该在
 *   （beforePack 该裁掉的）；包说它发了这个平台、架构的那份（optionalDependencies 里有、prebuilds 里该有）就得在。
 *   包根本没发这个平台、架构的（比如某个包不发 Intel mac 的），只提醒，不让打包失败：打包这一步补不上它。
 * - ripgrep，插件 SDK 的 esbuild、tsc：缺了的话搜索、写插件悄悄退回慢的路或者跑不起来。
 *
 * 用法：`node scripts/check-native-arch.mjs [<输出目录>]`，缺省是 release/。`pnpm package` 经 scripts/package.mjs
 * 打完就跑；这里失败的包不能发。
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const RELEASE_DIR = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "release"));

/**
 * electron-builder 给每个未打包目录起的名字和它的平台、架构。缺省架构（x64）不带后缀，`mac` 就是 x64 的，
 * 所以列表而不是按 `-` 拆名字。
 */
const BUILDS = {
	mac: { platform: "darwin", arch: "x64", resources: "Plume.app/Contents/Resources" },
	"mac-arm64": { platform: "darwin", arch: "arm64", resources: "Plume.app/Contents/Resources" },
	"win-unpacked": { platform: "win32", arch: "x64", resources: "resources" },
	"win-arm64-unpacked": { platform: "win32", arch: "arm64", resources: "resources" },
};

/** 包名、目录名里的 `<平台>-<架构>`：按平台分的包（`@koromix/koffi-win32-x64`、`@esbuild/darwin-arm64`）就这么认。 */
const PLATFORM_PART = /(?:^|[/-])(darwin|win32|linux|freebsd|openbsd|android)-(x64|arm64|ia32|arm|riscv64|loong64|ppc64|s390x)(?=$|-)/;

/** 二进制文件头写的架构；读不出来（不是 PE、Mach-O、ELF）是 null。 */
function binaryArch(file) {
	// 只读开头：这些文件动辄几 MB，要的都在前几十字节。
	const buffer = Buffer.alloc(0x400);
	let read = 0;
	try {
		const fd = openSync(file, "r");
		try {
			read = readSync(fd, buffer, 0, buffer.length, 0);
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
	if (read < 64) return null;
	const head = buffer.subarray(0, read);
	// PE（Windows）：`MZ`，0x3c 处指向 `PE\0\0`，后面是机器类型。
	if (head[0] === 0x4d && head[1] === 0x5a) {
		const pe = head.readUInt32LE(0x3c);
		if (pe + 6 > read || head.toString("ascii", pe, pe + 4) !== "PE\0\0") return null;
		return { 0x8664: "x64", 0xaa64: "arm64", 0x14c: "ia32" }[head.readUInt16LE(pe + 4)] ?? null;
	}
	const magic = head.readUInt32LE(0);
	// 通用二进制（几个架构合在一起）对哪个架构都对；按小端读 0xCAFEBABE 是反过来的。
	if (magic === 0xbebafeca || magic === 0xbfbafeca) return "universal";
	// 64 位 Mach-O（macOS），cputype 的最高位是 64 位标记。
	if (magic === 0xfeedfacf) return { 0x01000007: "x64", 0x0100000c: "arm64" }[head.readUInt32LE(4)] ?? null;
	// ELF。
	if (head.toString("ascii", 0, 4) === "\x7fELF") return { 0x3e: "x64", 0xb7: "arm64" }[head.readUInt16LE(18)] ?? null;
	return null;
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** dir 下（含嵌套的 node_modules）每个包的目录。 */
function packages(modules, found = []) {
	let entries;
	try {
		entries = readdirSync(modules, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const path = join(modules, entry.name);
		if (entry.name.startsWith("@")) {
			packages(path, found);
			continue;
		}
		found.push(path);
		packages(join(path, "node_modules"), found);
	}
	return found;
}

/** 包里的文件，不进嵌套的 node_modules（那是别的包）。 */
function files(dir, found = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules") files(path, found);
		else if (entry.isFile()) found.push(path);
	}
	return found;
}

/** 从 from 往上找 node_modules/<name>，和 Node 的解析一样，到 root 为止。 */
function installed(name, from, root) {
	for (let dir = from; dir.startsWith(root); dir = resolve(dir, "..")) {
		if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
		if (dir === root) break;
	}
	return existsSync(join(root, name, "package.json"));
}

const problems = [];
const warnings = [];
let checked = 0;

/** 一个二进制的架构对不对得上这个包。 */
function expectArch(name, build, file, label, required) {
	const actual = binaryArch(file);
	checked++;
	if (actual == null) {
		if (required) problems.push(`${name}: ${label} 不在，或者读不出它的架构`);
		return;
	}
	if (actual !== "universal" && actual !== build.arch) problems.push(`${name}: ${label} 是 ${actual} 的，这个包是 ${build.arch}`);
}

/** 一个 node_modules：每个包是不是给这个平台、架构的，该在的在不在。 */
function checkModules(name, build, modules, base) {
	const target = `${build.platform}-${build.arch}`;
	const label = (path) => relative(base, path);
	for (const dir of packages(modules)) {
		const manifest = readJson(join(dir, "package.json"));
		if (!manifest) continue;
		const declared = Array.isArray(manifest.os) || Array.isArray(manifest.cpu);
		const forThis =
			(!Array.isArray(manifest.os) || manifest.os.includes(build.platform)) && (!Array.isArray(manifest.cpu) || manifest.cpu.includes(build.arch));
		if (declared && !forThis) {
			problems.push(`${name}: ${label(dir)} 是给别的平台、架构的，没被裁掉`);
			continue;
		}

		// 这个包发了哪些按平台分的可选依赖：发了这个目标的，就得装上；一个都没发这个目标的，提醒一声。
		const optional = Object.keys(manifest.optionalDependencies ?? {}).filter((dep) => PLATFORM_PART.test(dep));
		if (optional.length > 0) {
			const mine = optional.filter((dep) => PLATFORM_PART.exec(dep)?.slice(1).join("-") === target);
			for (const dep of mine) {
				if (!installed(dep, dir, modules)) {
					problems.push(`${name}: ${label(dir)} 要的 ${dep} 不在——pnpm 没装上它（看 pnpm-workspace.yaml 的 supportedArchitectures）`);
				}
			}
			if (mine.length === 0) warnings.push(`${name}: ${manifest.name} 没发 ${target} 的原生模块，用到它的插件在这个包里用不了`);
		}

		// 一个包里放各平台 prebuilds/ 的（node-pty）：别的目录该裁掉，这个目标的得在。
		const prebuilds = join(dir, "prebuilds");
		if (existsSync(prebuilds)) {
			const dirs = readdirSync(prebuilds, { withFileTypes: true }).filter((entry) => entry.isDirectory() && PLATFORM_PART.test(entry.name));
			for (const entry of dirs) {
				if (entry.name !== target) problems.push(`${name}: ${label(join(prebuilds, entry.name))} 是给别的平台、架构的，没被裁掉`);
			}
			if (!dirs.some((entry) => entry.name === target)) problems.push(`${name}: ${label(prebuilds)} 里没有 ${target}`);
			else {
				// 目标目录里的程序（spawn-helper、winpty-agent.exe、各个 DLL）也查；读不出架构的（调试符号）不算。
				for (const file of files(join(prebuilds, target)))
					if (!file.endsWith(".node") && binaryArch(file) != null) expectArch(name, build, file, label(file), false);
			}
		}

		for (const file of files(dir)) {
			if (file.endsWith(".node")) expectArch(name, build, file, label(file), true);
		}
	}
}

for (const [name, build] of Object.entries(BUILDS)) {
	const dir = join(RELEASE_DIR, name);
	try {
		if (!statSync(dir).isDirectory()) continue;
	} catch {
		// 这台机器没打这个平台、架构。
		continue;
	}
	const resources = join(dir, build.resources);
	const before = checked;
	for (const catalog of ["builtin"]) {
		let entries = [];
		try {
			entries = readdirSync(join(resources, catalog), { withFileTypes: true });
		} catch {
			problems.push(`${name}: 资源目录里没有 ${catalog}/`);
		}
		for (const entry of entries) {
			if (entry.isDirectory()) checkModules(name, build, join(resources, catalog, entry.name, "dist", "node_modules"), resources);
		}
	}
	checkModules(name, build, join(resources, "app.asar.unpacked", "node_modules"), resources);
	const sdk = join(resources, "plugin-sdk", "node_modules");
	checkModules(name, build, sdk, resources);

	const exe = build.platform === "win32" ? ".exe" : "";
	const target = `${build.platform}-${build.arch}`;
	expectArch(name, build, join(resources, "ripgrep", `rg${exe}`), `ripgrep/rg${exe}`, true);
	const esbuild = build.platform === "win32" ? join(sdk, "@esbuild", target, "esbuild.exe") : join(sdk, "@esbuild", target, "bin", "esbuild");
	expectArch(name, build, esbuild, relative(resources, esbuild), true);
	const tsc = join(sdk, "@typescript", `typescript-${target}`, "lib", `tsc${exe}`);
	expectArch(name, build, tsc, relative(resources, tsc), true);

	console.log(`[arch] ${name}: 查了 ${checked - before} 个二进制，${build.platform}/${build.arch}`);
}

for (const warning of warnings) console.warn(`[arch] 提醒 ${warning}`);

if (checked === 0) {
	console.log(`[arch] ${RELEASE_DIR} 里没有打好的目录，没什么可查`);
	process.exit(0);
}

if (problems.length > 0) {
	console.error("\n[arch] 原生二进制和它所在的包对不上：\n");
	for (const problem of problems) console.error(`  ${problem}`);
	console.error("\n这样的包只在用户的机器上坏。见 apps/desktop/scripts/check-native-arch.mjs。");
	process.exit(1);
}

console.log(`[arch] ${checked} 个二进制，都和所在的包对得上`);
