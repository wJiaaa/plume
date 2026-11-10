import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MESSAGES } from "../src/messages.ts";
import { createSealer } from "../src/sealer.ts";

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "plume-secrets-"));
	try {
		await body(dir);
	} finally {
		await chmod(join(dir, "vault.key"), 0o600).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
}

const sealerIn = (dir: string) => createSealer(dir, () => MESSAGES.en);

test("加密后带前缀、认得出，解回原值；每次的密文都不一样", () =>
	withDir(async (dir) => {
		const sealer = sealerIn(dir);
		const a = await sealer.seal("ghp_secret");
		const b = await sealer.seal("ghp_secret");
		assert.ok(sealer.isSealed(a));
		assert.notEqual(a, b);
		assert.ok(!a.includes("ghp_secret"));
		assert.equal(await sealer.unseal(a), "ghp_secret");
		assert.equal(await sealer.unseal(await sealer.seal("")), "");
		// 换一个实例（下次启动）用盘上的同一把钥匙。
		assert.equal(await sealerIn(dir).unseal(b), "ghp_secret");
		assert.equal((await stat(join(dir, "vault.key"))).mode & 0o777, 0o600);
	}));

test("明文和坏掉的密文解出来是 null，也不为它们生成钥匙", () =>
	withDir(async (dir) => {
		const sealer = sealerIn(dir);
		for (const value of ["ghp_plain", "plume-sealed:v1:", "plume-sealed:v1:@@", "plume-sealed:v1:AAAA"]) assert.equal(await sealer.unseal(value), null, value);
		assert.equal(sealer.isSealed("ghp_plain"), false);
		assert.deepEqual(await readdir(dir), []);
	}));

test("别的钥匙加密的密文打不开，是 null 不是报错", () =>
	withDir(async (dir) =>
		withDir(async (other) => {
			const foreign = await sealerIn(other).seal("token");
			const sealer = sealerIn(dir);
			await sealer.seal("mine");
			assert.equal(await sealer.unseal(foreign), null);
		}),
	));

test("同时第一次加密只生成一把钥匙", () =>
	withDir(async (dir) => {
		const sealers = [sealerIn(dir), sealerIn(dir), sealerIn(dir)];
		const sealed = await Promise.all(sealers.flatMap((sealer, index) => [sealer.seal(`v${index}`), sealer.seal(`w${index}`)]));
		const fresh = sealerIn(dir);
		assert.deepEqual(await Promise.all(sealed.map((value) => fresh.unseal(value))), ["v0", "w0", "v1", "w1", "v2", "w2"]);
		assert.deepEqual(
			(await readdir(dir)).filter((name) => name.startsWith("vault.key")),
			["vault.key"],
		);
	}));

test("长度不对的钥匙挪到旁边、换一把新的", () =>
	withDir(async (dir) => {
		await writeFile(join(dir, "vault.key"), "short");
		const sealer = sealerIn(dir);
		assert.equal(await sealer.unseal(await sealer.seal("x")), "x");
		const names = await readdir(dir);
		assert.ok(names.some((name) => name.startsWith("vault.key.bad-")));
		assert.equal((await readFile(join(dir, "vault.key"))).length, 32);
	}));

test("钥匙文件读不出来时报错，不换新的", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () =>
	withDir(async (dir) => {
		const sealed = await sealerIn(dir).seal("x");
		const before = await readFile(join(dir, "vault.key"));
		await chmod(join(dir, "vault.key"), 0o000);
		await assert.rejects(sealerIn(dir).unseal(sealed), /Can’t read the key/);
		await assert.rejects(sealerIn(dir).seal("y"), /Can’t read the key/);
		await chmod(join(dir, "vault.key"), 0o600);
		assert.deepEqual(await readFile(join(dir, "vault.key")), before);
	}),
);
