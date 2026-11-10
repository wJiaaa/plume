import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openMarket, serveMarket } from "./market-fixture.ts";

async function plugin(dir: string, body = "export default {};") {
	await mkdir(join(dir, "dist"), { recursive: true });
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, "dist/index.mjs"), body);
	await writeFile(join(dir, "src/index.ts"), "源码不发");
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "mine", plume: { displayName: "我的插件" } }));
}

/** 「从文件夹安装」不经市场；市场照常连着一个空目录。 */
async function fixture(t: TestContext) {
	const served = await serveMarket(t);
	await served.publish([]);
	return openMarket(t, served.url);
}

test("从文件夹安装：只复制发给插件的文件，加载上，列进已装；再装一次换成新的一份", async (t) => {
	const { market, work, added, removed } = await fixture(t);
	const source = join(work, "elsewhere/mine");
	await plugin(source);
	assert.deepEqual(await market.installFolder(source), { ok: true });
	const target = join(work, "plugins/mine");
	assert.equal(await readFile(join(target, "dist/index.mjs"), "utf8"), "export default {};");
	await assert.rejects(readFile(join(target, "src/index.ts")));
	assert.deepEqual(added, ["mine"]);
	const have = (await market.read()).installed.find((item) => item.id === "mine");
	assert.equal(have?.source, "market");
	assert.equal(have?.name, "我的插件");

	await writeFile(join(source, "dist/index.mjs"), "export default { name: 'v2' };");
	assert.deepEqual(await market.installFolder(source), { ok: true });
	assert.deepEqual(removed, ["mine"]);
	assert.match(await readFile(join(target, "dist/index.mjs"), "utf8"), /v2/);
});

test("从文件夹安装：不是构建好的插件、目录名不合规矩、和内置插件重名的都不装", async (t) => {
	const { market, work, added } = await fixture(t);
	const unbuilt = join(work, "unbuilt");
	await mkdir(unbuilt, { recursive: true });
	assert.deepEqual(await market.installFolder(unbuilt), { ok: false, error: "invalid" });
	const badName = join(work, "My Plugin");
	await plugin(badName);
	assert.deepEqual(await market.installFolder(badName), { ok: false, error: "invalid" });
	assert.deepEqual(await market.installFolder("relative/mine"), { ok: false, error: "invalid" });
	await plugin(join(work, "builtin/core"));
	await plugin(join(work, "elsewhere/core"));
	assert.deepEqual(await market.installFolder(join(work, "elsewhere/core")), { ok: false, error: "builtin" });
	assert.deepEqual(added, []);
});
