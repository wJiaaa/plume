import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../lib/build.mjs";
import { TARGETS, trimNative } from "../lib/targets.mjs";

async function fixture(t, dependencies, entry = "export default true;") {
	const work = await mkdtemp(join(tmpdir(), "plume-native-dependencies-"));
	t.after(() => rm(work, { recursive: true, force: true }));
	const source = join(work, "source");
	const plugin = join(source, "plugin");
	await mkdir(join(plugin, "src"), { recursive: true });
	await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "fixture-plugin", type: "module", dependencies }));
	await writeFile(join(plugin, "src/index.ts"), entry);
	return {
		source,
		plugin,
		async package(id, manifest, code = "module.exports = true;") {
			const dir = join(source, "packages", id);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.0.0", main: "index.cjs", ...manifest }));
			await writeFile(join(dir, "index.cjs"), code);
			return dir;
		},
		async link(from, name, to) {
			const link = join(from, "node_modules", name);
			await mkdir(dirname(link), { recursive: true });
			await symlink(to, link, "junction");
		},
		async install() {
			// 安装会先复制再挪位置；移除整个源目录，避免运行时碰巧借到开发环境的包。
			const staging = join(work, "staging");
			const installed = join(work, "installed");
			await cp(join(plugin, "dist"), staging, { recursive: true });
			await rename(staging, installed);
			await rm(source, { recursive: true, force: true });
			async function assertNoSymlinks(dir) {
				for (const item of await readdir(dir, { withFileTypes: true })) {
					const path = join(dir, item.name);
					assert.ok(!item.isSymbolicLink(), path);
					if (item.isDirectory()) await assertNoSymlinks(path);
				}
			}
			await assertNoSymlinks(installed);
			return { installed, value: (await import(pathToFileURL(join(installed, "index.mjs")).href)).default };
		},
	};
}

test("exports 不开放 package.json：复制传递、已安装 optional 和 peer，过滤开发依赖和不发的平台的包", async (t) => {
	const nativeName = `@fixture/native-${process.platform}-${process.arch}`;
	// Plume 发安装包的另一个平台、架构的预编译包也要带上：dist/ 会进多架构的安装包，打包时再裁。
	const other = TARGETS.find((target) => target !== `${process.platform}-${process.arch}`);
	const [otherOs, otherCpu] = other.split("-");
	const otherName = `@fixture/native-${other}`;
	const f = await fixture(
		t,
		{ "@fixture/native": "0.39.0", "node-pty": "1.0.0" },
		`
		import native from "@fixture/native";
		import pty from "node-pty";
		export default { native, pty };
	`,
	);
	const skipped = [
		"fixture-missing",
		"fixture-missing-peer",
		"fixture-dev",
		"fixture-wrong-os",
		"fixture-wrong-cpu",
		"fixture-blocked-os",
		"fixture-blocked-cpu",
	];
	const native = await f.package(
		"native",
		{
			name: "@fixture/native",
			version: "0.39.0",
			exports: { ".": "./index.cjs" },
			dependencies: { "@fixture/runtime": "1.0.0", "fixture-missing": "1.0.0" },
			optionalDependencies: {
				[nativeName]: "0.39.0",
				[otherName]: "0.39.0",
				"fixture-missing": "1.0.0",
				"fixture-wrong-os": "1.0.0",
				"fixture-wrong-cpu": "1.0.0",
				"fixture-blocked-os": "1.0.0",
				"fixture-blocked-cpu": "1.0.0",
			},
			peerDependencies: { "fixture-peer": "1.0.0", "fixture-missing-peer": "1.0.0" },
			devDependencies: { "fixture-dev": "1.0.0" },
		},
		`module.exports = {
		runtime: require("@fixture/runtime"),
		native: require(${JSON.stringify(nativeName)}),
		peer: require("fixture-peer"),
		asset: require("node:fs").readFileSync(require("node:path").join(__dirname, "asset.txt"), "utf8"),
	};`,
	);
	const runtime = await f.package(
		"runtime",
		{ name: "@fixture/runtime", dependencies: { "fixture-leaf": "1.0.0" } },
		'module.exports = require("fixture-leaf");',
	);
	const leaf = await f.package("leaf", { name: "fixture-leaf" }, 'module.exports = "transitive";');
	const binary = await f.package(
		"binary",
		{ name: nativeName, version: "0.39.0", exports: { ".": "./index.cjs" }, os: [process.platform], cpu: [process.arch] },
		'module.exports = "native";',
	);
	const peer = await f.package("peer", { name: "fixture-peer" }, 'module.exports = "peer";');
	const pty = await f.package(
		"pty",
		{ name: "node-pty" },
		`module.exports = require("node:fs").readFileSync(require("node:path").join(__dirname, "prebuilds", "${process.platform}-${process.arch}", "pty.node"), "utf8");`,
	);
	await f.link(f.plugin, "@fixture/native", native);
	await f.link(f.plugin, "node-pty", pty);
	await f.link(native, "@fixture/runtime", runtime);
	await f.link(runtime, "fixture-leaf", leaf);
	await f.link(native, nativeName, binary);
	const otherBinary = await f.package("other-binary", { name: otherName, version: "0.39.0", os: [otherOs], cpu: [otherCpu] }, 'module.exports = "other";');
	await f.link(native, otherName, otherBinary);
	await f.link(native, "fixture-peer", peer);
	for (const [name, platform] of [
		["fixture-dev", {}],
		["fixture-wrong-os", { os: ["not-this-os"] }],
		["fixture-wrong-cpu", { cpu: ["not-this-cpu"] }],
		// 排除了所有要发的平台（或架构）才不带。
		["fixture-blocked-os", { os: [...new Set(TARGETS.map((target) => `!${target.split("-")[0]}`))] }],
		["fixture-blocked-cpu", { cpu: [...new Set(TARGETS.map((target) => `!${target.split("-")[1]}`))] }],
	]) {
		const pkg = await f.package(name, { name, dependencies: { "fixture-must-not-be-visited": "1.0.0" }, ...platform });
		await f.link(native, name, pkg);
	}
	await writeFile(join(f.source, "asset.txt"), "asset");
	await symlink(join(f.source, "asset.txt"), join(native, "asset.txt"));
	for (const platform of [`${process.platform}-${process.arch}`, other, "other-platform"]) {
		await mkdir(join(pty, "prebuilds", platform), { recursive: true });
		await writeFile(join(pty, "prebuilds", platform, "pty.node"), platform);
	}
	assert.throws(() => createRequire(join(f.plugin, "package.json")).resolve("@fixture/native/package.json"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });

	await buildPlugin(f.plugin);
	const { installed, value } = await f.install();
	assert.deepEqual(value, { native: { runtime: "transitive", native: "native", peer: "peer", asset: "asset" }, pty: `${process.platform}-${process.arch}` });
	const modules = join(installed, "node_modules");
	for (const name of ["@fixture/native", "@fixture/runtime", "fixture-leaf", nativeName, otherName, "fixture-peer", "node-pty"]) {
		assert.ok(existsSync(join(modules, name, "package.json")), name);
	}
	for (const name of skipped) assert.ok(!existsSync(join(modules, name)), name);
	assert.ok(!existsSync(join(modules, "@fixture/native/node_modules")));
	assert.deepEqual((await readdir(join(modules, "node-pty/prebuilds"))).sort(), [`${process.platform}-${process.arch}`, other].sort());
});

test("同名版本冲突嵌套隔离，直接依赖不被抢占，同版本不同源也不能误复用", async (t) => {
	const f = await fixture(
		t,
		{ "fixture-first": "1.0.0", "fixture-second": "1.0.0", "fixture-shared": "2.0.0" },
		`
		import first from "fixture-first";
		import second from "fixture-second";
		import direct from "fixture-shared";
		export default { first, second, direct };
	`,
	);
	const first = await f.package(
		"first",
		{ name: "fixture-first", dependencies: { "fixture-shared": "1.0.0", "fixture-reused": "1.0.0" } },
		'module.exports = { shared: require("fixture-shared"), reused: require("fixture-reused") };',
	);
	const second = await f.package(
		"second",
		{ name: "fixture-second", dependencies: { "fixture-shared": "2.0.0", "fixture-reused": "1.0.0" } },
		'module.exports = { shared: require("fixture-shared"), reused: require("fixture-reused") };',
	);
	const reused = await f.package("reused", { name: "fixture-reused" }, 'module.exports = "reused";');
	await f.link(f.plugin, "fixture-first", first);
	await f.link(f.plugin, "fixture-second", second);
	await f.link(first, "fixture-reused", reused);
	await f.link(second, "fixture-reused", reused);
	for (const [id, parent, version] of [
		["first", first, "1.0.0"],
		["second", second, "2.0.0"],
		["direct", f.plugin, "2.0.0"],
	]) {
		const shared = await f.package(
			`shared-${id}`,
			{ name: "fixture-shared", version, dependencies: { "fixture-context": "1.0.0" } },
			`module.exports = { version: ${JSON.stringify(version)}, context: require("fixture-context") };`,
		);
		const context = await f.package(`context-${id}`, { name: "fixture-context" }, `module.exports = ${JSON.stringify(id)};`);
		await f.link(parent, "fixture-shared", shared);
		await f.link(shared, "fixture-context", context);
	}

	await buildPlugin(f.plugin);
	const { installed, value } = await f.install();
	assert.deepEqual(value, {
		first: { shared: { version: "1.0.0", context: "first" }, reused: "reused" },
		second: { shared: { version: "2.0.0", context: "second" }, reused: "reused" },
		direct: { version: "2.0.0", context: "direct" },
	});
	const modules = join(installed, "node_modules");
	for (const [path, version] of [
		["fixture-shared", "2.0.0"],
		["fixture-first/node_modules/fixture-shared", "1.0.0"],
		["fixture-second/node_modules/fixture-shared", "2.0.0"],
	]) {
		assert.equal(JSON.parse(await readFile(join(modules, path, "package.json"), "utf8")).version, version);
	}
	assert.ok(existsSync(join(modules, "fixture-reused/package.json")));
	for (const name of ["fixture-first", "fixture-second"]) assert.ok(!existsSync(join(modules, name, "node_modules/fixture-reused")));
});

test("循环依赖只复制一次，移走源目录后仍按 Node 解析运行", async (t) => {
	const f = await fixture(t, { "fixture-cycle-a": "1.0.0" }, 'import value from "fixture-cycle-a"; export default value;');
	const a = await f.package(
		"a",
		{ name: "fixture-cycle-a", dependencies: { "fixture-cycle-b": "1.0.0" } },
		'exports.name = "a"; exports.partner = require("fixture-cycle-b").name; exports.cycle = require("fixture-cycle-b").partner;',
	);
	const b = await f.package(
		"b",
		{ name: "fixture-cycle-b", dependencies: { "fixture-cycle-a": "1.0.0" } },
		'exports.name = "b"; exports.partner = require("fixture-cycle-a").name;',
	);
	await f.link(f.plugin, "fixture-cycle-a", a);
	await f.link(a, "fixture-cycle-b", b);
	await f.link(b, "fixture-cycle-a", a);

	await buildPlugin(f.plugin);
	const { installed, value } = await f.install();
	assert.deepEqual(value, { name: "a", partner: "b", cycle: "a" });
	assert.deepEqual((await readdir(join(installed, "node_modules"))).sort(), ["fixture-cycle-a", "fixture-cycle-b"]);
	for (const name of ["fixture-cycle-a", "fixture-cycle-b"]) assert.ok(!existsSync(join(installed, "node_modules", name, "node_modules")));
});

test("复制出的 Mach-O、ELF 补上执行位，其余文件权限不变", { skip: process.platform === "win32" }, async (t) => {
	const f = await fixture(t, { "fixture-pty": "1.0.0" });
	const pty = await f.package("pty", { name: "fixture-pty", dependencies: { "fixture-elf": "1.0.0" } });
	const elf = await f.package("elf", { name: "fixture-elf" });
	await f.link(f.plugin, "fixture-pty", pty);
	await f.link(pty, "fixture-elf", elf);
	const host = `${process.platform}-${process.arch}`;
	// 发布包里没带执行位的预编译程序（node-pty 1.1.0 的 spawn-helper），以及传递依赖里的 ELF。
	const files = {
		[`fixture-pty/prebuilds/${host}/spawn-helper`]: [pty, `prebuilds/${host}/spawn-helper`, Buffer.from("cffaedfe0c000001", "hex"), 0o644],
		"fixture-pty/fat": [pty, "fat", Buffer.from("cafebabe00000002", "hex"), 0o600],
		"fixture-elf/elf.so": [elf, "elf.so", Buffer.from("7f454c4602010100", "hex"), 0o644],
		"fixture-pty/readme.txt": [pty, "readme.txt", "plain text", 0o644],
		"fixture-pty/short": [pty, "short", Buffer.from("7f45", "hex"), 0o644],
		"fixture-pty/script.sh": [pty, "script.sh", "#!/bin/sh\n", 0o755],
	};
	for (const [dir, path, content, mode] of Object.values(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), content);
		await chmod(join(dir, path), mode);
	}

	await buildPlugin(f.plugin);
	const modules = join(f.plugin, "dist/node_modules");
	const expected = {
		[`fixture-pty/prebuilds/${host}/spawn-helper`]: 0o755,
		"fixture-pty/fat": 0o711,
		"fixture-elf/elf.so": 0o755,
		"fixture-pty/readme.txt": 0o644,
		"fixture-pty/short": 0o644,
		"fixture-pty/script.sh": 0o755,
	};
	for (const [path, mode] of Object.entries(expected)) assert.equal((await stat(join(modules, path))).mode & 0o777, mode, path);
	assert.deepEqual(await readFile(join(modules, "fixture-elf/elf.so")), Buffer.from("7f454c4602010100", "hex"));
});

test("直接或传递的必需依赖缺失时报错", async (t) => {
	await t.test("直接依赖缺失", async (t) => {
		const f = await fixture(t, { "fixture-missing-required": "1.0.0" });
		await assert.rejects(buildPlugin(f.plugin), /找不到运行依赖 fixture-missing-required/);
	});
	await t.test("传递依赖缺失", async (t) => {
		const f = await fixture(t, { "fixture-root": "1.0.0" });
		const root = await f.package("root", { name: "fixture-root", dependencies: { "fixture-missing-required": "1.0.0" } });
		await f.link(f.plugin, "fixture-root", root);
		await assert.rejects(buildPlugin(f.plugin), /找不到运行依赖 fixture-missing-required/);
	});
});

test("已安装 optional 包的损坏清单和读取错误不能当成依赖缺失吞掉", async (t) => {
	for (const [kind, title] of [
		["json", "损坏清单"],
		["io", "读取错误"],
		["path", "定位错误"],
	]) {
		await t.test(title, async (t) => {
			const f = await fixture(t, { "fixture-root": "1.0.0" });
			const root = await f.package("root", { name: "fixture-root", optionalDependencies: { "fixture-broken": "1.0.0" } });
			await f.link(f.plugin, "fixture-root", root);
			if (kind === "path") {
				await mkdir(join(root, "node_modules"), { recursive: true });
				await writeFile(join(root, "node_modules/fixture-broken"), "not-a-directory");
			} else {
				const broken = join(f.source, "packages/broken");
				await mkdir(broken, { recursive: true });
				if (kind === "json") await writeFile(join(broken, "package.json"), "{");
				else await mkdir(join(broken, "package.json"));
				await f.link(root, "fixture-broken", broken);
			}
			await assert.rejects(buildPlugin(f.plugin), kind === "json" ? SyntaxError : { code: kind === "io" ? "EISDIR" : "ENOTDIR" });
		});
	}
});

test("打包时按目标裁：别的平台的分包、prebuilds 目录都删掉，目标那份留着", async (t) => {
	const work = await mkdtemp(join(tmpdir(), "plume-trim-native-"));
	t.after(() => rm(work, { recursive: true, force: true }));
	const write = async (path, content) => {
		await mkdir(dirname(join(work, path)), { recursive: true });
		await writeFile(join(work, path), content);
	};
	await write("koffi/package.json", JSON.stringify({ name: "koffi" }));
	for (const target of ["darwin-arm64", "win32-x64", "win32-arm64"]) {
		const [os, cpu] = target.split("-");
		await write(`@koromix/koffi-${target}/package.json`, JSON.stringify({ name: `@koromix/koffi-${target}`, os: [os], cpu: [cpu] }));
		await write(`node-pty/prebuilds/${target}/pty.node`, target);
	}
	await write("node-pty/package.json", JSON.stringify({ name: "node-pty" }));
	await write("node-pty/node_modules/nested/package.json", JSON.stringify({ name: "nested", os: ["darwin"] }));

	const removed = trimNative(work, "win32-x64");
	assert.deepEqual((await readdir(join(work, "@koromix"))).sort(), ["koffi-win32-x64"]);
	assert.deepEqual(await readdir(join(work, "node-pty/prebuilds")), ["win32-x64"]);
	assert.ok(existsSync(join(work, "koffi/package.json")));
	assert.ok(!existsSync(join(work, "node-pty/node_modules/nested")));
	assert.equal(removed.length, 5);
});
