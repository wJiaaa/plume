import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { chromeKey, chromeProfile, cookieKey, decryptCookie, planSync, readChromeCookies, toCookie } from "../src/main/chrome-cookies.ts";

const key = chromeKey("test-password");
const NOW = 1_800_000_000;
/** Unix 秒换成 Chrome 的 1601 年起的微秒。 */
const chromeTime = (seconds: number) => (seconds + 11_644_473_600) * 1_000_000;

function encrypt(value: string, host: string, withHash = true): Uint8Array {
	const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
	const plain = Buffer.concat([withHash ? createHash("sha256").update(host).digest() : Buffer.alloc(0), Buffer.from(value)]);
	return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

const row = (overrides: Record<string, unknown> = {}) => ({
	host_key: ".example.com",
	name: "sid",
	value: "",
	encrypted_value: encrypt("secret", ".example.com"),
	path: "/",
	expires_utc: chromeTime(NOW + 3600),
	has_expires: 1,
	is_secure: 1,
	is_httponly: 1,
	samesite: 1,
	top_frame_site_key: "",
	...overrides,
});

test("解开新旧两种明文：带域名哈希的去掉哈希，旧的原样", () => {
	assert.equal(decryptCookie(encrypt("abc", "a.com"), "a.com", key), "abc");
	assert.equal(decryptCookie(encrypt("abc", "a.com", false), "a.com", key), "abc");
	assert.equal(decryptCookie(encrypt("abc", "a.com"), "a.com", chromeKey("wrong")), null);
	assert.equal(decryptCookie(Buffer.from("v11xxxxxxxxxxxxxxxx"), "a.com", key), null);
});

test("一行换成 Electron 的 cookie", () => {
	assert.deepEqual(toCookie(row(), key, NOW), {
		url: "https://example.com/",
		name: "sid",
		value: "secret",
		domain: ".example.com",
		path: "/",
		secure: true,
		httpOnly: true,
		expirationDate: NOW + 3600,
		sameSite: "lax",
	});
	// 只属于一个主机的不给 domain；会话 cookie 没有过期时间；明文存的照用。
	const host = toCookie(
		row({ host_key: "app.example.com", encrypted_value: Buffer.alloc(0), value: "plain", has_expires: 0, expires_utc: 0, is_secure: 0, samesite: -1 }),
		key,
		NOW,
	);
	assert.deepEqual(host, { url: "http://app.example.com/", name: "sid", value: "plain", path: "/", secure: false, httpOnly: true, sameSite: "unspecified" });
});

test("过期的、分区的、解不开的不要", () => {
	assert.equal(toCookie(row({ expires_utc: chromeTime(NOW - 1) }), key, NOW), null);
	assert.equal(toCookie(row({ top_frame_site_key: "https://other.com" }), key, NOW), null);
	assert.equal(toCookie(row(), chromeKey("wrong"), NOW), null);
});

test("同步计划：同一个键的几行只留一条，下一轮不再重写", () => {
	const plain = toCookie(row({ is_secure: 0, samesite: -1, encrypted_value: encrypt("http", ".example.com") }), key, NOW)!;
	const secure = toCookie(row({ encrypted_value: encrypt("https", ".example.com") }), key, NOW)!;
	for (const order of [
		[plain, secure],
		[secure, plain],
	]) {
		const first = planSync(order, new Map());
		assert.deepEqual(first.set, [secure]);
		assert.deepEqual(planSync(order, first.next).set, []);
	}
});

test("同步计划：没变的不重写，Chrome 里没了的删掉", () => {
	const a = toCookie(row(), key, NOW)!;
	const b = toCookie(row({ name: "theme", encrypted_value: encrypt("dark", ".example.com") }), key, NOW)!;
	const first = planSync([a, b], new Map());
	assert.equal(first.set.length, 2);
	assert.deepEqual(first.remove, []);
	const changed = { ...a, value: "rotated" };
	const second = planSync([changed], first.next);
	assert.deepEqual(second.set, [changed]);
	assert.deepEqual(second.remove, [cookieKey(b)]);
	assert.deepEqual(planSync([changed], second.next).set, []);
});

test("从库里读：认出最后用过的用户，读快照", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-chrome-test-"));
	try {
		await writeFile(join(dir, "Local State"), JSON.stringify({ profile: { last_used: "Profile 2", info_cache: { "Profile 2": { name: "工作" } } } }));
		await mkdir(join(dir, "Profile 2", "Network"), { recursive: true });
		const file = join(dir, "Profile 2", "Network", "Cookies");
		const db = new DatabaseSync(file);
		db.exec(
			"CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)",
		);
		const insert = db.prepare(
			"INSERT INTO cookies (host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		const far = chromeTime(Math.floor(Date.now() / 1000) + 86_400);
		insert.run(".example.com", "", "sid", "", encrypt("secret", ".example.com"), "/", far, 1, 1, 1, 1);
		insert.run(".example.com", "", "old", "", encrypt("x", ".example.com"), "/", chromeTime(1), 1, 1, 1, 1);
		db.close();

		const profile = await chromeProfile(dir);
		assert.deepEqual(profile, { dir: "Profile 2", name: "工作", cookies: file });
		const cookies = await readChromeCookies(profile.cookies, key);
		assert.deepEqual(
			cookies.map((cookie) => [cookie.name, cookie.value]),
			[["sid", "secret"]],
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("没有 Local State 时报 ENOENT，交给调用方分辨", async () => {
	await assert.rejects(chromeProfile(join(tmpdir(), "plume-no-chrome-here")), { code: "ENOENT" });
});
