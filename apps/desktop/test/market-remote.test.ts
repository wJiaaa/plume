import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { allowedUrl, fetchBytes, TARGET } from "../src/main/market-remote.ts";
import { openMarket, serveMarket } from "./market-fixture.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=", "base64");
const plugin = (id: string, version: string, body = "export default {};") => ({
	id,
	version,
	files: { "package.json": JSON.stringify({ name: id, version, plume: { displayName: id } }), "dist/index.mjs": body },
});

test("目录读自索引：只留这台机器有包、字段齐全的条目，图标是 PNG 才画", async (t) => {
	const served = await serveMarket(t);
	const index = await served.publish([
		{ ...plugin("good", "1.0.0"), icon: PNG, extra: { category: "开发", keywords: ["a", 1, ""] } },
		{ ...plugin("plain", "1.0.0"), icon: Buffer.from("not a PNG") },
	]);
	const builds = { [TARGET]: (index.plugins[0].builds as Record<string, unknown>)[TARGET] };
	await served.writeIndex({
		plugins: [
			...index.plugins,
			{ name: "Bad Name", description: "x", version: "1.0.0", builds },
			{ name: "no-version", description: "x", builds },
			{ name: "other-target", description: "x", version: "1.0.0", builds: { "plan9-mips": builds[TARGET] } },
			{ name: "bad-sha", description: "x", version: "1.0.0", builds: { [TARGET]: { path: "x.tgz", sha256: "abc", size: 1 } } },
			null,
		],
	});
	const { market } = await openMarket(t, served.url);
	const state = await market.read();
	assert.equal(state.catalogError, undefined);
	assert.deepEqual(
		state.entries.map((entry) => entry.id),
		["good", "plain"],
	);
	const [good, plain] = state.entries;
	assert.equal(good.logo, `data:image/png;base64,${PNG.toString("base64")}`);
	assert.equal(good.category, "开发");
	assert.deepEqual(good.keywords, ["a"]);
	assert.equal(good.version, "1.0.0");
	assert.equal(Object.hasOwn(plain, "logo"), false);
});

test("安装下载这台机器的包、核对后解开；按版本号判断更新，同一版本换了内容不算", async (t) => {
	const served = await serveMarket(t);
	await served.publish([{ ...plugin("example", "1.0.0"), icon: PNG }]);
	const { market, installDir, added, removed } = await openMarket(t, served.url);
	assert.deepEqual(await market.install("example"), { ok: true });
	const target = join(installDir, "example");
	assert.equal(await readFile(join(target, "dist/index.mjs"), "utf8"), "export default {};");
	assert.deepEqual(added, ["example"]);
	let state = await market.read();
	assert.equal(state.installed[0].version, "1.0.0");
	assert.equal(state.installed[0].source, "market");
	assert.deepEqual(state.updates.outdated, []);

	await served.publish([plugin("example", "1.0.0", "export default { same: 1 };")]);
	assert.deepEqual((await market.read()).updates.outdated, []);

	await served.publish([plugin("example", "1.1.0", "export default { v: 2 };")]);
	state = await market.read();
	assert.deepEqual(state.updates.outdated, [{ id: "example", name: "example", version: "1.1.0" }]);
	await market.update();
	assert.match(await readFile(join(target, "dist/index.mjs"), "utf8"), /v: 2/);
	assert.deepEqual(removed, ["example"]);
	assert.deepEqual((await market.read()).updates.outdated, []);
});

test("包和登记的不一致、解不开、解出来不是构建好的插件都不装，装着的那份不动", async (t) => {
	const served = await serveMarket(t);
	await served.publish([plugin("example", "1.0.0")]);
	const { market, installDir } = await openMarket(t, served.url);
	assert.deepEqual(await market.install("example"), { ok: true });
	const installed = join(installDir, "example/dist/index.mjs");

	// 包被换过：大小、SHA-256 对不上。
	await served.publish([plugin("example", "2.0.0", "export default { v: 2 };")]);
	await writeFile(join(served.root, `plugins/example/2.0.0/${TARGET}.tgz`), "tampered");
	await market.read();
	let state = await market.update(["example"]);
	assert.equal(state.failed[0]?.id, "example");
	assert.match(state.failed[0].message, /不一致|doesn't match/);
	assert.equal(await readFile(installed, "utf8"), "export default {};");

	// 解出来没有 dist/index.mjs。
	await served.publish([{ id: "example", version: "3.0.0", files: { "package.json": "{}" } }]);
	await market.read();
	state = await market.update(["example"]);
	assert.match(state.failed[0]?.message ?? "", /dist\/index\.mjs/);
	assert.equal(await readFile(installed, "utf8"), "export default {};");
	assert.deepEqual(await readFile(join(installDir, "../.plugins-staging/example")).catch((error: NodeJS.ErrnoException) => error.code), "ENOENT");
});

test("连不上市场时说出原因，列出上次读到的目录", async (t) => {
	const served = await serveMarket(t);
	await served.publish([plugin("example", "1.0.0")]);
	const { market, logs } = await openMarket(t, served.url);
	assert.deepEqual(
		(await market.read()).entries.map((entry) => entry.id),
		["example"],
	);
	await served.writeIndex("{ broken");
	const state = await market.read();
	assert.ok(state.catalogError);
	assert.deepEqual(
		state.entries.map((entry) => entry.id),
		["example"],
	);
	assert.ok(logs.some((line) => line.includes("读不到插件市场")));

	const { market: offline } = await openMarket(t, "http://127.0.0.1:1/marketplace.json");
	const empty = await offline.read();
	assert.ok(empty.catalogError);
	assert.deepEqual(empty.entries, []);
});

test("市场地址只认 https 和本机 http；取内容超过上限就停", async (t) => {
	assert.equal(allowedUrl(new URL("https://example.com/marketplace.json")), true);
	for (const url of ["http://127.0.0.1:8080/m.json", "http://localhost/m.json", "http://[::1]/m.json"]) assert.equal(allowedUrl(new URL(url)), true, url);
	for (const url of ["http://example.com/m.json", "file:///etc/passwd", "ftp://example.com/m.json"]) assert.equal(allowedUrl(new URL(url)), false, url);
	await assert.rejects(fetchBytes(new URL("http://example.com/m.json"), 10, 1000), /not an allowed/);

	const served = await serveMarket(t);
	await writeFile(join(served.root, "big.bin"), Buffer.alloc(64));
	assert.equal((await fetchBytes(new URL("big.bin", served.base), 64, 5000)).length, 64);
	await assert.rejects(fetchBytes(new URL("big.bin", served.base), 63, 5000), /too large/);
});
