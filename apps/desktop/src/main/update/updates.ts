/**
 * 查有没有新版本、下载、交给安装那一步。没有 Linux 的安装方式（Plume 不发 Linux 包）。
 *
 * 在应用里下，不打开浏览器：发布页分不清这台是 Apple 芯片还是 Intel，这里分得清。装上前，字节必须和 release 自己的
 * `SHA256SUMS` 对上（update-checksum.ts），没发校验文件的 release 拒绝安装。
 *
 * 收尾在人按「立即重启」时做：macOS 换掉应用包（install-update.ts），Windows 运行 NSIS 安装程序并退出，免得被它杀掉
 * （update-finish.ts）。
 */

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { UpdateInfo, UpdatePhase } from "../../shared/update.ts";
import { resolvedLocale } from "../locale.ts";
import { installedAppBundle, scheduleSwap } from "./install-update.ts";
import { say, setUpdateLocale } from "./say.ts";
import { pickAsset, pickChecksums, type ReleaseAsset } from "./update-asset.ts";
import { downloadDir, sweepDownloads, UpdateDownload } from "./update-download.ts";
import { finishUpdate, type PendingUpdate } from "./update-finish.ts";
import { isNewer } from "./version.ts";

const execFileAsync = promisify(execFile);

/** 用 `ditto` 解包：`.app` 是一目录的软链、签名和扩展属性，多数 zip 实现会悄悄丢掉一些，解出来不报错却起不来。 */
const unzip = (archive: string, into: string) => execFileAsync("ditto", ["-x", "-k", archive, into]);

/** 发布安装包的 GitHub 仓库，`owner/name`。`.github/workflows/package.yml` 发布时也发到这里（安装包和 SHA256SUMS 一起传）。 */
const RELEASE_REPO = "wJiaaa/plume";
/** GitHub 一秒左右就答，再长就是不会答了。 */
const TIMEOUT_MS = 8000;
/** 不管窗口问多少次，最多这么久查一次。 */
const CACHE_MS = 30 * 60 * 1000;

let cached: { at: number; info: UpdateInfo } | null = null;

/** 准备好、等人说什么时候换上的更新；用过就清掉。 */
let pending: PendingUpdate | null = null;

/** 交给系统打开过的安装程序（.msi），「重新打开安装包」用：那个窗口不归这里管，容易被误关。 */
let opened: string | null = null;

const releasesPage = (repo: string) => `https://github.com/${repo}/releases`;

async function fetchLatest(repo: string, current: string): Promise<UpdateInfo> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": `Plume/${current}` },
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`GitHub said ${response.status}`);
		const release = (await response.json()) as {
			tag_name?: string;
			name?: string;
			body?: string;
			html_url?: string;
			published_at?: string;
			draft?: boolean;
			prerelease?: boolean;
			assets?: ReleaseAsset[];
		};

		const latest = (release.tag_name ?? release.name ?? "").replace(/^v/i, "");
		// 草稿没发布，预发布版不给没要的人。
		const offerable = Boolean(latest) && !release.draft && !release.prerelease;
		return {
			current,
			latest: latest || current,
			available: offerable && isNewer(latest, current),
			checked: true,
			notes: (release.body ?? "").trim(),
			url: release.html_url ?? `${releasesPage(repo)}/latest`,
			publishedAt: release.published_at ? Date.parse(release.published_at) : null,
			asset: pickAsset(release.assets ?? []),
			checksums: pickChecksums(release.assets ?? [])?.url ?? null,
		};
	} finally {
		clearTimeout(timer);
	}
}

const nothing = (current: string): UpdateInfo => ({
	current,
	latest: current,
	available: false,
	// 唯一说明「这不是回答」的字段，见 `UpdateInfo.checked`。
	checked: false,
	notes: "",
	url: releasesPage(RELEASE_REPO),
	publishedAt: null,
	asset: null,
	checksums: null,
});

/** `offline`：冒烟测试不访问外网，检查一律答「查不了」。 */
export function registerUpdateIpc(options: { offline?: boolean } = {}): void {
	setUpdateLocale(resolvedLocale);
	// 会被运行的代码不放在系统共享临时目录里一个猜得到的名字下。
	const updateRoot = join(app.getPath("userData"), "updates");

	/**
	 * 正在进行的下载，活得比看着它的任何窗口长。一次一个，按版本认；换了版本就换掉它（见 `downloadFor`）。
	 * 留着 `unwatch`：旧下载的 `cancel()` 最后会广播 idle，要是新下载已经开始，这句会盖掉新下载的第一个 downloading，
	 * 先退订让它的遗言哪也不去。
	 */
	let active: { version: string; download: UpdateDownload; unwatch: () => void } | null = null;

	/** 整个应用眼里下载走到哪了。不是每个阶段都属于某个下载（「没有这台机器的安装包」也是失败），所以单独记着。 */
	let phase: UpdatePhase = { at: "idle" };

	/** 每个打开的窗口都听到每次变化：下载是应用的事，不是某个窗口的。 */
	const broadcast = (next: UpdatePhase) => {
		phase = next;
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) window.webContents.send("plume:updates:progress", next);
		}
	};

	ipcMain.handle("plume:updates:check", async (_event, force?: boolean): Promise<UpdateInfo> => {
		const current = app.getVersion();
		if (options.offline) return nothing(current);

		if (!force && cached && Date.now() - cached.at < CACHE_MS && cached.info.current === current) return cached.info;
		try {
			const info = await fetchLatest(RELEASE_REPO, current);
			cached = { at: Date.now(), info };
			// 知道哪个是最新的了，清掉旧版本留下的下载（安装包和解开的副本各一百多兆）。正在下的那个版本也留着。
			void sweepDownloads(updateRoot, active ? [info.latest, active.version] : info.latest);
			return info;
		} catch {
			// 没网、被限流、仓库还没有 release：对窗口都是「没什么可给的」。检查是应用自己做的，失败是应用的事，不打扰人。
			return nothing(current);
		}
	});

	/** 这个版本的下载，同一版本复用正在进行的那个。 */
	const downloadFor = (version: string): UpdateDownload | { error: string } => {
		const info = cached?.info;
		const asset = info?.asset;
		if (!info || !asset || info.latest !== version) return { error: say("update.noAsset") };

		if (active?.version === version) return active.download;

		// 换了版本：停掉旧的、删掉它的半截文件。先退订，见 `active`。
		active?.unwatch();
		void active?.download.cancel();

		const download = new UpdateDownload({
			url: asset.url,
			file: join(downloadDir(updateRoot, version), asset.name),
			size: asset.size,
			agent: `Plume/${info.current}`,
			checksums: info.checksums,
		});
		const unwatch = download.watch(broadcast);
		active = { version, download, unwatch };
		return download;
	};

	/**
	 * 把下好的文件准备到能换上：macOS 解开应用包，Windows 的安装程序排给「立即重启」，别的（.msi）交给系统打开。
	 * 和取字节分开：两者失败的原因不相干，只有一个值得续。下载报 preparing 后就做，等人按「立即重启」时能出错的越少越好。
	 */
	const installDownloaded = async (version: string, file: string): Promise<void> => {
		const download = active?.download;
		try {
			if (process.platform === "darwin" && file.endsWith(".zip")) {
				// 开发时不换：那里的应用包是 node_modules 里 Electron 自带的，换掉它就换掉了 `pnpm dev` 用的运行时。
				if (!app.isPackaged) return download?.fail(say("update.devMode"));

				const target = installedAppBundle(app.getPath("exe"));
				if (!target) return download?.fail(say("update.notInApplications"));

				const staged = join(downloadDir(updateRoot, version), "unpacked");
				await rm(staged, { recursive: true, force: true });
				await mkdir(staged, { recursive: true });
				await unzip(file, staged);
				const bundle = join(staged, `${app.getName()}.app`);
				if (!(await stat(bundle).catch(() => null))?.isDirectory()) return download?.fail(say("update.noAppInPackage"));

				pending = { kind: "bundle", staged: bundle, target };
				return download?.finish(true);
			}

			// Windows：安装程序在人按「立即重启」时才跑，不在字节下完的那一刻。它会杀掉跑着的 Plume，不能在谁的一轮中途发生。
			if (process.platform === "win32" && file.toLowerCase().endsWith(".exe")) {
				pending = { kind: "installer", file };
				return download?.finish(true);
			}

			// 其余交给系统：.msi。
			const failure = await shell.openPath(file);
			if (failure) return download?.fail(say("update.cannotOpenInstaller", { reason: failure }));
			opened = file;
			download?.finish(false);
		} catch (error) {
			download?.fail(error instanceof Error ? error.message : say("update.installFailedPlain"));
		}
	};

	/** 现在走到哪了，给刚打开或刚回来的窗口。 */
	ipcMain.handle("plume:updates:state", (): UpdatePhase => phase);

	/**
	 * 开始，或从暂停处继续。结果和别的变化一样经 `plume:updates:progress` 到，只有一条「走到哪了」的路。
	 * 找不到安装包也广播出去：点按钮的那边不等这个返回值，只告诉调用方的失败等于按钮没反应。
	 */
	ipcMain.handle("plume:updates:download", async (_event, version: string): Promise<UpdatePhase> => {
		const found = downloadFor(version);
		if ("error" in found) {
			broadcast({ at: "failed", error: found.error, received: 0, total: 0 });
			return phase;
		}

		const reached = await found.start();
		if (reached.at === "preparing") {
			const asset = cached?.info.asset;
			if (asset) await installDownloaded(version, join(downloadDir(updateRoot, version), asset.name));
		}
		return phase;
	});

	ipcMain.handle("plume:updates:pause", async (): Promise<UpdatePhase> => {
		await active?.download.pause();
		return phase;
	});

	ipcMain.handle("plume:updates:cancel", async (): Promise<UpdatePhase> => {
		// 没有下载可取消时阶段可能是一次失败（没有安装包），「取消」也要清掉它，不然角标一直挂着红点。
		if (active) await active.download.cancel();
		else broadcast({ at: "idle" });
		return phase;
	});

	/** 再打开一次交给系统的安装程序。 */
	ipcMain.handle("plume:updates:reopen", async (): Promise<boolean> => {
		if (!opened) return false;
		return (await shell.openPath(opened)) === "";
	});

	/** 换上更新并从新版本起来。和下载分开，让人决定什么时候：一轮中途重启会把对话一起带走。 */
	ipcMain.handle("plume:updates:relaunch", async (): Promise<boolean> => {
		const job = pending;
		if (!job) return false;
		pending = null;
		const result = await finishUpdate(job, {
			swapBundle: scheduleSwap,
			openInstaller: (file) => shell.openPath(file),
			// 经 before-quit 退出，会话和终端照常收尾。
			quit: () => app.quit(),
		});
		if (result.ok) {
			if (job.kind === "installer") opened = job.file;
			return true;
		}
		const message = say("update.installFailed", { reason: result.detail });
		if (active) active.download.fail(message);
		else broadcast({ at: "failed", error: message, received: 0, total: 0 });
		return false;
	});

	/** 没有这台机器的安装包时只剩发布页可给。只开 GitHub 的地址。 */
	ipcMain.handle("plume:updates:open", async (_event, url: unknown): Promise<boolean> => {
		if (typeof url !== "string" || !url.startsWith("https://github.com/")) return false;
		await shell.openExternal(url);
		return true;
	});
}
