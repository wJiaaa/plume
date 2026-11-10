import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("每个内置插件都有可分发的独立正方形 PNG 图标", () => {
	const seen = new Set<string>();
	// 市场插件的图标由插件仓库的 scripts/validate.mjs 查。
	for (const root of ["packages/builtin/"]) {
		const directory = fileURLToPath(new URL(`../../../${root}`, import.meta.url));
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const dir = join(directory, entry.name);
			if (!entry.isDirectory() || !existsSync(join(dir, "package.json"))) continue;
			const icon = readFileSync(join(dir, "icon.png"));
			const label = `${root}${entry.name}`;
			assert.ok(icon.length <= 256 * 1024, `${label} 图标不超过 256 KiB`);
			assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${label} 是 PNG`);
			assert.equal(icon.toString("ascii", 12, 16), "IHDR");
			assert.ok(icon.readUInt32BE(16) > 0);
			assert.equal(icon.readUInt32BE(16), icon.readUInt32BE(20), `${label} 图标是正方形`);
			const hash = createHash("sha256").update(icon).digest("hex");
			assert.ok(!seen.has(hash), `${label} 不与其他插件共用图标`);
			seen.add(hash);
		}
	}
	assert.ok(seen.size > 0);
});
