/**
 * 插件市场的主进程一侧：读目录、装、卸、更新，以及「装过的自己跟上新版」。
 *
 * 目录在网上（market-remote.ts）：装上是下载这台机器的那份包、核对后解进安装目录，再让 agent 进程加载；
 * 不用重启，界面经 agent 的 plugins 事件跟着变。连不上市场时目录用上次读到的（一次都没读到就是空的），已装的插件照常用。
 *
 * 本地上传的（「从本地上传」、`plume-plugin install`/`dev`）放在另一个目录（`uploadDir`），能卸，但不跟市场更新：
 * 和市场装的同名时它生效，市场那份留着不加载，卸掉本地那份就接着用市场那份。同名时生效的顺序见 `found`。
 *
 * 更新按版本号判断：目录里的版本比装下的新就是有新版（发出去的版本不可变，插件仓库发布时查）。
 * 自动更新缺省开，启动一会儿后看一次，之后每 30 分钟、以及每次市场页读目录时再看；一次只换一个，
 * 先下载到暂存目录、换好再让 agent 进程重新加载，失败了原来那份不动。
 *
 * 安装目录、本地上传目录和本机目录也盯着：插件作者 `plume-plugin install`/`dev` 装进来的、手动放进来或删掉的，
 * 不用重启，当场加载、按新文件重新加载或卸下。判断同样看文件指纹，市场自己装卸引起的变化不会再处理一遍。
 *
 * 内置插件在另一个目录（`builtinDir`）：随应用发，直接从那里加载、排在最前，市场不列、不能卸。
 * 别的目录里和它同名的不加载。
 */

import { createHash } from "node:crypto";
import { constants, existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { cp, mkdir, open, readdir, readFile, realpath, rm, stat as statOf, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { DIR_NAME, PLUGIN_ENTRY, readManifest, SHIPPED } from "@plumeai/plugin-sdk/manifest";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { InstalledPlugin, MarketEntry, MarketInfo, MarketResult, MarketState, PluginUpdateState } from "../shared/market.ts";
import type { PluginDir } from "../shared/protocol.ts";
import { discoverPlugins } from "./discover.ts";
import { nativeText } from "./i18n.ts";
import { resolvedLocale } from "./locale.ts";
import { downloadPackage, fetchBytes, fetchCatalog, fetchReadme, MAX_README_IMAGE_BYTES, marketInfo, PackageError, type RemoteEntry } from "./market-remote.ts";
import { discard, swapIn } from "./plugin-swap.ts";
import { heldOpen } from "./rename-retry.ts";
import { isNewer } from "./update/version.ts";

/** 启动后多久第一次看：窗口先起来、会话先恢复，这件事不急于那几秒。 */
const FIRST_CHECK_MS = 40_000;
/** 之后多久看一次。 */
const CHECK_EVERY_MS = 30 * 60_000;
/** 目录变了等它停一会儿再看：一次安装会连着改好多文件。 */
const SETTLE_MS = 300;
/** 市场的目录读过以后多久内不再读：装、卸、对账都用这份；市场页每次打开和定时检查时重读。 */
const CATALOG_FRESH_MS = 5 * 60_000;

/** 图标随目录下发给界面，限制单张大小，避免坏文件撑大市场数据。 */
const MAX_ICON_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const README_IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

export interface MarketOptions {
	/** 市场目录 marketplace.json 的地址：插件仓库的 GitHub Pages（测试换成本机起的服务）。 */
	catalogUrl: string;
	/** 内置插件的目录，每个一个子目录。 */
	builtinDir: string;
	/** 从市场装的插件放这里，每个一个子目录。 */
	installDir: string;
	/** 本地上传的插件放这里，每个一个子目录；和 installDir 在同一个上级目录下。 */
	uploadDir: string;
	/** 市场自己的设置（自动更新开关）。 */
	settingsFile: string;
	/** plume-plugin:// 按它找插件目录，装卸时跟着改。 */
	pluginDirs: Map<string, string>;
	/** agent 进程：装上、卸下一个插件。 */
	agent: { addPlugin(dir: PluginDir): Promise<unknown>; removePlugin(key: string): Promise<unknown> };
	/** 更新状态变了，告诉所有窗口。 */
	announce(state: PluginUpdateState): void;
	log(message: string): void;
}

export interface Market {
	/** 启动时要加载的插件，同名时只认一份，顺序见 `found`。 */
	plugins(): Promise<PluginDir[]>;
	/** 读目录和本机已有的，顺便对一遍账（自动更新开着就更新）。 */
	read(): Promise<MarketState>;
	install(id: string): Promise<MarketResult>;
	/** 从本机一个构建好的插件文件夹装进本地上传目录（插件市场的「从本地上传」）；同名的换成这一份，市场装的那份留着、不加载。 */
	installFolder(dir: string): Promise<MarketResult>;
	uninstall(id: string): Promise<MarketResult>;
	/** 更新这几个（缺省：全部落后的），不看自动更新开没开——这是人点的。 */
	update(ids?: string[]): Promise<PluginUpdateState>;
	setAutoUpdate(auto: boolean): Promise<PluginUpdateState>;
	/** 介绍：市场里那份的 README.md，没有就看本机那份。都没有是 null。 */
	readme(id: string): Promise<string | null>;
	/** README 引用的一张图（插件目录里的相对路径），data URL：先找市场里那份，再找本机那份；不在目录里、不是图、太大都是 null。 */
	readmeImage(id: string, path: string): Promise<string | null>;
	/** 本机那份的目录，打开文件夹用。 */
	dirOf(id: string): Promise<string | undefined>;
	/** 开始定时检查，并盯着安装目录和本机目录。 */
	start(): void;
	stop(): void;
}

export function createMarket(options: MarketOptions): Market {
	const { catalogUrl, builtinDir, installDir, uploadDir, settingsFile, pluginDirs, agent, announce, log } = options;
	let auto = true;
	let current: PluginUpdateState = { outdated: [], auto, updating: [], failed: [] };
	/** 装、卸、更新排成一队：同一个目录不会被两件事同时改。 */
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const run = queue.then(work, work);
		queue = run.catch(() => undefined);
		return run;
	};
	const timers: NodeJS.Timeout[] = [];
	const watchers: FSWatcher[] = [];
	/** agent 进程里现在加载着的插件：目录和当时的文件指纹。目录有变化时和它比。 */
	const loadedPlugins = new Map<string, { dir: string; hash: string }>();

	const loaded = readFile(settingsFile, "utf8").then(
		(raw) => {
			auto = (JSON.parse(raw) as { autoUpdate?: unknown }).autoUpdate !== false;
		},
		() => undefined,
	);

	const publish = (patch: Partial<PluginUpdateState>) => {
		current = { ...current, ...patch, auto };
		announce(current);
		return current;
	};

	/** 上次读到的市场目录，和这次读不到的原因。 */
	let catalog: RemoteEntry[] | null = null;
	let catalogError: string | undefined;
	/** 上次去读的时候：读不到也算，断网时不每装一个都等一遍超时。 */
	let attempted = 0;
	let reading: Promise<RemoteEntry[]> | null = null;
	/** 市场目录：fresh 时重读，否则 CATALOG_FRESH_MS 内用上次的。读不到时用上次读到的。 */
	const remote = (fresh: boolean): Promise<RemoteEntry[]> => {
		if (reading) return reading;
		if (!fresh && Date.now() - attempted < CATALOG_FRESH_MS) return Promise.resolve(catalog ?? []);
		attempted = Date.now();
		reading = fetchCatalog(catalogUrl)
			.then(
				(fetched) => {
					catalog = fetched;
					catalogError = undefined;
				},
				(error: unknown) => {
					catalogError = errorText(error);
					log(`读不到插件市场 ${catalogUrl}：${catalogError}`);
				},
			)
			.then(() => catalog ?? [])
			.finally(() => {
				reading = null;
			});
		return reading;
	};
	const entries = async (): Promise<MarketEntry[]> => (await remote(false)).map((entry) => entry.info);

	const installed = async (): Promise<InstalledPlugin[]> => {
		const { builtin, upload, market } = await found();
		// 指纹要把发给插件的文件全读一遍（几十兆）：加载着的那份已经算过、盯着目录的 rescan 会跟着更新，直接用；没加载的才现算。
		const info = async (key: string, dir: string) => {
			const loaded = loadedPlugins.get(key);
			return { ...(await readInfo(key, dir)), hash: loaded && loaded.dir === resolve(dir) ? loaded.hash : await hashOf(dir) };
		};
		return Promise.all([
			...builtin.map(async ({ key, dir }) => ({ ...(await info(key, dir)), dir, source: "builtin" as const })),
			...upload.map(async ({ key, dir }) => ({ ...(await info(key, dir)), dir, source: "upload" as const })),
			...market.map(async ({ key, dir }) => ({ ...(await info(key, dir)), dir, source: "market" as const })),
		]);
	};

	/**
	 * 本机有的插件，同名目录只认先找到的：先内置的（不能被换掉），再本地上传的（插件作者正在改的那份），
	 * 最后市场装的。市场装的被压住时原样留着，前面的没了它就接着生效。
	 */
	const found = async () => {
		const builtin = (await discoverPlugins([builtinDir], log)).map((plugin) => ({ ...plugin, builtin: true }));
		const taken = (key: string, ...lists: PluginDir[][]) => lists.some((list) => list.some((other) => other.key === key));
		const upload = (await discoverPlugins([uploadDir], log)).filter((plugin) => !taken(plugin.key, builtin));
		const market = (await discoverPlugins([installDir], log)).filter((plugin) => !taken(plugin.key, builtin, upload));
		return { builtin, upload, market };
	};

	/** 市场装的、目录里有更新版本的那些。装下的没写版本号的，有版本就算新。 */
	const behind = (offered: RemoteEntry[], have: InstalledPlugin[]) =>
		have.flatMap((plugin) => {
			const entry = offered.find((candidate) => candidate.info.id === plugin.id);
			const version = entry?.info.version;
			return plugin.source === "market" && entry && version && isNewer(version, plugin.version ?? "0.0.0") ? [entry] : [];
		});

	/** 换下来的旧目录先挪到这里再删（见 plugin-swap.ts）：和暂存目录一样在安装目录旁边，同一个文件系统，又不会被当成插件。 */
	const retiredDir = join(installDir, "..", ".plugins-retired");

	/** 换不成时旧目录已经原样回到原处，把先前卸下的它重新装上。 */
	const restore = async (key: string, dir: string) => {
		pluginDirs.set(key, resolve(dir));
		await agent.addPlugin({ key, dir: resolve(dir) }).catch((error: unknown) => log(`${key} 重新加载失败：${errorText(error)}`));
	};

	/**
	 * 把一个插件换进 root（安装目录或本地上传目录）：fill 先把文件放进暂存目录（下载市场的包，或复制人选的本机文件夹），
	 * 放好了才动装着的那份。replaced 是现在生效的同名那份的目录：先让 agent 进程卸下它，换好再加载新的；换不成就把它装回去。
	 */
	const put = async (root: string, id: string, fill: (staging: string) => Promise<void>, replaced: string | undefined): Promise<void> => {
		const target = join(root, id);
		const staging = join(root, "..", ".plugins-staging", id);
		await rm(staging, { recursive: true, force: true });
		try {
			await fill(staging);
		} catch (error) {
			await rm(staging, { recursive: true, force: true }).catch(() => {});
			throw packageError(error);
		}
		if (replaced) {
			await agent.removePlugin(id);
			pluginDirs.delete(id);
		}
		await mkdir(root, { recursive: true });
		try {
			await discard(await swapIn([{ from: staging, to: target }], retiredDir), retiredDir);
		} catch (error) {
			// 旧的那份原样回到了原处，把卸下的它装回去；暂存的新版本扔掉。
			await rm(staging, { recursive: true, force: true }).catch(() => {});
			if (replaced) await restore(id, replaced);
			throw swapError(error);
		}
		pluginDirs.set(id, resolve(target));
		// 记下指纹：盯着安装目录的那边看到是这次换的，不再重新加载一遍。
		loadedPlugins.set(id, { dir: resolve(target), hash: await hashOf(target) });
		await agent.addPlugin({ key: id, dir: resolve(target) });
	};

	/** 下载市场里这台机器的那份包。 */
	const download = (entry: RemoteEntry) => (staging: string) => downloadPackage(entry, staging);

	/** 复制本机一个构建好的插件文件夹里发给插件的那些文件。 */
	const copyFolder = (source: string) => async (staging: string) => {
		await mkdir(staging, { recursive: true });
		for (const name of SHIPPED) {
			if (existsSync(join(source, name))) await cp(join(source, name), join(staging, name), { recursive: true });
		}
	};

	/** 有哪些插件以磁盘为准，和加载着的对一遍：新来的加载，文件变了的重新加载，没了的卸下。 */
	const rescan = () =>
		serial(async () => {
			const found = await discoverAll();
			for (const [key, { dir }] of loadedPlugins) {
				if (found.some((plugin) => plugin.key === key && plugin.dir === dir)) continue;
				loadedPlugins.delete(key);
				pluginDirs.delete(key);
				await agent.removePlugin(key);
			}
			for (const plugin of found) {
				const { key, dir } = plugin;
				const hash = await hashOf(dir);
				const before = loadedPlugins.get(key);
				if (before?.hash === hash) continue;
				// 加载失败的插件在 agent 进程里记成失败状态，不抛错；记下指纹，文件不再变就不反复加载。
				loadedPlugins.set(key, { dir, hash });
				if (before) await agent.removePlugin(key);
				pluginDirs.set(key, dir);
				await agent.addPlugin(plugin);
			}
			await tally();
		});

	let settle: NodeJS.Timeout | undefined;
	const scheduleRescan = () => {
		clearTimeout(settle);
		settle = setTimeout(() => void rescan().catch((error: unknown) => log(errorText(error))), SETTLE_MS);
	};

	/** 要加载的插件，顺序见 `found`。 */
	const discoverAll = async (): Promise<PluginDir[]> => {
		const { builtin, upload, market } = await found();
		return [...builtin, ...upload, ...market];
	};

	/** 逐个换上落后的；ids 为空表示全部。 */
	const apply = async (ids: string[] | undefined): Promise<PluginUpdateState> => {
		const lagging = behind(await remote(false), await installed()).filter((entry) => !ids || ids.includes(entry.info.id));
		const failed = current.failed.filter((failure) => !lagging.some((entry) => entry.info.id === failure.id));
		for (const entry of lagging) {
			const { id, name } = entry.info;
			publish({ updating: [...current.updating, id] });
			try {
				// 落后的只算生效着的市场那份，换下的就是它。
				await put(installDir, id, download(entry), join(installDir, id));
			} catch (error) {
				log(`更新 ${id} 失败：${errorText(error)}`);
				failed.push({ id, name, message: errorText(error) });
			}
			publish({ updating: current.updating.filter((other) => other !== id) });
		}
		return tally({ failed });
	};

	const tally = async (patch: Partial<PluginUpdateState> = {}): Promise<PluginUpdateState> => {
		const lagging = behind(await remote(false), await installed());
		return publish({
			...patch,
			outdated: lagging.map(({ info }) => ({ id: info.id, name: info.name, ...(info.version ? { version: info.version } : {}) })),
		});
	};

	/** 重读市场目录，对一遍账；自动更新开着就顺手更新。 */
	const check = () =>
		serial(async () => {
			await loaded;
			await remote(true);
			return auto ? apply(undefined) : tally();
		});

	const result = async (work: () => Promise<void>): Promise<MarketResult> => {
		try {
			await work();
			return { ok: true };
		} catch (error) {
			log(errorText(error));
			return { ok: false, error: "failed", message: errorText(error) };
		} finally {
			await tally();
		}
	};

	return {
		async plugins() {
			const found = await discoverAll();
			for (const { key, dir } of found) loadedPlugins.set(key, { dir, hash: await hashOf(dir) });
			return found;
		},
		async read() {
			await check();
			return { entries: await entries(), installed: await installed(), updates: current, ...(catalogError ? { catalogError } : {}) };
		},
		install: (id) =>
			serial(async () => {
				const entry = (await remote(false)).find((candidate) => candidate.info.id === id);
				if (!entry) return { ok: false, error: "not-found" };
				const have = (await installed()).find((plugin) => plugin.id === id);
				if (have?.source === "upload") return { ok: false, error: "local" };
				return result(() => put(installDir, id, download(entry), have?.dir));
			}),
		installFolder: (dir) =>
			serial(async () => {
				const id = basename(dir);
				if (!isAbsolute(dir) || !DIR_NAME.test(id) || !existsSync(join(dir, PLUGIN_ENTRY))) return { ok: false, error: "invalid" };
				const have = (await installed()).find((plugin) => plugin.id === id);
				if (have?.source === "builtin") return { ok: false, error: "builtin" };
				return result(() => put(uploadDir, id, copyFolder(dir), have?.dir));
			}),
		uninstall: (id) =>
			serial(async () => {
				const have = (await installed()).find((plugin) => plugin.id === id);
				if (!have) return { ok: false, error: "not-found" };
				if (have.source === "builtin") return { ok: false, error: "builtin" };
				return result(async () => {
					await agent.removePlugin(id);
					pluginDirs.delete(id);
					try {
						await discard(await swapIn([{ from: null, to: have.dir }], retiredDir), retiredDir);
					} catch (error) {
						await restore(id, have.dir);
						throw swapError(error);
					}
					loadedPlugins.delete(id);
					// 本地上传的压着一份市场装的：卸掉前者，后者接着生效。
					const next = (await discoverAll()).find((plugin) => plugin.key === id);
					if (next) {
						pluginDirs.set(id, next.dir);
						loadedPlugins.set(id, { dir: next.dir, hash: await hashOf(next.dir) });
						await agent.addPlugin(next);
					}
				});
			}),
		update: (ids) => serial(() => apply(ids)),
		async setAutoUpdate(next) {
			await loaded;
			auto = next;
			await writeFile(settingsFile, JSON.stringify({ autoUpdate: next }, null, "\t"));
			return next ? check() : serial(() => tally());
		},
		async readme(id) {
			const offered = (await remote(false)).find((entry) => entry.info.id === id)?.readme;
			const fromMarket = offered ? await fetchReadme(offered) : null;
			if (fromMarket) return fromMarket;
			const dir = (await installed()).find((plugin) => plugin.id === id)?.dir;
			const text = dir ? await readFile(join(dir, "README.md"), "utf8").catch(() => null) : null;
			return text?.trim() ? text : null;
		},
		async readmeImage(id, path) {
			const type = imageType(path);
			if (!DIR_NAME.test(id) || !type) return null;
			const assets = (await remote(false)).find((entry) => entry.info.id === id)?.assets;
			// URL 把 %2e%2e 也当成上一级：解析出来的地址还得在这个插件的 assets 下。
			const url = assets ? new URL(path, assets) : undefined;
			const inside = assets !== undefined && url !== undefined && url.href.startsWith(assets.href);
			const bytes = inside ? await fetchBytes(url, MAX_README_IMAGE_BYTES, 15_000).catch(() => null) : null;
			if (bytes?.length) return `data:${type};base64,${bytes.toString("base64")}`;
			const dir = (await installed()).find((plugin) => plugin.id === id)?.dir;
			return dir ? readReadmeImage(dir, path, type) : null;
		},
		async dirOf(id) {
			return (await installed()).find((plugin) => plugin.id === id)?.dir;
		},
		start() {
			timers.push(setTimeout(() => void check().catch((error: unknown) => log(errorText(error))), FIRST_CHECK_MS));
			timers.push(setInterval(() => void check().catch((error: unknown) => log(errorText(error))), CHECK_EVERY_MS));
			mkdirSync(installDir, { recursive: true });
			mkdirSync(uploadDir, { recursive: true });
			for (const root of [installDir, uploadDir]) {
				try {
					watchers.push(watch(root, { recursive: true }, scheduleRescan));
				} catch (error) {
					// 本机目录不存在就不盯；安装目录和本地上传目录上面建好了。
					log(`盯不了插件目录 ${root}：${errorText(error)}`);
				}
			}
		},
		stop() {
			for (const timer of timers) clearTimeout(timer);
			clearTimeout(settle);
			for (const watcher of watchers) watcher.close();
		},
	};
}

/** 读插件目录的 package.json 和图标。字段类型不对的当没写，一个坏字段不拖垮整页。 */
async function readInfo(id: string, dir: string): Promise<MarketInfo> {
	const manifest = await readFile(join(dir, "package.json"), "utf8").then(
		(raw) => readManifest(JSON.parse(raw)),
		() => readManifest(null),
	);
	const icon = await readIcon(dir);
	return { ...marketInfo(id, manifest), ...(icon ? { logo: `data:image/png;base64,${icon.toString("base64")}` } : {}) };
}

/** README 里一张图的相对路径能不能取、是什么类型：只能往下走，只认常见的图片扩展名。 */
function imageType(path: string): string | null {
	const segments = path.split("/");
	if (!path || path.includes("\\") || path.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
	return README_IMAGE_TYPES[extname(path).toLowerCase()] ?? null;
}

/** 插件目录里的一张图（路径已经过 imageType）：解开符号链接后仍在目录里。 */
async function readReadmeImage(dir: string, path: string, type: string): Promise<string | null> {
	const segments = path.split("/");
	try {
		const root = await realpath(dir);
		const file = await realpath(join(dir, ...segments));
		if (relative(root, file).startsWith("..") || isAbsolute(relative(root, file))) return null;
		const info = await statOf(file);
		if (!info.isFile() || info.size === 0 || info.size > MAX_README_IMAGE_BYTES) return null;
		return `data:${type};base64,${(await readFile(file)).toString("base64")}`;
	} catch {
		return null;
	}
}

/** 只读固定文件，不跟符号链接，也不让管道或读取期间变大的文件绕过大小限制。 */
async function readIcon(dir: string): Promise<Buffer | undefined> {
	const file = await open(join(dir, "icon.png"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
	if (!file) return undefined;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size <= PNG_SIGNATURE.length || stat.size > MAX_ICON_BYTES) return undefined;
		const buffer = Buffer.alloc(stat.size + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== stat.size || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined;
		return buffer.subarray(0, bytesRead);
	} catch {
		return undefined;
	} finally {
		await file.close().catch(() => undefined);
	}
}

async function hashOf(dir: string): Promise<string> {
	const hash = createHash("sha256");
	const files: string[] = [];
	for (const name of SHIPPED) {
		if (name === "icon.png") {
			const icon = await readIcon(dir);
			if (icon) hash.update(name).update(icon);
			continue;
		}
		const path = join(dir, name);
		if (!existsSync(path)) continue;
		const listed = await readdir(path, { recursive: true, withFileTypes: true }).catch(() => null);
		if (listed === null) files.push(path);
		else for (const entry of listed) if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
	}
	for (const file of files.sort()) {
		hash.update(relative(dir, file));
		hash.update(await readFile(file));
	}
	return hash.digest("hex").slice(0, 16);
}

/** 下载的包对不上、解不开时换成一句人看得懂的话。 */
function packageError(error: unknown): unknown {
	if (!(error instanceof PackageError)) return error;
	return new Error(
		error.kind === "mismatch"
			? nativeText(resolvedLocale(), "market.badDownload")
			: nativeText(resolvedLocale(), "market.badPackage", { reason: error.message }),
		{ cause: error },
	);
}

/** 有文件正被占用时换成一句人看得懂的话：错误码只说 EPERM，人要知道的是什么都没动、关掉占用它的程序再试。 */
function swapError(error: unknown): unknown {
	return heldOpen(error) ? new Error(nativeText(resolvedLocale(), "market.filesInUse"), { cause: error }) : error;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 渲染进程经预加载脚本调的那几件事。参数都当不可信的看：id 必须是条目或已装插件的目录名。 */
export function registerMarketIpc(market: Market): void {
	const id = (value: unknown) => (typeof value === "string" ? value : "");
	ipcMain.handle("plume:market:read", () => market.read());
	ipcMain.handle("plume:market:install", (_event, value: unknown) => market.install(id(value)));
	ipcMain.handle("plume:market:install-folder", (_event, dir: unknown) => market.installFolder(typeof dir === "string" ? dir : ""));
	ipcMain.handle("plume:market:uninstall", (_event, value: unknown) => market.uninstall(id(value)));
	ipcMain.handle("plume:market:update", (_event, ids: unknown) =>
		market.update(Array.isArray(ids) ? ids.filter((item): item is string => typeof item === "string") : undefined),
	);
	ipcMain.handle("plume:market:auto-update", (_event, auto: unknown) => market.setAutoUpdate(auto !== false));
	ipcMain.handle("plume:market:readme", (_event, value: unknown) => market.readme(id(value)));
	ipcMain.handle("plume:market:readme-image", (_event, value: unknown, path: unknown) => market.readmeImage(id(value), typeof path === "string" ? path : ""));
	ipcMain.handle("plume:market:open-folder", async (_event, value: unknown) => {
		const dir = await market.dirOf(id(value));
		if (dir) await shell.openPath(dir);
	});
	// README 里的链接和插件主页在默认浏览器里打开；只认 http(s)，别的协议（file:、自定义协议）一律不开。
	ipcMain.handle("plume:open-external", async (_event, url: unknown) => {
		if (typeof url === "string" && /^https?:\/\//i.test(url)) await shell.openExternal(url);
	});
	// 上面那个交给的是哪个浏览器：网址右键菜单写「在 Google Chrome 中打开」，人知道要弹出哪个窗口。查不到是空串。
	ipcMain.handle("plume:default-browser", () => app.getApplicationNameForProtocol("https://"));
}

/** 更新状态推给所有窗口。 */
export function announceToWindows(state: PluginUpdateState): void {
	for (const window of BrowserWindow.getAllWindows()) window.webContents.send("plume:market:changed", state);
}
