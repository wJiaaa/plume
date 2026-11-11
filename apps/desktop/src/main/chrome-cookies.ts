/**
 * 读 Chrome 的 cookie：找到它正在用的那个用户、把 cookie 库拷一份快照、用钥匙串里的密钥解开，换成 Electron 能写进会话的样子。
 * 只管读和换算，写进哪、什么时候同步在 chrome-logins.ts。
 *
 * 不引用 electron，测试才能直接加载它。解出来的值只在调用方的内存里，这里不写盘、不记日志。
 */

import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/** 这台机器上 Chrome 的数据目录；只认 macOS。 */
export function chromeDataDir(platform = process.platform, home = homedir()): string | null {
	return platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : null;
}

export interface ChromeProfile {
	/** 目录名（`Default`、`Profile 1`）。 */
	dir: string;
	/** Chrome 里显示的名字，没有时用目录名。 */
	name: string;
	/** cookie 库：新版在 `Network/Cookies`，旧版在用户目录下。 */
	cookies: string;
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

/**
 * Chrome 正在用的那个用户：`Local State` 里最后用过的，没有就是 `Default`。读不到 `Local State`（没装、没授权）时把错误抛给调用方，
 * 由它分辨是没装还是没权限。
 */
export async function chromeProfile(dataDir: string): Promise<ChromeProfile> {
	const state = JSON.parse(await readFile(join(dataDir, "Local State"), "utf8")) as {
		profile?: { last_used?: unknown; info_cache?: Record<string, { name?: unknown }> };
	};
	const lastUsed = state.profile?.last_used;
	const dir = typeof lastUsed === "string" && /^(Default|Profile \d+)$/.test(lastUsed) ? lastUsed : "Default";
	const shown = state.profile?.info_cache?.[dir]?.name;
	const network = join(dataDir, dir, "Network", "Cookies");
	return { dir, name: typeof shown === "string" && shown ? shown : dir, cookies: (await exists(network)) ? network : join(dataDir, dir, "Cookies") };
}

/** Chrome 在 macOS 上的 cookie 密钥：钥匙串里「Chrome Safe Storage」的口令按固定的盐和轮数派生。 */
export function chromeKey(password: string): Buffer {
	return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

const IV = Buffer.alloc(16, " ");

/**
 * 解开一条 cookie 的值。`v10` 是 macOS 上的 AES-128-CBC；新版 Chrome（库版本 24 起）在明文前面放了域名的 SHA-256，
 * 按内容认出来去掉，不靠版本号猜。解不开的（别的格式、密钥不对）返回 null。
 */
export function decryptCookie(encrypted: Uint8Array, hostKey: string, key: Buffer): string | null {
	const data = Buffer.from(encrypted);
	if (data.length <= 3 || data.subarray(0, 3).toString("latin1") !== "v10") return null;
	let plain: Buffer;
	try {
		const decipher = createDecipheriv("aes-128-cbc", key, IV);
		plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
	} catch {
		return null;
	}
	if (plain.length >= 32 && plain.subarray(0, 32).equals(createHash("sha256").update(hostKey).digest())) plain = plain.subarray(32);
	return plain.toString("utf8");
}

/** 写进 Electron 会话的一条 cookie，字段和 `CookiesSetDetails` 一致。 */
export interface CookieDetails {
	url: string;
	name: string;
	value: string;
	domain?: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	expirationDate?: number;
	sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

/** Chrome 的时间是 1601 年起的微秒。 */
const CHROME_EPOCH_SECONDS = 11_644_473_600;
const SAME_SITE = { [-1]: "unspecified", 0: "no_restriction", 1: "lax", 2: "strict" } as const;

/** 一条 cookie 是哪一条：域名、名字、路径。 */
export function cookieKey(cookie: { domain?: string; url: string; name: string; path: string }): string {
	return [cookie.domain ?? new URL(cookie.url).hostname, cookie.name, cookie.path].join("\t");
}

type Row = Record<string, unknown>;

/**
 * 库里的一行换成一条 cookie。过期的、分区的（只在某个顶层网站下有效，Electron 写不进它的分区）、解不开的都不要。
 * `domain` 只给以点开头的域 cookie；只属于一个主机的不给，写进去才仍是只属于那个主机。
 */
export function toCookie(row: Row, key: Buffer, now = Date.now() / 1000): CookieDetails | null {
	const host = String(row.host_key ?? "");
	const name = String(row.name ?? "");
	const path = String(row.path ?? "/") || "/";
	if (!host || (typeof row.top_frame_site_key === "string" && row.top_frame_site_key !== "")) return null;
	const encrypted = row.encrypted_value instanceof Uint8Array ? row.encrypted_value : null;
	const value = encrypted && encrypted.length > 0 ? decryptCookie(encrypted, host, key) : typeof row.value === "string" ? row.value : null;
	if (value === null) return null;
	const expires = Number(row.expires_utc ?? 0);
	const persistent = Number(row.has_expires ?? row.is_persistent ?? (expires > 0 ? 1 : 0)) !== 0 && expires > 0;
	const expirationDate = persistent ? expires / 1_000_000 - CHROME_EPOCH_SECONDS : undefined;
	if (expirationDate !== undefined && expirationDate <= now) return null;
	const secure = Number(row.is_secure ?? 0) !== 0;
	const sameSite = SAME_SITE[Number(row.samesite ?? -1) as keyof typeof SAME_SITE] ?? "unspecified";
	return {
		url: `${secure ? "https" : "http"}://${host.replace(/^\./, "")}${path}`,
		name,
		value,
		...(host.startsWith(".") ? { domain: host } : {}),
		path,
		secure,
		httpOnly: Number(row.is_httponly ?? 0) !== 0,
		...(expirationDate !== undefined ? { expirationDate } : {}),
		sameSite,
	};
}

/** 用 SQLite 的在线备份把 `from` 拷成一份一致的 `to`。 */
async function snapshot(from: string, to: string): Promise<void> {
	const source = new DatabaseSync(from, { readOnly: true });
	try {
		await backup(source, to);
	} finally {
		source.close();
	}
}

/**
 * 读一次 Chrome 的 cookie。Chrome 开着时库随时在写：先用 SQLite 的在线备份拷一份一致的快照到临时目录，读完就删。
 * Chrome 锁着库、在线备份打不开时，把库和它的 `-wal` 原样拷出来再备份一次；这样还不行就抛错，下一轮再试。
 */
export async function readChromeCookies(dbPath: string, key: Buffer): Promise<CookieDetails[]> {
	const dir = await mkdtemp(join(tmpdir(), "plume-chrome-"));
	try {
		const copy = join(dir, "Cookies");
		try {
			await snapshot(dbPath, copy);
		} catch {
			await rm(copy, { force: true });
			const staged = join(dir, "staged");
			await copyFile(dbPath, staged);
			if (await exists(`${dbPath}-wal`)) await copyFile(`${dbPath}-wal`, `${staged}-wal`);
			await snapshot(staged, copy);
		}
		const db = new DatabaseSync(copy, { readOnly: true });
		try {
			// 时间是 1601 年起的微秒，超出 JS 的安全整数，按 BigInt 读，toCookie 里再换成秒。
			const query = db.prepare("SELECT * FROM cookies");
			query.setReadBigInts(true);
			const rows = query.all() as Row[];
			return rows.flatMap((row) => {
				const cookie = toCookie(row, key);
				return cookie ? [cookie] : [];
			});
		} finally {
			db.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** 一条 cookie 的指纹：值和属性变了它就变。记在同步状态里，用来跳过没变的；只有哈希，不含值本身。 */
function fingerprint(cookie: CookieDetails): string {
	return createHash("sha256").update(JSON.stringify(cookie)).digest("base64");
}

/** 同一个键的两条里留哪条：https 写进来的优先，再看谁过期得晚（会话 cookie 算最晚）。 */
function preferred(a: CookieDetails, b: CookieDetails): CookieDetails {
	if (a.secure !== b.secure) return a.secure ? a : b;
	return (b.expirationDate ?? Infinity) > (a.expirationDate ?? Infinity) ? b : a;
}

export interface CookiePlan {
	set: CookieDetails[];
	/** 上次同步进来、这次 Chrome 里已经没有的。 */
	remove: string[];
}

/**
 * 这一次要写哪些、删哪些。`synced` 是上次同步进来的（键 → 指纹），没变的不重写：网站在这边轮换过的 cookie 不被 Chrome 的旧值盖回去。
 * Chrome 的库还按来源协议、端口区分，同一个键可能有两行；写进这边只能是一条，先挑定一条，不然两条的指纹轮流对不上、每轮都重写。
 */
export function planSync(chrome: CookieDetails[], synced: ReadonlyMap<string, string>): CookiePlan & { next: Map<string, string> } {
	const unique = new Map<string, CookieDetails>();
	for (const cookie of chrome) {
		const key = cookieKey(cookie);
		const have = unique.get(key);
		unique.set(key, have ? preferred(have, cookie) : cookie);
	}
	const next = new Map<string, string>();
	const set: CookieDetails[] = [];
	for (const [key, cookie] of unique) {
		const print = fingerprint(cookie);
		next.set(key, print);
		if (synced.get(key) !== print) set.push(cookie);
	}
	return { set, remove: [...synced.keys()].filter((key) => !next.has(key)), next };
}
