/**
 * 构建一次，再用构建好的应用真实启动 Electron，经界面把产品和插件走一遍。
 *
 * 冒烟分成几段，每段一个 Electron 进程、一份自己的数据目录，互不影响：
 * - `main`：主流程（不设 PLUME_SMOKE_ONLY 时 smoke.ts 走的那一长串）；
 * - 其余各段：`PLUME_SMOKE_ONLY=<段名>`，每段先走一遍共用的开头（加假模型、提示条），再只验自己那一块。
 * `PLUME_SMOKE_ONLY=changed` 按改了哪些文件挑段（见 smoke-changed.mjs）。
 * 不设 PLUME_SMOKE_ONLY 时跑全部（段名从 smoke.ts 里读，见 `declaredSuites`），同时跑 PLUME_SMOKE_JOBS 段（缺省 4：机器算力是瓶颈，开到 6 段时每段都变慢，整轮反而不快）；`PLUME_SMOKE_ONLY=a,b` 只跑这几段。
 * 原来是一个进程从头串到尾：前面一段挂了后面都跑不到，一轮只看得到一个失败，段和段之间还互相留状态（背景图、开着的卡片、
 * 停在哪个项目）。现在一轮把每段的结果都给出来，修完只重跑挂了的那几段。
 *
 * 输出在 .smoke/<时间戳>/ 下：只跑一段时截图和数据直接放在这里、日志照常打在终端；跑几段时每段一个子目录
 * （<段名>/smoke.log 是它的日志），终端只打每段的结果和最后的汇总。过了的段删掉装进去的插件和数据目录（知识库插件一份就有
 * 八百多兆），只留截图、日志和工作目录；没过的原样留着查。.smoke/ 下只留最近 KEEP_RUNS 次（一小时内的不删，可能是别的会话正在跑）。
 * 设 PLUME_SMOKE_OUT=<截图路径> 时只能跑一段，截图和数据放在它所在的目录。
 *
 * 多个会话同时跑：构建产物（apps/desktop/out、各插件的 dist）是共用的，构建前会被清掉。所以构建排队，一次一个（.smoke/.build.lock），
 * 构建完趁还拿着锁把产物快照到这次运行自己的 app/ 下，各段的 Electron 都从这一份快照启动；别的会话之后再构建，动不到正在跑的这一份。
 * 快照按仓库的目录结构摆，宿主从 apps/desktop 往上找内置插件的路子不用改；macOS 上是 APFS 的克隆，几乎不占时间和空间。跑完删掉。
 *
 * 各段要用的市场插件从线上市场装（要联网）。
 */

import { spawn } from "node:child_process";
import { constants, createWriteStream, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join, relative, resolve } from "node:path";
import { stopProcessTree } from "../apps/desktop/scripts/stop-process.mjs";
import { changedSuites } from "./smoke-changed.mjs";

/**
 * 有哪几段从 smoke.ts 里读（`PLUME_SMOKE_ONLY === "<段名>"` 的分支），不在这里另抄一份：加了、删了一段，这里自动跟上。
 * `pnpm smoke` 跑主流程加上除 `REPRO_ONLY` 以外的全部段。
 */
const SMOKE_ENTRY = "apps/desktop/src/main/smoke.ts";
/** 主流程里已经走过同样的检查，单独跑只用来复现。 */
const REPRO_ONLY = new Set(["files"]);
/** 用时长的先起，整轮结束得早；没列的排在后面。 */
const LONG_FIRST = ["main", "environment", "environment-summary", "market", "desktop-compat", "native-ui", "conversations", "session-menu"];
/** 大半时间在等定时器（定时唤醒、摘要的一分钟），几乎不占算力：不占 PLUME_SMOKE_JOBS 的名额。 */
const IDLE = new Set(["environment", "environment-summary"]);
/** 真的读写系统剪贴板，这几段不同时跑。 */
const CLIPBOARD = new Set(["preview", "input-menu"]);
/** 一段的上限。最长的环境卡片那段要等定时唤醒到点，两分多钟。 */
const SUITE_TIMEOUT = 240_000;
const KEEP_RUNS = 10;

const repo = resolve(import.meta.dirname, "..");
const suites = pickSuites(process.env.PLUME_SMOKE_ONLY, await declaredSuites());
const jobs = Math.max(1, Number(process.env.PLUME_SMOKE_JOBS) || Math.min(4, availableParallelism()));
// 时间戳精确到毫秒，文件名里不能有冒号。
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
if (process.env.PLUME_SMOKE_OUT && suites.length > 1) fail("设了 PLUME_SMOKE_OUT 时只能跑一段：再设 PLUME_SMOKE_ONLY=<段名>");
const single = suites.length === 1;
const file = process.env.PLUME_SMOKE_OUT ? resolve(process.env.PLUME_SMOKE_OUT) : join(repo, ".smoke", stamp, "smoke.png");
const runDir = dirname(file);
const snapshot = join(runDir, "app");
console.log(`冒烟输出目录：${runDir}`);

await pruneRuns();
await withBuildLock(async () => {
	await run("pnpm", ["build"]);
	await takeSnapshot();
});

// 直接起 Electron 的二进制，不经 node_modules/.bin 里的启动脚本：Windows 上那是 `electron.cmd`，不经 shell 起不来。
const electron = createRequire(join(repo, "apps/desktop/package.json"))("electron");
const started = Date.now();
let results;
try {
	results = single ? [await runSuite(suites[0], file, "inherit")] : await runAll();
} finally {
	await rm(snapshot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
const failed = results.filter((result) => !result.ok);
if (!single) {
	console.log(`\n${results.length - failed.length}/${results.length} 段通过，用时 ${seconds(Date.now() - started)}`);
	for (const result of failed) console.log(`✗ ${result.name}：${result.error}\n  日志 ${relative(repo, result.log)}`);
	if (failed.length > 0) console.log(`\n只重跑没过的：PLUME_SMOKE_ONLY=${failed.map((result) => result.name).join(",")} pnpm smoke`);
}
process.exit(failed.length > 0 ? 1 : 0);

async function declaredSuites() {
	const source = await readFile(join(repo, SMOKE_ENTRY), "utf8");
	const names = new Set([...source.matchAll(/PLUME_SMOKE_ONLY === "([a-z0-9-]+)"/g)].map((match) => match[1]));
	const rank = (name) => (LONG_FIRST.includes(name) ? LONG_FIRST.indexOf(name) : LONG_FIRST.length);
	return ["main", ...names].sort((a, b) => rank(a) - rank(b));
}

function pickSuites(only, known) {
	const suite = (name) => ({ name, clipboard: CLIPBOARD.has(name), idle: IDLE.has(name) });
	const all = known.filter((name) => !REPRO_ONLY.has(name));
	if (!only) return all.map(suite);
	if (only === "changed") {
		const { suites, reasons, base, count } = changedSuites(repo, SMOKE_ENTRY, all);
		console.log(`相对 ${base} 改了 ${count} 个文件，挑出 ${suites.length} 段：`);
		for (const name of suites) console.log(`  ${name} ← ${reasons.get(name)}`);
		if (suites.length === 0) {
			console.log("这些改动不用跑冒烟。");
			process.exit(0);
		}
		return suites.map(suite);
	}
	const names = only
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	const unknown = names.filter((name) => !known.includes(name));
	if (unknown.length > 0) fail(`没有这几段：${unknown.join(", ")}。能跑的：${known.join(", ")}`);
	return names.map(suite);
}

/** 按 jobs 并发跑，碰剪贴板的段错开。 */
async function runAll() {
	console.log(`跑 ${suites.length} 段，同时 ${jobs} 段（${[...IDLE].join("、")} 大半在等定时器，不占名额）：${suites.map((suite) => suite.name).join(", ")}`);
	const pending = [...suites];
	const results = [];
	let clipboardBusy = false;
	await new Promise((done) => {
		let busy = 0;
		let active = 0;
		const start = (suite) => {
			active += 1;
			if (!suite.idle) busy += 1;
			if (suite.clipboard) clipboardBusy = true;
			runSuite(suite, join(runDir, suite.name, "smoke.png"), "log").then((result) => {
				active -= 1;
				if (!suite.idle) busy -= 1;
				if (suite.clipboard) clipboardBusy = false;
				results.push(result);
				console.log(`${result.ok ? "✓" : "✗"} ${suite.name}（${seconds(result.ms)}）${result.ok ? "" : `：${result.error}`}`);
				next();
			});
		};
		const next = () => {
			if (pending.length === 0 && active === 0) return done();
			for (;;) {
				const index = pending.findIndex((suite) => (suite.idle || busy < jobs) && !(suite.clipboard && clipboardBusy));
				if (index < 0) break;
				start(pending.splice(index, 1)[0]);
			}
		};
		next();
	});
	return suites.map((suite) => results.find((result) => result.name === suite.name));
}

/**
 * 起一段：`inherit` 时日志照常打在终端；`log` 时写进这段目录下的 smoke.log。
 * 结果看日志里 smoke.ts 打的 `PLUME_SMOKE {…}` 那一行，和退出码一起判。
 */
async function runSuite(suite, out, output) {
	const dir = dirname(out);
	await mkdir(dir, { recursive: true });
	const log = join(dir, "smoke.log");
	const env = { ...process.env, PLUME_SMOKE_OUT: out };
	if (suite.name === "main") delete env.PLUME_SMOKE_ONLY;
	else env.PLUME_SMOKE_ONLY = suite.name;
	const begin = Date.now();
	// 冒烟在人正在用的桌面上跑，它的窗口常被别的窗口整个挡住（人在用全屏的应用）。Chromium 默认停画被挡住的窗口，
	// 窗口里的 `<webview>` 跟着停画，浏览器截图（capturePage）就报 UnknownVizError；这两个开关让它照常画。
	const child = spawn(electron, [join(snapshot, "apps/desktop"), "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"], {
		stdio: output === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
		env,
	});
	let verdict;
	if (output === "log") {
		const sink = createWriteStream(log);
		// 结果那一行可能被拆在两块输出里：攒到换行再认。stdout、stderr 各攒各的。
		const scanner = () => {
			let rest = "";
			return (chunk) => {
				sink.write(chunk);
				const lines = (rest + String(chunk)).split("\n");
				rest = lines.pop() ?? "";
				for (const line of lines) {
					const match = /^PLUME_SMOKE (\{.*\})\s*$/.exec(line);
					if (match) verdict = parseVerdict(match[1]);
				}
			};
		};
		child.stdout.on("data", scanner());
		child.stderr.on("data", scanner());
		child.on("exit", () => sink.end());
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		console.error(`冒烟 ${suite.name} ${SUITE_TIMEOUT / 1000} 秒未结束，终止`);
		// 连 Electron 起的渲染、GPU 进程一起结束：Windows 上只结束主进程的话，它们还开着快照里的文件，删不掉。
		stopProcessTree(child).catch((error) => console.error(String(error)));
	}, SUITE_TIMEOUT);
	const code = await new Promise((done) => child.on("exit", (exitCode) => done(exitCode ?? 1)));
	clearTimeout(timer);
	const ok = !timedOut && code === 0 && (output === "inherit" || verdict?.ok === true);
	const error = timedOut ? `${SUITE_TIMEOUT / 1000} 秒未结束` : (verdict?.error ?? (ok ? undefined : `退出码 ${code}，日志里没有结果行`));
	// 过了的段删掉装进去的插件和数据目录，只留截图、日志、工作目录；只跑一段时也一样，没过的留着查。
	if (ok)
		await Promise.all(
			["plugins", "local-plugins", "home"].map((name) => rm(join(dir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
		);
	return { name: suite.name, ok, error: error?.split("\n")[0], log, ms: Date.now() - begin };
}

function parseVerdict(text) {
	try {
		return JSON.parse(text);
	} catch {
		return { ok: false, error: text };
	}
}

/** 只留最近 KEEP_RUNS 次运行；一小时内动过的不删，可能是别的会话正在跑。 */
async function pruneRuns() {
	const root = join(repo, ".smoke");
	const names = (await readdir(root).catch(() => [])).filter((name) => /^\d{4}-\d\d-\d\dT/.test(name)).sort();
	const old = names.slice(0, Math.max(0, names.length - KEEP_RUNS));
	await Promise.all(
		old.map(async (name) => {
			const path = join(root, name);
			const { mtimeMs } = await stat(path);
			if (Date.now() - mtimeMs > 3_600_000) await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}),
	);
}

function seconds(ms) {
	return `${Math.round(ms / 1000)}s`;
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

/** 一次只让一个冒烟构建、拍快照。锁文件里是持有者的进程号；持有者已经不在了（构建时被 Ctrl-C）就当作没锁。 */
async function withBuildLock(task) {
	const lock = join(repo, ".smoke/.build.lock");
	await mkdir(dirname(lock), { recursive: true });
	let waiting = false;
	for (;;) {
		try {
			await writeFile(lock, String(process.pid), { flag: "wx" });
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		// 刚建好、进程号还没写进去时读到空串：当作有人拿着。
		const owner = Number(await readFile(lock, "utf8").catch(() => ""));
		if (owner && !alive(owner)) {
			await rm(lock, { force: true });
			continue;
		}
		if (!waiting) console.log(`另一个冒烟（进程 ${owner || "?"}）正在构建，等它构建完…`);
		waiting = true;
		await sleep(500);
	}
	try {
		await task();
	} finally {
		await rm(lock, { force: true });
	}
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function run(command, args) {
	return new Promise((resolvePromise, reject) => {
		const proc = spawn(command, args, { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
		proc.on("error", reject);
		proc.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(" ")} 失败（${code}）`))));
	});
}

/**
 * 只复制会被构建改写的：桌面端的 out/ 和插件目录（含 dist/）。依赖、ripgrep、插件 SDK 构建不碰，链回仓库；
 * 根目录的 node_modules 也链过去，PLUME_SMOKE_OUT 指到仓库外时依赖照样找得到。
 */
async function takeSnapshot() {
	await rm(snapshot, { recursive: true, force: true });
	const clone = (from, to, filter) => cp(join(repo, from), join(snapshot, to ?? from), { recursive: true, mode: constants.COPYFILE_FICLONE, filter });
	const link = async (path) => {
		if (!existsSync(join(repo, path))) return;
		await mkdir(dirname(join(snapshot, path)), { recursive: true });
		await symlink(join(repo, path), join(snapshot, path), "junction");
	};
	await Promise.all([clone("apps/desktop/out"), clone("apps/desktop/package.json")]);
	await Promise.all(["node_modules", "apps/desktop/node_modules", "apps/desktop/vendor", "packages/sdk/plugin-sdk"].map(link));
	for (const entry of await readdir(join(repo, "packages/builtin"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = `packages/builtin/${entry.name}`;
		const modules = join(repo, dir, "node_modules");
		await clone(dir, dir, (source) => source !== modules);
		await link(`${dir}/node_modules`);
	}
}
