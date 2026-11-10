/**
 * 刷新打包的模型目录快照 `packages/core/llm/src/catalog/model-catalog.json`。
 *
 * 运行中的应用会自己从 pi 拉最新目录，这份快照只在首次启动和离线时兜底；发版前刷新一次即可。
 * 压缩逻辑与运行时同步共用 `compactPiCatalog`，两边写出来的是同一种格式。
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compactPiCatalog, MODEL_CATALOG_URL } from "../packages/core/llm/src/model-catalog-format.ts";

const OUTPUT = resolve("packages/core/llm/src/catalog/model-catalog.json");

const response = await fetch(MODEL_CATALOG_URL, { headers: { accept: "application/json", "user-agent": "Plume catalogue updater" } });
if (!response.ok) throw new Error(`${MODEL_CATALOG_URL} returned ${response.status}`);
const revision = response.headers.get("x-pi-model-catalog-revision");
if (!revision) throw new Error("response has no x-pi-model-catalog-revision header");
const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
const catalog = compactPiCatalog(await response.json(), {
	name: "pi.dev",
	url: MODEL_CATALOG_URL,
	revision,
	updatedAt: new Date(Number.isNaN(lastModified) ? Date.now() : lastModified).toISOString(),
});

await writeFile(OUTPUT, `${JSON.stringify(catalog)}\n`, "utf8");
const models = catalog.providers.reduce((sum, provider) => sum + provider.models.length, 0);
console.log(`Wrote ${catalog.providers.length} providers and ${models} models (${revision.slice(0, 19)}) to ${OUTPUT}`);
