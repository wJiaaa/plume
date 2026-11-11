/**
 * 应用更新：挑安装包、校验、下载（对着本机真的 HTTP 服务暂停、续传）、按「立即重启」收尾的先后、换应用包的脚本，
 * 以及界面在每个阶段显示什么。
 *
 * 下载用真的服务：要紧的都是和服务器的往来（206 还是被忽略成 200、到的字节是接着磁盘上的还是重复），桩说明不了。
 * 往 200 后面追加得到长度对、内容错的文件，所以这里比的是内容本身。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { translateIn } from "../../../packages/client/ui/src/i18n/translate.ts";
import type { UpdatePhase } from "../src/shared/update.ts";
import { installedAppBundle, swapScript } from "../src/main/update/install-update.ts";
import { pickAsset, pickChecksums } from "../src/main/update/update-asset.ts";
import { parseChecksums, verify } from "../src/main/update/update-checksum.ts";
import {
	describe,
	DownloadError,
	downloadDir,
	partialPath,
	resumePlan,
	staleDownloads,
	sweepDownloads,
	UpdateDownload,
} from "../src/main/update/update-download.ts";
import { finishUpdate, type FinishEffects } from "../src/main/update/update-finish.ts";
import { compareVersions, isNewer } from "../src/main/update/version.ts";
import { notesForLocale } from "../src/renderer/update/notes-locale.ts";
import { confirmLabel, controlsFor, failureDetail, fractionOf, labelFor, PHASES, shouldShow } from "../src/renderer/update/view.ts";

const temps: string[] = [];
after(async () => {
	for (const dir of temps) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-update-test-"));
	temps.push(dir);
	return dir;
}

// ── 版本 ──

test("版本按数字比，预发布版排在正式版前面", () => {
	assert.ok(isNewer("0.10.0", "0.9.9"));
	assert.ok(isNewer("v1.0.0", "1.0.0-beta.2"));
	assert.ok(!isNewer("1.0.0", "1.0.0"));
	assert.equal(compareVersions("1.2.3", "1.2.10"), -1);
});

// ── 挑安装包 ──

const asset = (name: string) => ({ name, browser_download_url: `https://example.com/${name}`, size: 1 });
const RELEASE = [
	asset("Plume-1.0.0-arm64.dmg"),
	asset("Plume-1.0.0-arm64.zip"),
	asset("Plume-1.0.0-x64.dmg"),
	asset("Plume-1.0.0-x64.zip"),
	asset("Plume-1.0.0-arm64.exe"),
	asset("Plume-1.0.0-x64.exe"),
	asset("SHA256SUMS"),
];

test("macOS 拿自己架构的 zip，不拿 dmg", () => {
	assert.equal(pickAsset(RELEASE, "darwin", "arm64")?.name, "Plume-1.0.0-arm64.zip");
	assert.equal(pickAsset(RELEASE, "darwin", "x64")?.name, "Plume-1.0.0-x64.zip");
});

test("Windows 按架构挑，字母序排在前面的 arm64 不会落到 Intel 机器上；名字不带架构的当通用", () => {
	assert.equal(pickAsset(RELEASE, "win32", "x64")?.name, "Plume-1.0.0-x64.exe");
	assert.equal(pickAsset(RELEASE, "win32", "arm64")?.name, "Plume-1.0.0-arm64.exe");
	assert.equal(pickAsset([asset("Plume Setup 1.0.0.exe")], "win32", "x64")?.name, "Plume Setup 1.0.0.exe");
	// 只有别的架构的：宁可什么都不给，界面改给发布页。
	assert.equal(pickAsset([asset("Plume-1.0.0-arm64.exe")], "win32", "x64"), null);
	assert.equal(pickAsset(RELEASE, "linux", "x64"), null);
});

test("校验文件按确切的名字认", () => {
	assert.equal(pickChecksums(RELEASE)?.url, "https://example.com/SHA256SUMS");
	assert.equal(pickChecksums([asset("SHA256SUMS.txt")]), null);
});

// ── 校验 ──

test("sha256sum 的两种写法都认，认不出的行跳过；三种不对分开说", () => {
	const digest = "a".repeat(64);
	const digests = parseChecksums(`${digest}  Plume-1.0.0-x64.exe\n${"b".repeat(64)} *Plume-1.0.0-x64.zip\n# 注释\n`);
	assert.equal(digests.get("Plume-1.0.0-x64.exe"), digest);
	assert.equal(digests.get("Plume-1.0.0-x64.zip"), "b".repeat(64));
	assert.equal(digests.size, 2);
	assert.deepEqual(verify(digests, "Plume-1.0.0-x64.exe", digest.toUpperCase()), { ok: true });
	assert.equal((verify(new Map(), "x", digest) as { reason: string }).reason, "no-checksums");
	assert.equal((verify(digests, "other.exe", digest) as { reason: string }).reason, "not-listed");
	assert.equal((verify(digests, "Plume-1.0.0-x64.exe", "c".repeat(64)) as { reason: string }).reason, "mismatch");
});

// ── 下载 ──

test("续传的判断：206 接着写，200 从头写，416 和别的状态是错", () => {
	assert.deepEqual(resumePlan(0, 206), { append: false, from: 0 });
	assert.deepEqual(resumePlan(100, 206), { append: true, from: 100 });
	assert.deepEqual(resumePlan(100, 200), { append: false, from: 0 });
	assert.ok("error" in resumePlan(100, 416));
	assert.ok("error" in resumePlan(100, 500));
});

test("失败说成能照着做的话：断了的连接说已下的留着", () => {
	assert.match(describe(new Error("terminated"), 10), /留着/);
	assert.match(describe(new Error("fetch failed"), 0), /网络/);
	assert.equal(describe(new DownloadError("下载不完整"), 10), "下载不完整");
	assert.match(describe(new Error("EPERM: operation not permitted, open 'C:\\x\\download.part'"), 0), /写入/);
});

test("清旧下载留着最新的和正在下的那个", async () => {
	assert.deepEqual(staleDownloads(["plume-update-1.0.0", "plume-update-1.1.0", "plume-update-1.2.0", "other"], ["1.2.0", "1.1.0"]), ["plume-update-1.0.0"]);
	const root = await temp();
	await mkdir(downloadDir(root, "1.0.0"));
	await mkdir(downloadDir(root, "1.1.0"));
	await sweepDownloads(root, "1.1.0");
	assert.deepEqual(await readdir(root), ["plume-update-1.1.0"]);
});

const BODY = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 251));
const NAME = "Plume-1.0.0-arm64.zip";

/** 发 `BODY` 的服务。`hold` 一点点地发，暂停才有正在进行的下载可停；`ranges: false` 是不理 Range 的服务器。 */
async function serve(options: { ranges?: boolean; hold?: boolean; sums?: string } = {}) {
	const requests: (string | undefined)[] = [];
	const sockets = new Set<Socket>();
	const server: Server = createServer((request, response) => {
		if (request.url === "/SHA256SUMS") {
			response.end(options.sums ?? `${createHash("sha256").update(BODY).digest("hex")}  ${NAME}\n`);
			return;
		}
		const range = request.headers.range;
		requests.push(range);
		const from = options.ranges !== false && range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
		const slice = BODY.subarray(from);
		if (from > 0) response.writeHead(206, { "content-length": String(slice.length) });
		else response.writeHead(200, { "content-length": String(slice.length) });
		if (!options.hold) {
			response.end(slice);
			return;
		}
		let sent = 0;
		const tick = setInterval(() => {
			if (sent >= slice.length) {
				clearInterval(tick);
				response.end();
				return;
			}
			response.write(slice.subarray(sent, sent + 20_000));
			sent += 20_000;
		}, 25);
		response.on("close", () => clearInterval(tick));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/${NAME}`,
		sums: `http://127.0.0.1:${port}/SHA256SUMS`,
		requests,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function downloader(harness: { url: string; sums: string }, checksums: string | null = harness.sums) {
	const file = join(downloadDir(await temp(), "1.0.0"), NAME);
	const download = new UpdateDownload({ url: harness.url, file, size: BODY.length, agent: "Plume/test", checksums });
	const phases: UpdatePhase[] = [];
	download.watch((phase) => phases.push(phase));
	return { file, download, phases };
}

test("下完、核对过才放到最终路径，阶段停在 preparing 等安装", async () => {
	const harness = await serve();
	try {
		const { file, download } = await downloader(harness);
		const reached = await download.start();
		assert.equal(reached.at, "preparing");
		assert.deepEqual(await readFile(file), BODY);
		assert.equal(await stat(partialPath(file)).catch(() => null), null);
	} finally {
		await harness.close();
	}
});

test("暂停留着半截文件，继续用 Range 接着下，拼出来的字节和原文件一样", async () => {
	const harness = await serve({ hold: true });
	try {
		const { file, download, phases } = await downloader(harness);
		void download.start();
		while (!phases.some((phase) => phase.at === "downloading" && phase.received > 0)) await new Promise((resolve) => setTimeout(resolve, 10));
		await download.pause();
		assert.equal(download.state.at, "paused");
		const kept = (await stat(partialPath(file))).size;
		assert.ok(kept > 0 && kept < BODY.length);

		const reached = await download.start();
		assert.equal(reached.at, "preparing");
		assert.equal(harness.requests.at(-1), `bytes=${kept}-`);
		assert.deepEqual(await readFile(file), BODY);
	} finally {
		await harness.close();
	}
});

test("服务器不理 Range 时从头写，不把整份文件拼在半截后面", async () => {
	const harness = await serve({ ranges: false });
	try {
		const { file, download } = await downloader(harness);
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(partialPath(file), BODY.subarray(0, 50_000));
		assert.equal((await download.start()).at, "preparing");
		assert.deepEqual(await readFile(file), BODY);
	} finally {
		await harness.close();
	}
});

test("校验和对不上：失败、删掉下的文件，最终路径上什么都没有", async () => {
	const harness = await serve({ sums: `${"0".repeat(64)}  ${NAME}\n` });
	try {
		const { file, download } = await downloader(harness);
		const reached = await download.start();
		assert.equal(reached.at, "failed");
		assert.match((reached as { error: string }).error, /校验和/);
		assert.equal(await stat(file).catch(() => null), null);
		assert.equal(await stat(partialPath(file)).catch(() => null), null);
	} finally {
		await harness.close();
	}
});

test("release 没发校验文件：下完也不装", async () => {
	const harness = await serve();
	try {
		const { file, download } = await downloader(harness, null);
		assert.equal((await download.start()).at, "failed");
		assert.equal(await stat(file).catch(() => null), null);
	} finally {
		await harness.close();
	}
});

test("取消停下并删掉半截文件，回到 idle", async () => {
	const harness = await serve({ hold: true });
	try {
		const { file, download, phases } = await downloader(harness);
		void download.start();
		while (!phases.some((phase) => phase.at === "downloading" && phase.received > 0)) await new Promise((resolve) => setTimeout(resolve, 10));
		await download.cancel();
		assert.equal(download.state.at, "idle");
		assert.equal(await stat(partialPath(file)).catch(() => null), null);
	} finally {
		await harness.close();
	}
});

test("同时来的几次安装只做一次，做完了再来的照常再做", async () => {
	const download = new UpdateDownload({ url: "http://127.0.0.1/unused", file: "/unused", size: 0, agent: "Plume/test", checksums: null });
	let runs = 0;
	let release = () => {};
	const job = () => {
		runs += 1;
		return new Promise<void>((resolve) => {
			release = resolve;
		});
	};
	const first = download.install(job);
	const second = download.install(job);
	assert.equal(runs, 1);
	release();
	await Promise.all([first, second]);

	const third = download.install(job);
	assert.equal(runs, 2);
	release();
	await third;
});

// ── 收尾 ──

function effects(overrides: Partial<FinishEffects> = {}) {
	const calls: string[] = [];
	const base: FinishEffects = {
		swapBundle: async (job) => void calls.push(`swap ${job.target}`),
		openInstaller: async (file) => (calls.push(`open ${file}`), ""),
		quit: () => void calls.push("quit"),
	};
	return { calls, effects: { ...base, ...overrides } };
}

test("macOS 先安排好替换再退出；安排失败就留在旧版本上", async () => {
	const ok = effects();
	assert.deepEqual(await finishUpdate({ kind: "bundle", staged: "/u/Plume.app", target: "/Applications/Plume.app" }, ok.effects), { ok: true });
	assert.deepEqual(ok.calls, ["swap /Applications/Plume.app", "quit"]);

	const failed = effects({
		swapBundle: async () => {
			throw new Error("ENOSPC");
		},
	});
	assert.deepEqual(await finishUpdate({ kind: "bundle", staged: "/u/Plume.app", target: "/Applications/Plume.app" }, failed.effects), {
		ok: false,
		detail: "ENOSPC",
	});
	assert.ok(!failed.calls.includes("quit"));
});

test("Windows 确认安装程序起来了才退出，免得被它杀掉、跳过 before-quit", async () => {
	const ok = effects();
	assert.deepEqual(await finishUpdate({ kind: "installer", file: "C:\\u\\Plume.exe" }, ok.effects), { ok: true });
	assert.deepEqual(ok.calls, ["open C:\\u\\Plume.exe", "quit"]);

	const failed = effects({ openInstaller: async () => "找不到文件" });
	assert.deepEqual(await finishUpdate({ kind: "installer", file: "C:\\u\\Plume.exe" }, failed.effects), { ok: false, detail: "找不到文件" });
	assert.ok(!failed.calls.includes("quit"));
});

test("只有装好的应用包算安装，开发用的 node_modules 里的 Electron 不算", () => {
	assert.equal(installedAppBundle("/Applications/Plume.app/Contents/MacOS/Plume"), "/Applications/Plume.app");
	assert.equal(installedAppBundle("/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), null);
	assert.equal(installedAppBundle("/usr/local/bin/plume"), null);
});

/** 在临时目录里真跑一次替换脚本。`open`、`xattr` 换成 PATH 里的桩，只记下被打开的是哪个。 */
async function runSwap(prepare: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "plume-swap-test-"));
	const bin = join(dir, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "open"), `#!/bin/bash\necho "$1" >> ${JSON.stringify(join(dir, "opened"))}\n`, { mode: 0o755 });
	await writeFile(join(bin, "xattr"), "#!/bin/bash\n", { mode: 0o755 });
	await prepare(dir);
	const target = join(dir, "Plume.app");
	// 等的那个进程已经不在了：一个刚退出的子进程的 pid。
	const gone = spawnSync("true").pid;
	const script = swapScript({ pid: gone, incoming: `${target}.new`, target, backup: `${target}.old` });
	const run = spawnSync("/bin/bash", ["-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	const read = (path: string) => readFile(join(dir, path), "utf8").catch(() => null);
	const result = { version: await read("Plume.app/version"), opened: await read("opened"), left: (await readdir(dir)).sort() };
	await rm(dir, { recursive: true, force: true });
	return { ...result, target };
}

async function bundle(path: string, version: string) {
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "version"), version);
}

test("替换脚本等进程走了，把拷好的新版改名换上，清掉旧的再打开", { skip: process.platform === "win32" }, async () => {
	const swapped = await runSwap(async (dir) => {
		await bundle(join(dir, "Plume.app"), "old");
		await bundle(join(dir, "Plume.app.new"), "new");
	});
	assert.equal(swapped.version, "new");
	assert.equal(swapped.opened, `${swapped.target}\n`);
	assert.deepEqual(swapped.left, ["Plume.app", "bin", "opened"]);
});

test("新版放不上时替换脚本把旧的放回去，照样打开能起来的那个", { skip: process.platform === "win32" }, async () => {
	// 拷好的新版不见了：第二次 mv 失败，要走回滚，不能停在只剩 Plume.app.old 的样子。
	const restored = await runSwap(async (dir) => {
		await bundle(join(dir, "Plume.app"), "old");
	});
	assert.equal(restored.version, "old");
	assert.equal(restored.opened, `${restored.target}\n`);
	assert.deepEqual(restored.left, ["Plume.app", "bin", "opened"]);
});

// ── 界面 ──

const t = (key: Parameters<typeof translateIn>[1], variables?: Record<string, string | number>) => translateIn("zh-CN", key, variables);

test("每个阶段都有标签和按钮字，进度不出 NaN，取消只在有东西可扔时出现", () => {
	for (const phase of PHASES) {
		assert.ok(labelFor(phase, "1.0.0", t).length > 0);
		assert.ok(confirmLabel(phase, t).length > 0);
		const fraction = fractionOf(phase);
		assert.ok(fraction === null || (fraction >= 0 && fraction <= 1));
	}
	assert.equal(fractionOf({ at: "downloading", received: 10, total: 0 }), 0);
	assert.equal(fractionOf({ at: "idle" }), null);
	assert.equal(labelFor({ at: "downloading", received: 45, total: 100 }, "1.0.0", t), "下载中 45%");
	assert.equal(confirmLabel({ at: "ready", relaunch: true }, t), "立即重启");
	assert.equal(confirmLabel({ at: "ready", relaunch: false }, t), "重新打开安装包");
	assert.equal(controlsFor({ at: "idle" }).cancel, false);
	assert.equal(controlsFor({ at: "paused", received: 1, total: 2 }).cancel, true);
	assert.equal(controlsFor({ at: "failed", error: "x", received: 0, total: 2 }).cancel, false);
	assert.equal(controlsFor({ at: "preparing", received: 2, total: 2 }).confirmDisabled, true);
	assert.equal(shouldShow({ available: false }), false);
	assert.equal(shouldShow(null), false);
});

test("失败的原话去掉路径", () => {
	assert.equal(failureDetail("UNKNOWN: unknown error, open 'C:\\Users\\x\\download.part'"), "UNKNOWN: unknown error, open");
});

test("更新内容按界面语言挑一段，中文没写退回英文，没有标记整段给", () => {
	const notes = "<!-- plume:notes en -->\n### New\n- A\n<!-- plume:notes zh-CN -->\n<details><summary>中文</summary>\n\n### 新功能\n- 甲\n</details>";
	assert.equal(notesForLocale(notes, "zh-CN"), "### 新功能\n- 甲");
	assert.equal(notesForLocale(notes, "en"), "### New\n- A");
	assert.equal(notesForLocale("<!-- plume:notes en -->\nOnly English", "zh-CN"), "Only English");
	assert.equal(notesForLocale("plain notes", "en"), "plain notes");
});
