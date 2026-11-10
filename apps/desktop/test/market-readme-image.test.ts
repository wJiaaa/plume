import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openMarket, serveMarket } from "./market-fixture.ts";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test("README 和它的图从市场的 assets/<名字>/ 取，出不了这一层；「试试这样问」读自索引", async (t) => {
	const served = await serveMarket(t);
	await served.publish([
		{
			id: "demo",
			version: "1.0.0",
			readme: "# Demo\n\n![](images/shot.png)\n",
			assets: { "images/shot.png": PNG, "images/notes.txt": Buffer.from("不是图") },
			extra: { prompts: ["画一只猫", "", 3] },
		},
	]);
	await writeFile(join(served.root, "secret.png"), PNG);
	const { market } = await openMarket(t, served.url);

	assert.deepEqual((await market.read()).entries.find((entry) => entry.id === "demo")?.prompts, ["画一只猫"]);
	assert.equal(await market.readme("demo"), "# Demo\n\n![](images/shot.png)\n");
	assert.equal(await market.readmeImage("demo", "images/shot.png"), `data:image/png;base64,${PNG.toString("base64")}`);
	const bad = [
		"images/notes.txt",
		"../secret.png",
		"images/../../secret.png",
		"/images/shot.png",
		"images\\shot.png",
		"%2e%2e/%2e%2e/secret.png",
		"images/%2E%2E/../secret.png",
		"",
	];
	for (const path of bad) assert.equal(await market.readmeImage("demo", path), null, path);
	assert.equal(await market.readmeImage("../demo", "images/shot.png"), null);
	assert.equal(served.requests.includes("/secret.png"), false);
});

test("市场里没有的插件，README 的图从装下的目录读，符号链接出不了目录", async (t) => {
	const served = await serveMarket(t);
	await served.publish([]);
	const { market, work, installDir } = await openMarket(t, served.url);
	const source = join(work, "elsewhere/mine");
	await mkdir(join(source, "dist"), { recursive: true });
	await mkdir(join(source, "images"), { recursive: true });
	await writeFile(join(source, "dist/index.mjs"), "export default {};");
	await writeFile(join(source, "package.json"), JSON.stringify({ name: "mine" }));
	await writeFile(join(source, "README.md"), "本机的介绍");
	await writeFile(join(source, "images/shot.png"), PNG);
	assert.deepEqual(await market.installFolder(source), { ok: true });

	assert.equal(await market.readme("mine"), "本机的介绍");
	assert.equal(await market.readmeImage("mine", "images/shot.png"), `data:image/png;base64,${PNG.toString("base64")}`);
	await writeFile(join(work, "secret.png"), PNG);
	await rm(join(installDir, "mine/images/shot.png"));
	await symlink(join(work, "secret.png"), join(installDir, "mine/images/shot.png"));
	assert.equal(await market.readmeImage("mine", "images/shot.png"), null);
});
