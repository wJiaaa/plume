/**
 * 供应商的 key 不再明文躺在 `settings.json` 里：加密存进数据目录的 `credentials.json`，钥匙是 `vault.key`。
 *
 * 要防的不是崩溃，是 `settings.json` 以 0644 带着所有 key 被拷来拷去、贴进问题报告。key 都是假的。
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Agent, createAgent } from "../src/index.ts";
import type { StoredProvider } from "../src/models.ts";
import { createVault, providerKeys } from "../src/vault.ts";

let dir: string;
let agent: Agent | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-vault-"));
});

afterEach(async () => {
	await agent?.shutdown();
	agent = undefined;
	await rm(dir, { recursive: true, force: true });
});

function provider(id: string, apiKey?: string): StoredProvider {
	return { id, name: id, api: "anthropic-messages", baseUrl: "https://example.invalid", enabled: true, models: [], ...(apiKey ? { apiKey } : {}) };
}

/** chmod 000 挡不住 Windows 和 root。 */
const chmodBlocks = process.platform !== "win32" && process.getuid?.() !== 0;

it("存进去的取得回来，密文里没有原文；这把钥匙打不开的是 null", async () => {
	const vault = createVault(dir);
	await vault.putSecrets({ "provider:p1": "sk-fake-one" });
	const stored = JSON.parse(await readFile(join(dir, "credentials.json"), "utf8")) as { secrets: Record<string, string> };
	expect(stored.secrets["provider:p1"]).toMatch(/^v1:/);
	expect(JSON.stringify(stored)).not.toContain("sk-fake-one");
	expect(await createVault(dir).secret("provider:p1")).toBe("sk-fake-one");

	await writeFile(join(dir, "credentials.json"), JSON.stringify({ secrets: { a: "v1:bm90IGV2ZW4gY2xvc2U=", b: "旧版本的明文" } }));
	expect(await vault.secret("a")).toBeNull();
	expect(await vault.secret("b")).toBeNull();
	expect(await vault.secret("missing")).toBeNull();
});

it.skipIf(process.platform === "win32")("钥匙和密文都是 0600", async () => {
	await createVault(dir).putSecrets({ "provider:p1": "sk-fake-one" });
	for (const name of ["vault.key", "credentials.json"]) expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
});

it.skipIf(!chmodBlocks)("钥匙文件读不出来时报错，不换一把新的", async () => {
	await createVault(dir).putSecrets({ "provider:p1": "sk-kept" });
	const keyFile = join(dir, "vault.key");
	const before = await readFile(keyFile);
	const vault = createVault(dir);
	await chmod(keyFile, 0o000);
	try {
		// 不是 null：null 表示密钥没了，调用方会把它删掉。
		await expect(vault.secret("provider:p1")).rejects.toThrow(keyFile);
		await expect(vault.putSecrets({ "provider:p2": "sk-new" })).rejects.toThrow(keyFile);
	} finally {
		await chmod(keyFile, 0o600);
	}
	expect(await readFile(keyFile)).toEqual(before);
	expect(await vault.secret("provider:p1")).toBe("sk-kept");
});

it("长度不对的钥匙挪到旁边，不覆盖", async () => {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "vault.key"), "short");
	await createVault(dir).putSecrets({ "provider:p1": "sk-fake-one" });
	const names = await readdir(dir);
	const backups = names.filter((name) => name.startsWith("vault.key.bad-"));
	expect(backups).toHaveLength(1);
	expect(await readFile(join(dir, backups[0]!), "utf8")).toBe("short");
	expect((await readFile(join(dir, "vault.key"))).length).toBe(32);
	expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("几个进程同时第一次用，最后只有一把钥匙", async () => {
	// 每个子进程对着空目录封一个值；封出来的都要能用最后留在盘上的那把钥匙打开。
	const script = `
		const { createVault } = await import(${JSON.stringify(new URL("../src/vault.ts", import.meta.url).href)});
		const vault = createVault(${JSON.stringify(dir)});
		await vault.putSecrets({ ["p" + process.pid]: "sk-" + process.pid });
		process.stdout.write(String(process.pid));
	`;
	const pids = await Promise.all(
		Array.from(
			{ length: 4 },
			() =>
				new Promise<string>((resolve, reject) => {
					execFile(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], (error, stdout) =>
						error ? reject(error) : resolve(stdout),
					);
				}),
		),
	);
	// 四个进程各自读、改、写 credentials.json，后写的会盖掉先写的条目；这里只问每个能打开的都打得开。
	const stored = JSON.parse(await readFile(join(dir, "credentials.json"), "utf8")) as { secrets: Record<string, string> };
	const vault = createVault(dir);
	for (const id of Object.keys(stored.secrets)) expect(await vault.secret(id)).toBe(`sk-${id.slice(1)}`);
	expect(Object.keys(stored.secrets).length).toBeGreaterThan(0);
	expect(pids).toHaveLength(4);
});

it("读设置时填回 key：vault 里的为准，手写在文件里的照样能用；写时拿出来、删掉的供应商一起忘掉", async () => {
	const vault = createVault(dir);
	const keys = providerKeys(vault);
	const toWrite = await keys.takeKeys({ providers: [provider("p1", "sk-one"), provider("p2", "sk-two")] });
	expect(toWrite.providers.every((entry) => !("apiKey" in entry))).toBe(true);

	const filled = await keys.withKeys({ providers: [provider("p1", "sk-stale"), provider("p2"), provider("p3", "sk-typed")] });
	expect(filled.providers.map((entry) => [entry.id, entry.apiKey])).toEqual([
		["p1", "sk-one"],
		["p2", "sk-two"],
		["p3", "sk-typed"],
	]);

	await keys.takeKeys({ providers: [provider("p1", "sk-one")] });
	const stored = JSON.parse(await readFile(join(dir, "credentials.json"), "utf8")) as { secrets: Record<string, string> };
	expect(Object.keys(stored.secrets)).toEqual(["provider:p1"]);
});

it.skipIf(!chmodBlocks)("钥匙文件读不出来时读到的设置没有 key，那时保存不会删掉存着的 key", async () => {
	await providerKeys(createVault(dir)).takeKeys({ providers: [provider("p1", "sk-kept")] });
	const keyFile = join(dir, "vault.key");
	const keys = providerKeys(createVault(dir));
	await chmod(keyFile, 0o000);
	let loaded;
	try {
		loaded = await keys.withKeys({ providers: [provider("p1")] });
	} finally {
		await chmod(keyFile, 0o600);
	}
	expect(loaded.providers[0]!.apiKey).toBeUndefined();
	// 桌面端下一次改设置时把手里这份写回去，那时钥匙已经读得出来了。
	await keys.takeKeys(loaded);
	expect(await createVault(dir).secret("provider:p1")).toBe("sk-kept");
});

it("经 agent 保存的供应商：settings.json 里没有 key、只有本人可读，重开以后 key 还在", async () => {
	const settingsFile = join(dir, "settings.json");
	const dataDir = join(dir, "data");
	await writeFile(settingsFile, JSON.stringify({ providers: [provider("p-typed", "sk-fake-typed")] }));
	agent = await createAgent({ dataDir, settingsFile, plugins: [], log: () => undefined });
	await agent.service.saveProvider({ ...provider(""), name: "新的", apiKey: "sk-fake-saved" });

	const onDisk = await readFile(settingsFile, "utf8");
	expect(onDisk).not.toContain("sk-fake-typed");
	expect(onDisk).not.toContain("sk-fake-saved");
	if (process.platform !== "win32") expect((await stat(settingsFile)).mode & 0o777).toBe(0o600);
	expect(await readdir(dataDir)).toEqual(expect.arrayContaining(["credentials.json", "vault.key"]));

	await agent.shutdown();
	agent = await createAgent({ dataDir, settingsFile, plugins: [], log: () => undefined });
	expect((await agent.service.getSettings()).providers.map((entry) => [entry.name, entry.hasKey])).toEqual([
		["p-typed", true],
		["新的", true],
	]);
});
