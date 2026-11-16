import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin, PluginEntry, PluginValueKind } from "@plume/contract";
import { PluginHost } from "../src/host.ts";

let dir: string;
let logs: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-values-"));
	logs = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function host(options: { sdkVersion?: string } = {}): PluginHost {
	return new PluginHost({
		...options,
		dataDir: dir,
		appDataDir: dir,
		log: (source, level, message) => logs.push(`${level} ${source}: ${message}`),
		model: {
			complete: async () => "",
			usage: async () => ({ requests: [], providerNames: {}, archived: [] }),
			findImageModel: async () => ({ reason: "none", candidates: [] }),
			image: async () => ({ ok: false, failure: { summary: "" } }),
		},
		notice: () => {},
	});
}

const entry = (plugin: Plugin, extra: Partial<PluginEntry> = {}): PluginEntry => ({ key: plugin.name, load: async () => plugin, ...extra });

/** 订阅一个值，`next()` 取下一次推来的。 */
function subscribe(h: PluginHost, plugin: string, kind: PluginValueKind, key: string, sessionId?: string) {
	const controller = new AbortController();
	const iterator = h.values.watch(plugin, kind, key, sessionId, controller.signal);
	return {
		next: async () => (await iterator.next()).value,
		stop: () => controller.abort(),
	};
}

describe("插件的设置和运行状态", () => {
	it("设置：读盘和缺省值合并；界面改的、逻辑入口改的都存盘并推给订阅者，只收缺省值里有的键", async () => {
		await mkdir(join(dir, "p"), { recursive: true });
		await writeFile(join(dir, "p", "settings.json"), JSON.stringify({ model: "saved", junk: 1 }));
		const changes: unknown[] = [];
		const h = host();
		await h.load([
			entry({
				name: "p",
				async apply(ctx) {
					const settings = await ctx.settings<{ model?: string; enabled: boolean }>({ model: undefined, enabled: true });
					settings.onChange((value) => changes.push(value));
				},
			}),
		]);
		const watch = subscribe(h, "p", "settings", "");
		expect(await watch.next()).toEqual({ model: "saved", enabled: true });
		expect(await h.values.setSettings("p", { enabled: false, junk: 2 })).toEqual({ model: "saved", enabled: false });
		expect(await watch.next()).toEqual({ model: "saved", enabled: false });
		expect(changes).toEqual([{ model: "saved", enabled: false }]);
		expect(JSON.parse(await readFile(join(dir, "p", "settings.json"), "utf8"))).toEqual({ model: "saved", enabled: false });
		// 两次连着改不互相盖掉。
		await Promise.all([h.values.setSettings("p", { model: undefined }), h.values.setSettings("p", { enabled: true })]);
		expect(JSON.parse(await readFile(join(dir, "p", "settings.json"), "utf8"))).toEqual({ enabled: true });
		watch.stop();
	});

	it("设置：normalize 校验读到的和改的，抛错就不改", async () => {
		const h = host();
		await h.load([
			entry({
				name: "p",
				async apply(ctx) {
					await ctx.settings({ limit: 10 }, (saved) => {
						if (typeof saved.limit !== "number" || saved.limit < 1) throw new Error("limit must be positive");
						return { limit: saved.limit };
					});
				},
			}),
		]);
		await expect(h.values.setSettings("p", { limit: 0 })).rejects.toThrow("limit must be positive");
		expect(await h.values.setSettings("p", { limit: 3 })).toEqual({ limit: 3 });
	});

	it("运行状态：先订阅后登记也等得到；只推最新的；停用后等下一次登记", async () => {
		const h = host();
		const watch = subscribe(h, "p", "store", "count");
		const first = watch.next();
		let set!: (value: number) => void;
		await h.load([
			entry({
				name: "p",
				apply(ctx) {
					set = ctx.store("count", 0).set;
				},
			}),
		]);
		expect(await first).toBe(0);
		await h.setEnabled("p", false);
		const again = watch.next();
		set(5);
		await h.setEnabled("p", true);
		// 重新启用是重新 apply：值回到 initial。
		expect(await again).toBe(0);
		watch.stop();
	});

	it("运行状态：set 推给订阅者，来不及取的中间值跳过；同一个 key 不能登记两次", async () => {
		const h = host();
		let set!: (value: number) => void;
		await h.load([
			entry({
				name: "p",
				apply(ctx) {
					const store = ctx.store("count", 0);
					set = store.set;
					expect(() => ctx.store("count", 1)).toThrow();
				},
			}),
		]);
		const watch = subscribe(h, "p", "store", "count");
		expect(await watch.next()).toBe(0);
		set(1);
		set(2);
		expect(await watch.next()).toBe(2);
		watch.stop();
	});

	it("按会话的状态：没设过的会话读到 initial；会话删掉后回到 initial", async () => {
		const h = host();
		let set!: (sessionId: string, value: string) => void;
		await h.load([
			entry({
				name: "p",
				apply(ctx) {
					set = ctx.sessionStore("summary", "none").set;
				},
			}),
		]);
		const a = subscribe(h, "p", "session", "summary", "a");
		const b = subscribe(h, "p", "session", "summary", "b");
		expect(await a.next()).toBe("none");
		expect(await b.next()).toBe("none");
		set("a", "done");
		expect(await a.next()).toBe("done");
		h.sessionDeleted("a");
		expect(await a.next()).toBe("none");
		a.stop();
		b.stop();
	});

	it("按会话的状态带 load：订阅一个还没设过的会话先读，读到之前不推；读完前 set 过的以 set 为准", async () => {
		const h = host();
		let set!: (sessionId: string, value: string) => void;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		await h.load([
			entry({
				name: "p",
				apply(ctx) {
					set = ctx.sessionStore("summary", "none", async (sessionId) => {
						await gate;
						return `saved ${sessionId}`;
					}).set;
				},
			}),
		]);
		const a = subscribe(h, "p", "session", "summary", "a");
		const b = subscribe(h, "p", "session", "summary", "b");
		const first = a.next();
		const second = b.next();
		set("b", "fresh");
		release();
		expect(await first).toBe("saved a");
		expect(await second).toBe("fresh");
		a.stop();
		b.stop();
	});

	it("按会话的状态带 load：最后一个订阅者走了就丢掉读回来的，下次订阅再读；set 过的留着", async () => {
		const h = host();
		const reads: string[] = [];
		let store!: { get(sessionId: string): string; set(sessionId: string, value: string): void };
		await h.load([
			entry({
				name: "p",
				apply(ctx) {
					store = ctx.sessionStore("summary", "none", async (sessionId) => {
						reads.push(sessionId);
						return `saved ${sessionId}`;
					});
				},
			}),
		]);
		// 结束订阅：停下后再取一次，让生成器走到 finally。
		const close = async (watch: ReturnType<typeof subscribe>) => {
			watch.stop();
			await watch.next();
		};
		const a = subscribe(h, "p", "session", "summary", "a");
		const again = subscribe(h, "p", "session", "summary", "a");
		expect(await a.next()).toBe("saved a");
		expect(await again.next()).toBe("saved a");
		await close(a);
		// 还有人看着：不丢。
		expect(store.get("a")).toBe("saved a");
		await close(again);
		expect(store.get("a")).toBe("none");
		const back = subscribe(h, "p", "session", "summary", "a");
		expect(await back.next()).toBe("saved a");
		expect(reads).toEqual(["a", "a"]);
		store.set("a", "fresh");
		expect(await back.next()).toBe("fresh");
		await close(back);
		expect(store.get("a")).toBe("fresh");
	});

	it("停用时撤下：订阅者等着，界面改设置报错", async () => {
		const h = host();
		await h.load([
			entry({
				name: "p",
				async apply(ctx) {
					await ctx.settings({ on: true });
				},
			}),
		]);
		await h.setEnabled("p", false);
		await expect(h.values.setSettings("p", { on: false })).rejects.toThrow();
	});

	it("加载失败时说明插件是按哪一版 SDK 构建的", async () => {
		const h = host({ sdkVersion: "0.6.0" });
		const broken = (name: string): Plugin => ({
			name,
			apply() {
				throw new Error("boom");
			},
		});
		await h.load([
			entry(broken("newer"), { sdk: "0.7.1" }),
			entry(broken("older"), { sdk: "0.5.9" }),
			entry(broken("unknown")),
			entry(broken("same"), { sdk: "0.6.0" }),
		]);
		const errors = Object.fromEntries(h.status().map((status) => [status.name, status.error]));
		expect(errors.newer).toMatch(/0\.7\.1.*0\.6\.0/);
		expect(errors.older).toMatch(/0\.5\.9.*0\.6\.0/);
		expect(errors.unknown).toMatch(/0\.6\.0/);
		expect(errors.same).toBe("boom");
	});
});
