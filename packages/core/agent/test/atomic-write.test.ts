/**
 * 整份替换文件：设置、密钥库、模型目录缓存都经它写。
 *
 * Windows 上杀毒软件、搜索索引会打开每个刚写出来的文件，那一瞬间改名盖过它会得到 EPERM、EBUSY。这在哪台机器上都没法按需
 * 复现，所以这里把两半都假装出来：平台，和那次拒绝。
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const refusals = vi.hoisted(() => ({ target: "", code: "", left: 0, refused: 0 }));

vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof import("node:fs/promises")>();
	return {
		...real,
		rename: async (from: string, to: string) => {
			if (basename(to) === refusals.target && refusals.left > 0) {
				refusals.left -= 1;
				refusals.refused += 1;
				throw Object.assign(new Error(`${refusals.code}: rename '${from}' -> '${to}'`), { code: refusals.code });
			}
			return real.rename(from, to);
		},
	};
});

const { writeFileAtomic } = await import("../src/atomic-write.ts");

let dir: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-atomic-"));
	Object.assign(refusals, { target: "", code: "", left: 0, refused: 0 });
});

afterEach(async () => {
	Object.defineProperty(process, "platform", platform);
	await rm(dir, { recursive: true, force: true });
});

const asWindows = () => Object.defineProperty(process, "platform", { ...platform, value: "win32" });
const leftovers = async () => (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
const refuse = (target: string, code: string, times: number) => Object.assign(refusals, { target, code, left: times });

it("同一个进程里同时写几次都落盘，盘上是最后完成的那份，不留临时文件", async () => {
	const file = join(dir, "settings.json");
	const results = await Promise.allSettled([1, 2, 3, 4].map((n) => writeFileAtomic(file, String(n))));
	expect(results.filter((result) => result.status === "rejected")).toEqual([]);
	expect(["1", "2", "3", "4"]).toContain(await readFile(file, "utf8"));
	expect(await leftovers()).toEqual([]);
});

it("Windows 上一时被拒的改名会重试，而不是报成保存失败", async () => {
	asWindows();
	refuse("settings.json", "EPERM", 2);
	await writeFileAtomic(join(dir, "settings.json"), "kept");
	expect(refusals.refused, "前提：前两次改名被拒").toBe(2);
	expect(await readFile(join(dir, "settings.json"), "utf8")).toBe("kept");
});

it("别的平台上同样的错误码是权限问题，直接报", async () => {
	Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
	refuse("settings.json", "EPERM", 1);
	await expect(writeFileAtomic(join(dir, "settings.json"), "x")).rejects.toThrow(/EPERM/);
	expect(refusals.refused).toBe(1);
	expect(await leftovers()).toEqual([]);
});

it("写失败时不把临时文件留下", async () => {
	// 不是「被开着」的错误码：马上报，并收拾干净。
	asWindows();
	refuse("settings.json", "EXDEV", 1);
	await expect(writeFileAtomic(join(dir, "settings.json"), "x")).rejects.toThrow(/EXDEV/);
	expect(await leftovers()).toEqual([]);
});
