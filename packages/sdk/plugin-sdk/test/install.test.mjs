import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installPlugin } from "../lib/install.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=", "base64");

test("安装和重新安装带上根目录图标，缺图标仍可安装且不会残留旧图标", (t) => {
	const work = mkdtempSync(join(tmpdir(), "plume-install-icon-"));
	t.after(() => rmSync(work, { recursive: true, force: true }));
	const source = join(work, "example");
	const root = join(work, "plugins");
	mkdirSync(join(source, "dist"), { recursive: true });
	writeFileSync(join(source, "dist/index.mjs"), "export default {};");
	writeFileSync(join(source, "package.json"), JSON.stringify({ name: "example" }));
	writeFileSync(join(source, "README.md"), "说明");
	writeFileSync(join(source, "source.ts"), "不发源码");

	const target = installPlugin(source, root);
	assert.equal(existsSync(join(target, "icon.png")), false);
	writeFileSync(join(source, "icon.png"), PNG);
	installPlugin(source, root);
	assert.deepEqual(readFileSync(join(target, "icon.png")), PNG);
	assert.equal(readFileSync(join(target, "README.md"), "utf8"), "说明");
	assert.equal(existsSync(join(target, "dist/index.mjs")), true);
	assert.equal(existsSync(join(target, "source.ts")), false);

	const changed = Buffer.concat([PNG, Buffer.from([0])]);
	writeFileSync(join(source, "icon.png"), changed);
	installPlugin(source, root);
	assert.deepEqual(readFileSync(join(target, "icon.png")), changed);
	rmSync(join(source, "icon.png"));
	installPlugin(source, root);
	assert.equal(existsSync(join(target, "icon.png")), false);
});
