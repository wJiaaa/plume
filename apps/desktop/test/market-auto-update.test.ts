import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openMarket, serveMarket } from "./market-fixture.ts";

const plugin = (id: string, version: string, body = "export default {};") => ({
	id,
	version,
	files: { "package.json": JSON.stringify({ name: id, version }), "dist/index.mjs": body },
});

/** 装上 1.0.0，市场随后发出 1.1.0：落后一版，等着更新。 */
async function behindOneVersion(t: test.TestContext, busy: () => boolean) {
	const served = await serveMarket(t);
	await served.publish([plugin("example", "1.0.0")]);
	const opened = await openMarket(t, served.url, { busy });
	assert.deepEqual(await opened.market.install("example"), { ok: true });
	await served.publish([plugin("example", "1.1.0", "export default { v: 2 };")]);
	return { ...opened, target: join(opened.installDir, "example/dist/index.mjs") };
}

test("自动更新等会话空闲：有会话在跑时不换插件、照常列出有更新，闲下来后重试时换上", async (t) => {
	let busy = true;
	let asked = 0;
	const { market, added, removed, target } = await behindOneVersion(t, () => (asked++, busy));
	t.mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => market.stop());

	let state = await market.setAutoUpdate(true);
	assert.deepEqual(state.outdated, [{ id: "example", name: "example", version: "1.1.0" }]);
	assert.deepEqual(removed, []);
	assert.deepEqual(added, ["example"]);
	// 又看了一次（市场页读目录）：还在等，不再多起一个重试。
	state = (await market.read()).updates;
	assert.deepEqual(state.outdated, [{ id: "example", name: "example", version: "1.1.0" }]);
	assert.equal(asked, 2);

	// 一分钟后还在忙：接着等。
	t.mock.timers.tick(60_000);
	// 人点「更新」排在重试后面，传空名单什么都不换，只为等重试做完。
	await market.update([]);
	assert.equal(asked, 3);
	assert.deepEqual(removed, []);

	busy = false;
	t.mock.timers.tick(60_000);
	await market.update([]);
	assert.equal(asked, 4);
	assert.deepEqual(removed, ["example"]);
	assert.deepEqual(added, ["example", "example"]);
	assert.match(await readFile(target, "utf8"), /v: 2/);
	assert.deepEqual((await market.update([])).outdated, []);
});

test("人点的更新不看会话忙不忙", async (t) => {
	let asked = 0;
	const { market, removed, target } = await behindOneVersion(t, () => (asked++, true));
	await market.read();
	await market.update();
	assert.deepEqual(removed, ["example"]);
	assert.match(await readFile(target, "utf8"), /v: 2/);
	// 自动更新关着（夹具的缺省），read 也不问。
	assert.equal(asked, 0);
});
