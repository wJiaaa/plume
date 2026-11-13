/**
 * 构建一个插件：src/index.ts 打成逻辑入口 dist/index.mjs；有 src/ui.tsx 的再打出界面入口 dist/ui.mjs。
 * `plume-plugin build` 和仓库的 scripts/build-plugins.mjs 都调它，插件只有这一种构建方式。
 *
 * - 逻辑入口：Node 平台的 ESM，依赖全部打进去（宿主的接口只有类型）。package.json 的 dependencies 例外：
 *   打不进去的（node-pty 这类原生模块）写在那里，不打包，原样复制进 dist/node_modules，运行时按 Node 的解析找到。
 *   一并复制实际安装的运行依赖闭包；按平台分的预编译（`os`/`cpu` 分包、prebuilds/<平台>-<架构>）带上 targets.mjs 里
 *   那几个平台、架构装了的每一份：dist/ 会进 Plume 的多架构安装包，打包时再按目标裁（见 targets.mjs）。
 *   复制出的 Mach-O、ELF 文件补上执行位，不靠依赖的安装脚本（见 markExecutable）。
 * - 界面入口：浏览器 ESM；react、react/jsx-runtime、@plume/ui、@plume/styles 留作外部，运行时经宿主的 import map 用产品的实例。
 *   只认这几个模块名本身：@plume/ui/icons 不在 import map 里，指到 SDK 自带的图标库打进插件（只打用到的那几个图标）。
 *   引入的 .css 是一段文字，插件自己挂到页面上（宿主不加载插件的样式表）。
 *   宿主启动时就加载每个插件的 dist/ui.mjs；`import()` 进来的模块拆到 dist/chunks/，用到时才取，大的预览库不拖慢启动。
 *   拆出来的文件名带内容哈希，和 ui.mjs 一起经 `plume-plugin://` 读取。
 */

import { existsSync } from "node:fs";
import { cp, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { build } from "esbuild";
import { forTarget, TARGETS } from "./targets.mjs";

const UI_SHARED = ["react", "react/jsx-runtime", "@plume/ui", "@plume/styles"];
const ICONS = join(import.meta.dirname, "icons.mjs");

/** esbuild 的 external 写包名会连子路径一起算外部，这里按整个模块名匹配。 */
const shared = {
	name: "plume-shared",
	setup(build) {
		const filter = new RegExp(`^(?:${UI_SHARED.map((name) => name.replace(/[/.]/g, "\\$&")).join("|")})$`);
		build.onResolve({ filter }, (args) => ({ path: args.path, external: true }));
		build.onResolve({ filter: /^@plume\/ui\/icons$/ }, () => ({ path: ICONS }));
	},
};
const HOST = `${process.platform}-${process.arch}`;

/** Mach-O（单架构 32、64 位的两种字节序，通用二进制）和 ELF 的文件头。 */
const NATIVE_MAGIC = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "7f454c46"]);

/**
 * 给 dir 下的 Mach-O、ELF 文件补上执行位。复制保留依赖安装时的权限，有的预编译包发布时就没带执行位、靠安装脚本补
 * （node-pty 1.1.0 的 spawn-helper）；依赖按 `--ignore-scripts` 装时它是 0644，`plume-plugin dev` / `install` 原样装进去，
 * 终端起 shell 报 `posix_spawnp failed.`。按文件头认、不按包名认；动态库（`.node`、`.dylib`、`.so`）一起加上无害。
 * 只改权限、不改内容。Windows 没有执行位，跳过。
 */
async function markExecutable(dir) {
	if (process.platform === "win32") return;
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const file = await open(join(entry.parentPath, entry.name), "r");
		try {
			const { bytesRead, buffer } = await file.read(Buffer.alloc(4), 0, 4, 0);
			if (bytesRead === 4 && NATIVE_MAGIC.has(buffer.toString("hex"))) await file.chmod((await file.stat()).mode | 0o111);
		} finally {
			await file.close();
		}
	}
}

/** 复制实际安装的运行依赖，顶层同名冲突时放到依赖它的包下面。 */
async function copyDependencies(dir, names) {
	const target = join(dir, "dist/node_modules");
	await rm(target, { recursive: true, force: true });
	const placed = new Map();
	const copied = new Set();

	async function locate(from, name, required) {
		const require = createRequire(join(from, "package.json"));
		for (const modules of require.resolve.paths(name) ?? []) {
			let file;
			try {
				// 不经 exports，且从实路径解析下一级，保留 pnpm 安装时的版本和 peer 上下文。
				file = await realpath(join(modules, name, "package.json"));
			} catch (error) {
				if (error.code === "ENOENT") continue;
				throw error;
			}
			const manifest = JSON.parse(await readFile(file, "utf8"));
			// 必需的依赖要能在构建机上跑；可选的（按平台分的预编译包）只要合 TARGETS 里的一个就带上。
			if (required ? !forTarget(manifest, HOST) : !TARGETS.some((target) => forTarget(manifest, target))) {
				if (!required) return null;
				throw new Error(`运行依赖 ${name} 不支持 ${HOST}（${from}）`);
			}
			return { source: dirname(file), manifest };
		}
		if (!required) return null;
		throw new Error(`找不到运行依赖 ${name}（${from}）`);
	}

	async function copyPackage(pkg, destination) {
		if (copied.has(destination)) return;
		copied.add(destination);
		const prebuilds = join(pkg.source, "prebuilds") + sep;
		await cp(pkg.source, destination, {
			recursive: true,
			dereference: true,
			filter: (path) => basename(path) !== "node_modules" && (!path.startsWith(prebuilds) || TARGETS.includes(path.slice(prebuilds.length).split(sep)[0])),
		});
		const dependencies = {
			...Object.fromEntries(Object.keys(pkg.manifest.peerDependencies ?? {}).map((name) => [name, false])),
			...Object.fromEntries(Object.keys(pkg.manifest.dependencies ?? {}).map((name) => [name, true])),
			...Object.fromEntries(Object.keys(pkg.manifest.optionalDependencies ?? {}).map((name) => [name, false])),
		};
		for (const [name, required] of Object.entries(dependencies)) {
			const dependency = await locate(pkg.source, name, required);
			if (!dependency) continue;
			const require = createRequire(join(destination, "package.json"));
			const visible = require.resolve
				.paths(name)
				.map((modules) => join(modules, name))
				.find((path) => placed.has(path));
			// 只复用 Node 当前能找到且源实路径一致的包，不能只看包名或版本号。
			let next = visible;
			if (!visible || placed.get(visible) !== dependency.source) {
				next = placed.has(join(target, name)) ? join(destination, "node_modules", name) : join(target, name);
				placed.set(next, dependency.source);
			}
			await copyPackage(dependency, next);
		}
	}

	// 先预留直接依赖的位置，免得先遍历的传递依赖抢占插件入口要用的版本。
	const roots = [];
	for (const name of names) {
		const pkg = await locate(dir, name, true);
		const destination = join(target, name);
		placed.set(destination, pkg.source);
		roots.push({ pkg, destination });
	}
	for (const { pkg, destination } of roots) await copyPackage(pkg, destination);
	if (roots.length > 0) await markExecutable(target);
}

/**
 * 构建 target 这个插件。成功返回打出来的文件说明（给命令行打印），失败抛错；esbuild 的报错它自己已经打过了。
 * @param {string} target 插件目录（有 package.json 和 src/index.ts）
 * @returns {Promise<string>}
 */
export async function buildPlugin(target) {
	const dir = resolve(target);
	const logic = join(dir, "src/index.ts");
	const ui = join(dir, "src/ui.tsx");
	if (!existsSync(logic)) throw new Error("找不到 src/index.ts");
	const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	const native = Object.keys(manifest.dependencies ?? {});
	const common = { bundle: true, format: "esm", sourcemap: "inline", logLevel: "warning", absWorkingDir: dir };

	// 打进来的 CommonJS 依赖（MCP SDK 用的 cross-spawn 这类）会 `require("child_process")`；ESM 里没有 `require`，
	// esbuild 的垫片找不到它就在加载时抛错，所以在文件头上给一个。
	const banner = { js: 'import { createRequire as __plumeCreateRequire } from "node:module";\nconst require = __plumeCreateRequire(import.meta.url);' };
	await build({ ...common, entryPoints: [logic], outfile: join(dir, "dist/index.mjs"), platform: "node", target: "node24", external: native, banner });
	await copyDependencies(dir, native);
	const outputs = [`dist/index.mjs${native.length > 0 ? `（带上 ${native.join("、")}）` : ""}`];
	await rm(join(dir, "dist/chunks"), { recursive: true, force: true });
	if (existsSync(ui)) {
		await build({
			...common,
			entryPoints: [ui],
			outdir: join(dir, "dist"),
			splitting: true,
			entryNames: "[name]",
			chunkNames: "chunks/[name]-[hash]",
			outExtension: { ".js": ".mjs" },
			platform: "browser",
			target: "chrome156",
			jsx: "automatic",
			plugins: [shared],
			loader: { ".css": "text" },
			define: { "process.env.NODE_ENV": '"production"' },
		});
		outputs.push("dist/ui.mjs");
	}
	return outputs.join("、");
}
