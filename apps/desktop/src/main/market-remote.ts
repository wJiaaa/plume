/**
 * 插件市场在网上的那一半：读索引、取图标和介绍、下载插件包并核对、解开。
 *
 * 市场是插件仓库 plume-plugins 发到 GitHub Pages 的一个静态目录（格式见插件仓库的 docs/distribution.md）：
 * `marketplace.json` 列出插件和每个平台的包，包按 `plugins/<名字>/<版本>/<平台>-<架构>.tgz` 放，版本发出去就不变；
 * 图标、README 和它引用的图在 `assets/<名字>/` 下，安装前就能画。开发版、装好的应用都用线上这一个市场；冒烟缺省也用它，
 * 给了本地构建的市场目录时换成本机起的服务（scripts/smoke.mjs 的 PLUME_SMOKE_MARKET）。
 *
 * 只认 https；http 只给本机（127.0.0.1、localhost），那是测试和冒烟起的服务。包的大小和 SHA-256 都要和索引一致才解开，
 * 解开的是这个平台的那一份，不再裁原生模块。
 *
 * 不引用 electron，测试才能直接加载它。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginManifest } from "@plume/contract";
import { PLUGIN_ENTRY, readCatalogInfo } from "@plumeai/plugin-sdk/manifest";
import type { MarketEntry, MarketInfo } from "../shared/market.ts";

/** 索引不该有这么大；再大就是出错了。 */
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_ICON_BYTES = 1024 * 1024;
const MAX_README_BYTES = 1024 * 1024;
/** README 里的一张图：和网上文档里的图同一个上限。 */
export const MAX_README_IMAGE_BYTES = 5 * 1024 * 1024;
/** 一个平台的插件包（最大的是带着 node-pty 的终端，十来 MB）。 */
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const INDEX_TIMEOUT_MS = 15_000;
const PACKAGE_TIMEOUT_MS = 5 * 60_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 线上的市场：插件仓库 wJiaaa/plume-plugins 发到 GitHub Pages 的目录。 */
export const MARKET_URL = "https://wjiaaa.github.io/plume-plugins/marketplace.json";

/** 这台机器要的那份包：`<平台>-<架构>`。 */
export const TARGET = `${process.platform}-${process.arch}`;

/** 目录里的一条：给界面的说明，加上这台机器那份包在哪、该是什么样，介绍放在哪。 */
export interface RemoteEntry {
	info: MarketEntry;
	build: { url: URL; sha256: string; size: number };
	readme?: URL;
	/** `assets/<名字>/`：README 里相对路径的图从这里取。 */
	assets: URL;
}

/** 下载的包和索引对不上（大小、SHA-256），或者解不开、解出来不是构建好的插件。 */
export class PackageError extends Error {
	readonly kind: "mismatch" | "unpack";
	constructor(kind: "mismatch" | "unpack", message: string) {
		super(message);
		this.kind = kind;
	}
}

/** 市场地址能不能用：https，或者本机的 http。 */
export function allowedUrl(url: URL): boolean {
	return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
}

/** 取一个地址的内容，超过 limit 就停：先看 Content-Length，再边读边数（没写长度或写少了的照样拦得住）。 */
export async function fetchBytes(url: URL, limit: number, timeoutMs: number): Promise<Buffer> {
	if (!allowedUrl(url)) throw new Error(`${url.protocol}//${url.host} is not an allowed marketplace address`);
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
	if (Number(response.headers.get("content-length") ?? 0) > limit) throw new Error(`${url.pathname}: too large`);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of response.body ?? []) {
		size += chunk.length;
		if (size > limit) throw new Error(`${url.pathname}: too large`);
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/** 图标按地址记着：同一个版本的图标不会变，换了版本地址也换了。 */
const icons = new Map<string, Promise<string | undefined>>();

function iconOf(url: URL): Promise<string | undefined> {
	const key = url.href;
	let icon = icons.get(key);
	if (!icon) {
		icon = fetchBytes(url, MAX_ICON_BYTES, INDEX_TIMEOUT_MS).then(
			(bytes) =>
				bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
					? `data:image/png;base64,${bytes.toString("base64")}`
					: undefined,
			() => {
				// 这次没取到，下次再试。
				icons.delete(key);
				return undefined;
			},
		);
		icons.set(key, icon);
	}
	return icon;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** 插件的说明给界面的样子：显示名没写用目录名，说明没写是空串。 */
export function marketInfo(id: string, { displayName, description, ...rest }: PluginManifest): MarketInfo {
	return { id, name: displayName ?? id, description: description ?? "", ...rest };
}

/**
 * 读索引，只留这台机器有包的插件。字段类型不对的当没写；名字不合规矩、没有说明或版本、包的登记不全的整条跳过，
 * 一条坏的不拖垮整个市场。
 */
export async function fetchCatalog(indexUrl: string, target = TARGET): Promise<RemoteEntry[]> {
	const base = new URL(indexUrl);
	const index = JSON.parse((await fetchBytes(base, MAX_INDEX_BYTES, INDEX_TIMEOUT_MS)).toString("utf8")) as { plugins?: unknown };
	if (!Array.isArray(index.plugins)) throw new Error("marketplace.json has no plugins");
	const found: { entry: RemoteEntry; icon?: URL }[] = [];
	for (const raw of index.plugins as Record<string, unknown>[]) {
		const catalogInfo = readCatalogInfo(raw);
		if (!catalogInfo?.version) continue;
		const { name: id, ...manifest } = catalogInfo;
		const builds = (typeof raw?.builds === "object" && raw.builds !== null ? raw.builds : {}) as Record<string, Record<string, unknown> | undefined>;
		const build = builds[target];
		const path = text(build?.path);
		const sha256 = text(build?.sha256)?.toLowerCase();
		const size = build?.size;
		if (!path || !sha256 || !/^[0-9a-f]{64}$/.test(sha256) || typeof size !== "number") continue;
		const info: MarketEntry = marketInfo(id, manifest);
		const readme = text(raw.readme);
		const icon = text(raw.icon);
		found.push({
			entry: {
				info,
				build: { url: new URL(path, base), sha256, size },
				...(readme ? { readme: new URL(readme, base) } : {}),
				assets: new URL(`assets/${id}/`, base),
			},
			...(icon ? { icon: new URL(icon, base) } : {}),
		});
	}
	// 图标一起取，取不到的就不画。
	await Promise.all(
		found.map(async ({ entry, icon }) => {
			const logo = icon ? await iconOf(icon) : undefined;
			if (logo) entry.info.logo = logo;
		}),
	);
	return found.map(({ entry }) => entry);
}

/** 取介绍；没有或取不到是 null。 */
export async function fetchReadme(url: URL): Promise<string | null> {
	const body = await fetchBytes(url, MAX_README_BYTES, INDEX_TIMEOUT_MS).catch(() => null);
	const text = body?.toString("utf8");
	return text?.trim() ? text : null;
}

/** 下载这台机器的那份包，核对大小和 SHA-256，解进 `into`（要是空的）。对不上、解不开都抛 PackageError。 */
export async function downloadPackage(entry: RemoteEntry, into: string): Promise<void> {
	const bytes = await fetchBytes(entry.build.url, MAX_PACKAGE_BYTES, PACKAGE_TIMEOUT_MS);
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (bytes.length !== entry.build.size || actual !== entry.build.sha256)
		throw new PackageError(
			"mismatch",
			`expected ${entry.build.size} bytes ${entry.build.sha256.slice(0, 12)}…, got ${bytes.length} bytes ${actual.slice(0, 12)}…`,
		);
	await mkdir(into, { recursive: true });
	const archive = `${into}.tgz`;
	await writeFile(archive, bytes);
	try {
		await untar(archive, into);
	} finally {
		await rm(archive, { force: true });
	}
	if (!existsSync(join(into, PLUGIN_ENTRY))) throw new PackageError("unpack", `${PLUGIN_ENTRY} missing`);
}

/**
 * 用系统的 tar 解开（macOS、Windows 10 起都带 bsdtar）：它拒绝绝对路径和 `..`，不会写到 `into` 外面。
 * Windows 上不弹控制台窗口。
 */
function untar(archive: string, into: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("tar", ["-xzf", archive, "-C", into], { windowsHide: true, timeout: PACKAGE_TIMEOUT_MS }, (error, _stdout, stderr) =>
			error ? reject(new PackageError("unpack", String(stderr).trim() || error.message)) : resolve(),
		);
	});
}
