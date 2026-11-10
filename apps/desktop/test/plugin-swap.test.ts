/**
 * 换上、拿掉插件目录（main/plugin-swap.ts）和 Windows 上带重试的改名（main/rename-retry.ts）。
 *
 * 换不成时装着的那份必须原样不变：Windows 上目录里有开着的文件时改名被拒，原来先 `rm -r` 再改名，会留下删了一半的插件。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discard, swapIn } from "../src/main/plugin-swap.ts";
import { heldOpen, renameWithRetry } from "../src/main/rename-retry.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "plume-swap-"));
	const plugins = join(root, "plugins");
	const retired = join(root, ".plugins-retired");
	const staging = join(root, ".plugins-staging", "demo");
	const target = join(plugins, "demo");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "version"), "old");
	mkdirSync(staging, { recursive: true });
	writeFileSync(join(staging, "version"), "new");
	return { root, retired, staging, target, done: () => rmSync(root, { recursive: true, force: true }) };
}

const busy = () => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });

test("换上：新的放到原处，旧的挪开后删掉", async () => {
	const { retired, staging, target, done } = fixture();
	try {
		const aside = await swapIn([{ from: staging, to: target }], retired);
		assert.equal(readFileSync(join(target, "version"), "utf8"), "new");
		assert.equal(aside.length, 1);
		await discard(aside, retired);
		assert.equal(existsSync(retired), false);
		assert.equal(existsSync(staging), false);
	} finally {
		done();
	}
});

test("拿掉：只挪开，原处不留东西", async () => {
	const { retired, target, done } = fixture();
	try {
		await discard(await swapIn([{ from: null, to: target }], retired), retired);
		assert.equal(existsSync(target), false);
	} finally {
		done();
	}
});

test("新的挪不进去：旧的挪回原处，一个文件都不少", async () => {
	const { retired, staging, target, done } = fixture();
	try {
		const fail = async (from: string, to: string) => {
			if (from === staging) throw busy();
			await rename(from, to);
		};
		await assert.rejects(swapIn([{ from: staging, to: target }], retired, { rename: fail, platform: "win32", attempts: 2, stepMs: 1 }), /EBUSY/);
		assert.equal(readFileSync(join(target, "version"), "utf8"), "old");
		assert.equal(readFileSync(join(staging, "version"), "utf8"), "new");
		assert.deepEqual(readdirSync(retired), []);
	} finally {
		done();
	}
});

test("旧的挪不开（Windows 上有文件开着）：什么都不动", async () => {
	const { retired, staging, target, done } = fixture();
	try {
		const fail = async () => {
			throw busy();
		};
		await assert.rejects(swapIn([{ from: staging, to: target }], retired, { rename: fail, platform: "win32", attempts: 1 }), /EBUSY/);
		assert.equal(readFileSync(join(target, "version"), "utf8"), "old");
		assert.equal(readFileSync(join(staging, "version"), "utf8"), "new");
	} finally {
		done();
	}
});

test("改名重试：只在 Windows 上、只对占用类错误等，每次多等一步", async () => {
	let calls = 0;
	const flaky = async () => {
		if (++calls < 3) throw busy();
	};
	await renameWithRetry("a", "b", { rename: flaky, platform: "win32", stepMs: 1 });
	assert.equal(calls, 3);

	calls = 0;
	await assert.rejects(renameWithRetry("a", "b", { rename: flaky, platform: "darwin", stepMs: 1 }), /EBUSY/);
	assert.equal(calls, 1, "macOS 上同样的错误码说的是权限，不该重试");

	calls = 0;
	const missing = async () => {
		calls++;
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	await assert.rejects(renameWithRetry("a", "b", { rename: missing, platform: "win32", stepMs: 1 }), /ENOENT/);
	assert.equal(calls, 1);

	calls = 0;
	const always = async () => {
		calls++;
		throw busy();
	};
	await assert.rejects(renameWithRetry("a", "b", { rename: always, platform: "win32", attempts: 4, stepMs: 1 }), /EBUSY/);
	assert.equal(calls, 4);
	assert.equal(heldOpen(busy(), "win32"), true);
	assert.equal(heldOpen(busy(), "linux"), false);
});
