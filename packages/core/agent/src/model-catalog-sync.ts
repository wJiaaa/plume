/**
 * 模型目录的拉取与缓存。
 *
 * 唯一的来源是 pi 的公开目录。agent 进程启动时先读缓存，之后定时拉一次，设置页也能手动触发。
 * 带上次的 ETag 做条件请求，没变时服务器回 304，不重复下载近 1MB 的原始数据。拉到的内容压成用得到的几项、
 * 整份校验，比当前的新才换上，并缓存到 cacheFile（`~/.plume/model-catalog.json`）。任何一步失败都保持现有目录——
 * 打包的快照只在首次启动和离线时兜底。目录只是新建模型时填值的参考，换了不动已有配置。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CatalogSyncResult } from "@plume/contract";
import { activeModelCatalog, installModelCatalog } from "@plume/llm/model-catalog";
import { compactPiCatalog, MODEL_CATALOG_URL, type ModelCatalogDocument, parseModelCatalog } from "@plume/llm/model-catalog-format";
import { writeFileAtomic } from "./atomic-write.ts";

/** 自动同步的间隔。目录变化以天计，一小时一次足够及时；没变时只是一个 304。 */
export const MODEL_CATALOG_SYNC_INTERVAL_MS = 60 * 60 * 1000;

interface CachedCatalog {
	etag?: string;
	document: ModelCatalogDocument;
}

async function readCache(cacheFile: string): Promise<CachedCatalog | null> {
	try {
		const cached: unknown = JSON.parse(await readFile(cacheFile, "utf8"));
		if (!cached || typeof cached !== "object") return null;
		const { etag, document } = cached as { etag?: unknown; document?: unknown };
		return { ...(typeof etag === "string" ? { etag } : {}), document: parseModelCatalog(document) };
	} catch {
		return null;
	}
}

/** 启动时换上上次缓存的目录。没有或坏了就当没有。返回是否换上了。 */
export async function loadCachedModelCatalog(cacheFile: string): Promise<boolean> {
	const cached = await readCache(cacheFile);
	return cached ? installModelCatalog(cached.document) : false;
}

/** 拉一次目录。不抛：网络不通、非 200、内容不合法都返回 `failed` 和原因，现有目录不动。 */
export async function syncModelCatalog(cacheFile: string, options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {}): Promise<CatalogSyncResult> {
	const failed = (error: string): CatalogSyncResult => ({ status: "failed", error, source: activeModelCatalog().source });
	try {
		const cached = await readCache(cacheFile);
		// ETag 只在那份缓存正是当前生效的目录时才用：否则一个 304 会让缓存坏掉之后永远拉不到新的。
		const etag = cached?.document.source.revision === activeModelCatalog().source.revision ? cached.etag : undefined;
		const response = await (options.fetch ?? globalThis.fetch)(MODEL_CATALOG_URL, {
			headers: { accept: "application/json", "user-agent": "Plume", ...(etag ? { "if-none-match": etag } : {}) },
			signal: options.signal ?? AbortSignal.timeout(30_000),
		});
		if (response.status === 304) return { status: "unchanged", source: activeModelCatalog().source };
		if (!response.ok) return failed(`HTTP ${response.status}`);
		const body = await response.text();
		const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
		const document = compactPiCatalog(JSON.parse(body), {
			name: "pi.dev",
			url: MODEL_CATALOG_URL,
			revision: response.headers.get("x-pi-model-catalog-revision") ?? `sha256-${createHash("sha256").update(body).digest("hex")}`,
			updatedAt: new Date(Number.isNaN(lastModified) ? Date.now() : lastModified).toISOString(),
		});
		const updated = installModelCatalog(document);
		const etagNow = response.headers.get("etag");
		const cache: CachedCatalog = { ...(etagNow ? { etag: etagNow } : {}), document: updated ? document : activeModelCatalog() };
		await mkdir(dirname(cacheFile), { recursive: true });
		// 先写临时文件再改名，崩溃时不会留下半个文件；写不进去只是下次启动没有缓存。
		await writeFileAtomic(cacheFile, JSON.stringify(cache)).catch(() => undefined);
		return { status: updated ? "updated" : "unchanged", source: activeModelCatalog().source };
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
}
