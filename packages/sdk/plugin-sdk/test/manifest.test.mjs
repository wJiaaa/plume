import assert from "node:assert/strict";
import test from "node:test";
import { manifestProblems, readCatalogInfo, readManifest } from "../lib/manifest.mjs";

test("package.json 读成说明：去掉空白，类型不对的、空的当没写，kind 缺省是普通插件", () => {
	const manifest = readManifest({
		version: "1.2.0",
		description: "  说明 ",
		author: { name: "Plume" },
		keywords: ["a", 1, " ", "b "],
		homepage: 3,
		plume: { displayName: "名字", category: "开发", defaultPrompt: [] },
	});
	assert.deepEqual(manifest, {
		kind: "plugin",
		displayName: "名字",
		description: "说明",
		version: "1.2.0",
		author: "Plume",
		category: "开发",
		keywords: ["a", "b"],
	});
	assert.deepEqual(readManifest(null), { kind: "plugin" });
	assert.equal(readManifest({ plume: { kind: "connector" } }).kind, "connector");
	assert.equal(readManifest({ plume: { kind: "theme" } }).kind, "plugin");
});

test("市场目录里的一条和打包时写的那份对得上；目录名不合规矩的不要", () => {
	const manifest = readManifest({ version: "1.0.0", description: "x", plume: { kind: "skill", displayName: "技能", defaultPrompt: ["试试"] } });
	const written = JSON.parse(JSON.stringify({ name: "skills-pack", ...manifest, builds: {} }));
	assert.deepEqual(readCatalogInfo(written), { name: "skills-pack", ...manifest });
	assert.equal(readCatalogInfo({ name: "Bad Name", description: "x" }), null);
	assert.equal(readCatalogInfo({ description: "x" }), null);
	assert.equal(readCatalogInfo({ name: "old", version: "1.0.0" })?.kind, "plugin");
});

test("发到市场前缺了哪些说明，一样一句", () => {
	assert.deepEqual(manifestProblems({ version: "1.0.0", description: "x", plume: { displayName: "名字", kind: "skill" } }), []);
	assert.equal(manifestProblems({}).length, 3);
	assert.match(manifestProblems({ version: "1.0", description: "x", plume: { displayName: "名字" } })[0], /x\.y\.z/);
	assert.match(manifestProblems({ version: "1.0.0", description: "x", plume: { displayName: "名字", kind: "theme" } })[0], /plume\.kind/);
});
