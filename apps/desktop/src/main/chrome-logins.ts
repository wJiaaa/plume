/**
 * 从本机 Chrome 同步登录状态（`ctx.pages.chromeLogins`）：开着时启动同步一次，之后每隔一会儿看 Chrome 的 cookie 库变没变，变了就再同步。
 * 单向：同一条 cookie 以 Chrome 为准，Chrome 里没了的（退出登录）这边也删；只在 Plume 里登录的网站不动。
 *
 * 开启要人在系统对话框里点头：`ctx.pages` 是公开接口，任何插件都调得到，确认不能交给插件的界面。
 * 钥匙串里的口令、派生的密钥和 cookie 的值只在这个进程的内存里，不进日志，不交给插件。盘上只记开没开、同步进来的是哪几条
 * （键和指纹，指纹用来认出没变的不重写：网站在这边轮换过的 cookie 不被 Chrome 的旧值盖回去）。
 */

import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, nativeImage, type Session } from "electron";
import iconPath from "../assets/icon.png?asset";
import type { ChromeLoginSync, Locale } from "@plume/contract";
import { chromeDataDir, chromeKey, cookieKey, chromeProfile, type ChromeProfile, planSync, readChromeCookies } from "./chrome-cookies.ts";
import { nativeText } from "./i18n.ts";

/** 看 Chrome 的 cookie 库变没变的间隔。只是 stat 几个文件，变了才读。 */
const POLL_MS = 15_000;
/** 钥匙串弹窗等人点的上限。 */
const KEYCHAIN_TIMEOUT_MS = 120_000;

type Problem = NonNullable<ChromeLoginSync["problem"]>;

class SyncProblem extends Error {
	constructor(
		readonly problem: Problem,
		detail?: string,
	) {
		super(detail ?? problem);
	}
}

interface Saved {
	enabled: boolean;
	/** 同步进来的 cookie：键 → 指纹。 */
	synced: [string, string][];
}

let web: Session | undefined;
let locale: () => Locale = () => "zh-CN";
let stateFile = "";
let current: ChromeLoginSync = { enabled: false };
let synced = new Map<string, string>();
let key: Buffer | undefined;
let timer: NodeJS.Timeout | undefined;
let seen = "";
/** 一次只做一件事：同步、开、关排着队。 */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
	const next = queue.then(task, task);
	queue = next.catch(() => {});
	return next;
}

async function save(): Promise<void> {
	const saved: Saved = { enabled: current.enabled, synced: [...synced] };
	await writeFile(stateFile, JSON.stringify(saved));
}

/**
 * 起步：读上次的开关，开着就接着同步（不再问人；钥匙串由系统再问一次）。不劝人选「始终允许」：那会把 `/usr/bin/security` 加进
 * 这一项的许可名单，之后本机任何程序经它都能静默读到 Chrome 的密钥。派生的密钥留在内存里，一次启动只问一次。
 */
export async function startChromeLogins(options: { session: Session; locale: () => Locale }): Promise<void> {
	web = options.session;
	locale = options.locale;
	stateFile = join(app.getPath("userData"), "chrome-logins.json");
	try {
		const saved = JSON.parse(await readFile(stateFile, "utf8")) as Saved;
		synced = new Map(saved.synced);
		if (saved.enabled) {
			current = { enabled: true };
			void serial(() => begin());
		}
	} catch {
		// 没开过。
	}
}

export async function chromeLogins(command: unknown): Promise<ChromeLoginSync> {
	if (command !== "status" && command !== "on" && command !== "off") throw new Error("chromeLogins takes status, on or off");
	if (!chromeDataDir()) return { enabled: false, problem: "unsupported" };
	if (command === "status") return { ...current };
	if (command === "on") return await serial(turnOn);
	return await serial(turnOff);
}

async function turnOn(): Promise<ChromeLoginSync> {
	// 已经开着时是「再试一次」：钥匙串被拒后不再自己弹，等人点。
	if (!current.enabled) {
		const lang = locale();
		const options = {
			// 用应用图标，不用黄色警告三角：这是人主动打开的功能，要说清的风险写在正文里。
			icon: nativeImage.createFromPath(iconPath),
			message: nativeText(lang, "chromeLogins.confirmTitle"),
			detail: nativeText(lang, "chromeLogins.confirmDetail"),
			buttons: [nativeText(lang, "chromeLogins.confirm"), nativeText(lang, "chromeLogins.cancel")],
			defaultId: 1,
			cancelId: 1,
		};
		const window = BrowserWindow.getFocusedWindow();
		const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
		if (response !== 0) return { ...current };
		current = { enabled: true };
		await save();
	}
	await begin();
	return { ...current };
}

async function turnOff(): Promise<ChromeLoginSync> {
	clearInterval(timer);
	timer = undefined;
	key = undefined;
	seen = "";
	if (web) {
		for (const cookie of synced.keys()) await removeCookie(web, cookie);
		await web.cookies.flushStore();
	}
	synced = new Map();
	current = { enabled: false };
	await save();
	return { ...current };
}

/** 马上同步一次，再开始盯着。 */
async function begin(): Promise<void> {
	seen = "";
	await syncOnce();
	if (!current.enabled || timer) return;
	timer = setInterval(() => void serial(syncOnce), POLL_MS);
	timer.unref();
}

/** Chrome 的库和它的日志文件的修改时间，变了才值得读。 */
async function version(profile: ChromeProfile): Promise<string> {
	const times = await Promise.all(
		["", "-wal", "-journal"].map((suffix) =>
			stat(profile.cookies + suffix).then(
				(info) => info.mtimeMs,
				() => 0,
			),
		),
	);
	return `${profile.cookies}\t${times.join(",")}`;
}

async function syncOnce(): Promise<void> {
	if (!current.enabled || !web) return;
	try {
		const dataDir = chromeDataDir();
		if (!dataDir) throw new SyncProblem("unsupported");
		const profile = await chromeProfile(dataDir).catch((error: unknown) => {
			throw readProblem(error);
		});
		const now = await version(profile).catch((error: unknown) => {
			throw readProblem(error);
		});
		if (now === seen && !current.problem) return;
		key ??= chromeKey(await keychainPassword());
		const cookies = await readChromeCookies(profile.cookies, key).catch((error: unknown) => {
			throw readProblem(error);
		});
		const plan = planSync(cookies, synced);
		for (const cookie of plan.set) {
			// 个别写不进的（Electron 不认的属性组合）跳过；不记进已同步，下次再试。
			await web.cookies.set(cookie).catch(() => void plan.next.delete(cookieKey(cookie)));
		}
		for (const cookie of plan.remove) await removeCookie(web, cookie);
		await web.cookies.flushStore();
		synced = plan.next;
		seen = now;
		current = { enabled: true, profile: profile.name, cookies: synced.size, syncedAt: Date.now() };
		await save();
	} catch (error) {
		const problem = error instanceof SyncProblem ? error.problem : "failed";
		current = {
			enabled: true,
			problem,
			...(problem === "failed" ? { detail: error instanceof Error ? error.message : String(error) } : {}),
			...(current.syncedAt ? { profile: current.profile, cookies: current.cookies, syncedAt: current.syncedAt } : {}),
		};
		// 钥匙串被拒时不再自己试：每一轮都会再弹一次系统对话框。等人点「再试一次」。
		if (problem === "keychain-denied") {
			clearInterval(timer);
			timer = undefined;
		}
	}
}

/** 读 Chrome 的数据出错时是哪一种：没装、系统不让读（macOS 的完全磁盘访问权限），还是别的。 */
function readProblem(error: unknown): SyncProblem {
	if (error instanceof SyncProblem) return error;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return new SyncProblem("no-chrome");
	if (code === "EPERM" || code === "EACCES") return new SyncProblem("no-access");
	return new SyncProblem("failed", error instanceof Error ? error.message : String(error));
}

/** 钥匙串里「Chrome Safe Storage」的口令。第一次要人在系统对话框里允许。 */
function keychainPassword(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"], { timeout: KEYCHAIN_TIMEOUT_MS }, (error, stdout) => {
			const password = stdout.trim();
			if (error || !password) reject(new SyncProblem("keychain-denied"));
			else resolve(password);
		});
	});
}

/** 按键（域名、名字、路径）删掉同步进来的一条。 */
async function removeCookie(session: Session, entry: string): Promise<void> {
	const [domain = "", name = "", path = "/"] = entry.split("\t");
	const host = domain.replace(/^\./, "");
	if (!host) return;
	const found = await session.cookies.get({ domain: host, name, path }).catch(() => []);
	for (const cookie of found) {
		if (cookie.domain !== domain || cookie.path !== path) continue;
		await session.cookies.remove(`${cookie.secure ? "https" : "http"}://${host}${path}`, name).catch(() => {});
	}
}
