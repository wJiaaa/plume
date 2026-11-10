import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelContext, Plugin, PluginContext, PluginEntry, ToolExecution, ToolOutput } from "@plume/contract";
import { HookError, PluginHost } from "../src/host.ts";

let dir: string;
let logs: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-host-"));
	logs = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function host(disabled: string[] = []): PluginHost {
	return new PluginHost({
		dataDir: dir,
		appDataDir: dir,
		disabled: new Set(disabled),
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

function entry(plugin: unknown): PluginEntry {
	return { key: (plugin as Plugin)?.name ?? "bad", load: async () => plugin };
}

const execution = (): ToolExecution => ({
	sessionId: "s",
	cwd: dir,
	call: { id: "c", name: "t", args: {} },
	tool: { name: "t", mutating: true, plugin: "p" },
	signal: new AbortController().signal,
	ask: async () => true,
	progress: () => undefined,
});

const tool = (name: string) => ({ name, description: name, parameters: { type: "object" }, execute: async (): Promise<ToolOutput> => ({ output: name }) });

describe("PluginHost", () => {
	it("洋葱按 order 从外到内，order 相同按注册先后；不调 next 就拦下", async () => {
		const trace: string[] = [];
		const layer = (label: string) => async (input: ToolExecution, next: (input: ToolExecution) => Promise<ToolOutput>) => {
			trace.push(`>${label}`);
			const result = await next(input);
			trace.push(`<${label}`);
			return { ...result, output: `${result.output}+${label}` };
		};
		const h = host();
		await h.load([
			entry({ name: "a", apply: (ctx) => ctx.hook("tool.execute", layer("a0"), { order: 0 }) } satisfies Plugin),
			entry({ name: "b", apply: (ctx) => ctx.hook("tool.execute", layer("b-5"), { order: -5 }) } satisfies Plugin),
			entry({ name: "c", apply: (ctx) => ctx.hook("tool.execute", layer("c0")) } satisfies Plugin),
		]);
		const result = await h.run("tool.execute", execution(), async () => ({ output: "tool" }));
		expect(trace).toEqual([">b-5", ">a0", ">c0", "<c0", "<a0", "<b-5"]);
		expect(result.output).toBe("tool+c0+a0+b-5");

		const blocked = host();
		await blocked.load([entry({ name: "stop", apply: (ctx) => ctx.hook("tool.execute", async () => ({ output: "拦下", isError: true })) } satisfies Plugin)]);
		let ran = false;
		expect(await blocked.run("tool.execute", execution(), async () => ((ran = true), { output: "tool" }))).toEqual({ output: "拦下", isError: true });
		expect(ran).toBe(false);
	});

	it("某一层出错整个钩子失败，错误归到最先出错的插件", async () => {
		const h = host();
		await h.load([
			entry({ name: "outer", apply: (ctx) => ctx.hook("tool.execute", (input, next) => next(input), { order: -1 }) } satisfies Plugin),
			entry({
				name: "broken",
				apply: (ctx) =>
					ctx.hook("tool.execute", async () => {
						throw new Error("坏了");
					}),
			} satisfies Plugin),
		]);
		const failure = await h.run("tool.execute", execution(), async () => ({ output: "tool" })).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(HookError);
		expect((failure as HookError).plugin).toBe("broken");
		expect((failure as HookError).message).toContain("坏了");
	});

	it("apply 抛错时撤销已做的注册并标为 failed，不影响其他插件", async () => {
		const disposed: string[] = [];
		const h = host();
		await h.load([
			entry({
				name: "half",
				apply(ctx) {
					ctx.tools.register(tool("half_tool"));
					ctx.hook("model.context", async (input, next) => next({ ...input, systemPrompt: "改了" }));
					ctx.effect(() => void disposed.push("half"));
					throw new Error("中途失败");
				},
			} satisfies Plugin),
			entry({ name: "fine", apply: (ctx) => void ctx.tools.register(tool("fine_tool")) } satisfies Plugin),
			entry({ notAPlugin: true }),
		]);
		expect(h.status().map(({ name, state }) => [name, state])).toEqual([
			["half", "failed"],
			["fine", "active"],
			["bad", "failed"],
		]);
		expect(disposed).toEqual(["half"]);
		expect(h.toolSpecs().map((spec) => spec.name)).toEqual(["fine_tool"]);
		const context: ModelContext = {
			sessionId: "s",
			cwd: dir,
			scratchDir: join(dir, "scratch"),
			model: { id: "m", name: "M" },
			permissionMode: "auto",
			personalization: { tone: "professional", customInstructions: "" },
			systemPrompt: "原样",
			sections: [{ id: "identity", text: "原样" }],
			messages: [],
			tools: [],
		};
		expect((await h.run("model.context", context, async (input) => input)).systemPrompt).toBe("原样");
	});

	it("工具重名时后登记的生效、撤下后前一个恢复；关掉的插件不 apply；dispose 按相反顺序清理", async () => {
		const order: string[] = [];
		const h = host(["off"]);
		await h.load([
			entry({ name: "first", apply: (ctx) => (ctx.tools.register(tool("same")), ctx.effect(() => void order.push("first"))) } satisfies Plugin),
			entry({
				name: "second",
				apply: (ctx) => (ctx.tools.register({ ...tool("same"), description: "second" }), ctx.effect(() => void order.push("second"))),
			} satisfies Plugin),
			entry({ name: "off", apply: () => void order.push("off applied") } satisfies Plugin),
		]);
		expect(h.tool("same")?.plugin).toBe("second");
		expect(
			h
				.toolSpecs()
				.filter((spec) => spec.name === "same")
				.map((spec) => spec.description),
		).toEqual(["second"]);
		expect(logs.some((line) => line.startsWith("info second") && line.includes("first"))).toBe(true);
		await h.setEnabled("second", false);
		expect(h.tool("same")?.plugin).toBe("first");
		await h.setEnabled("second", true);
		expect(h.tool("same")?.plugin).toBe("second");
		expect(h.status().find((status) => status.name === "off")?.state).toBe("disabled");
		await h.dispose();
		// 第一个 second 是上面停用它时的清理。
		expect(order).toEqual(["second", "second", "first"]);
		expect(h.status().map((status) => status.state)).toEqual(["disposed", "disposed", "disabled"]);
		expect(h.tool("same")).toBeUndefined();
	});

	it("ctx.tools.names 列出各插件登记着的工具名，同名只算一个，停用的不算", async () => {
		let names: (() => string[]) | undefined;
		const h = host();
		await h.load([
			entry({
				name: "first",
				apply: (ctx) => {
					ctx.tools.register(tool("same"));
					ctx.tools.register(tool("own"));
				},
			} satisfies Plugin),
			entry({
				name: "second",
				apply: (ctx) => {
					ctx.tools.register(tool("same"));
					names = () => ctx.tools.names();
				},
			} satisfies Plugin),
		]);
		expect(names?.()).toEqual(["same", "own"]);
		await h.setEnabled("first", false);
		expect(names?.()).toEqual(["same"]);
	});

	it("后加载的插件注册同名工具时覆盖先前的，停用后先前的恢复", async () => {
		const h = host();
		await h.load([
			entry({ name: "base", apply: (ctx) => void ctx.tools.register(tool("read")) } satisfies Plugin),
			entry({
				name: "shadow",
				apply: (ctx) => void (ctx.tools.register({ ...tool("read"), description: "shadow" }), ctx.tools.register(tool("own"))),
			} satisfies Plugin),
		]);
		expect(h.tool("read")).toMatchObject({ plugin: "shadow", definition: { description: "shadow" } });
		expect(logs.some((line) => line.startsWith("info shadow") && line.includes("插件 base"))).toBe(true);
		expect(h.toolOwners()).toEqual([
			{ name: "read", plugin: "shadow" },
			{ name: "own", plugin: "shadow" },
		]);
		await h.setEnabled("shadow", false);
		expect(h.tool("read")).toMatchObject({ plugin: "base", definition: { description: "read" } });
		expect(h.tool("own")).toBeUndefined();
	});

	it("ctx.tools.register 返回的函数提前撤下这一个工具，同名的前一个恢复，再调不起作用", async () => {
		let unregister: (() => void) | undefined;
		const h = host();
		await h.load([
			entry({ name: "base", apply: (ctx) => void ctx.tools.register(tool("read")) } satisfies Plugin),
			entry({ name: "mcp", apply: (ctx) => void (unregister = ctx.tools.register({ ...tool("read"), description: "mcp" })) } satisfies Plugin),
		]);
		expect(h.tool("read")).toMatchObject({ plugin: "mcp" });
		unregister?.();
		unregister?.();
		expect(h.tool("read")).toMatchObject({ plugin: "base", definition: { description: "read" } });
		await h.setEnabled("mcp", false);
		expect(h.tool("read")).toMatchObject({ plugin: "base" });
	});

	it("ctx.plugins.list 列出启用着、加载好了、有目录的插件，停用的不在里面", async () => {
		let list: PluginContext["plugins"]["list"] | undefined;
		const h = host();
		await h.load([
			{ ...entry({ name: "reader", apply: (ctx) => void (list = ctx.plugins.list) } satisfies Plugin), dir: "/p/reader" },
			{ ...entry({ name: "bundle", apply: () => {} } satisfies Plugin), dir: "/p/bundle", builtin: true },
			{ ...entry({ name: "later", apply: () => {} } satisfies Plugin), dir: "/p/later" },
			entry({ name: "nodir", apply: () => {} } satisfies Plugin),
		]);
		expect(list?.()).toEqual([
			{ name: "reader", dir: "/p/reader", builtin: false },
			{ name: "bundle", dir: "/p/bundle", builtin: true },
			{ name: "later", dir: "/p/later", builtin: false },
		]);
		await h.setEnabled("later", false);
		expect(list?.().map((plugin) => plugin.name)).toEqual(["reader", "bundle"]);
	});

	it("ctx.plugins.onChange 在装上、卸下、启停以后叫，那时 list 已经是新的；某个出错不拦着别的，停用后撤下", async () => {
		const seen: string[][] = [];
		const h = host();
		await h.load([
			entry({
				name: "broken",
				apply: (ctx) =>
					ctx.plugins.onChange(() => {
						throw new Error("boom");
					}),
			} satisfies Plugin),
			{
				...entry({
					name: "watcher",
					apply: (ctx) => ctx.plugins.onChange(() => void seen.push(ctx.plugins.list().map((plugin) => plugin.name))),
				} satisfies Plugin),
				dir: "/p/watcher",
			},
		]);
		expect(seen).toEqual([["watcher"]]);
		await h.add({ ...entry({ name: "extra", apply: () => {} } satisfies Plugin), dir: "/p/extra" });
		await h.setEnabled("extra", false);
		await h.setEnabled("extra", true);
		await h.remove("extra");
		expect(seen.slice(1)).toEqual([["watcher", "extra"], ["watcher"], ["watcher", "extra"], ["watcher"]]);
		await h.setEnabled("watcher", false);
		await h.add({ ...entry({ name: "late", apply: () => {} } satisfies Plugin), dir: "/p/late" });
		expect(seen).toHaveLength(5);
	});

	it("会话删掉时告诉登记过的插件，某个出错不拦着别的；停用后撤下", async () => {
		const seen: string[] = [];
		const h = host();
		await h.load([
			entry({
				name: "broken",
				apply: (ctx) =>
					ctx.sessions.onDeleted(() => {
						throw new Error("坏了");
					}),
			} satisfies Plugin),
			entry({ name: "keeper", apply: (ctx) => ctx.sessions.onDeleted((sessionId) => seen.push(sessionId)) } satisfies Plugin),
		]);
		h.sessionDeleted("s1");
		expect(seen).toEqual(["s1"]);
		expect(logs.some((line) => line.startsWith("error broken") && line.includes("坏了"))).toBe(true);
		await h.setEnabled("keeper", false);
		h.sessionDeleted("s2");
		expect(seen).toEqual(["s1"]);
	});

	it("ctx.pages 带着插件名转给主进程，事件只给自己的插件，停用后撤下；没有网页时报错", async () => {
		const calls: unknown[][] = [];
		const seen: string[] = [];
		const state = { url: "https://a.test/", title: "", loading: false, canGoBack: false, canGoForward: false, crashed: false, zoom: 1 };
		const h = new PluginHost({
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
			pages: { call: async (...args) => (calls.push(args), "ok") },
		});
		let pages: PluginContext["pages"] | undefined;
		await h.load([
			entry({
				name: "web",
				apply: (ctx) => {
					pages = ctx.pages;
					ctx.pages.onEvent((event) => seen.push(`web ${event.type} ${event.page}`));
				},
			} satisfies Plugin),
			entry({ name: "other", apply: (ctx) => void ctx.pages.onEvent((event) => seen.push(`other ${event.type}`)) } satisfies Plugin),
		]);
		expect(await pages!.evaluate("p1", "1 + 1", { isolated: true })).toBe("ok");
		await pages!.attach("p1", 7);
		await pages!.inspect("http://127.0.0.1/page", { screenshot: true, width: 390 });
		expect(calls).toEqual([
			["web", "p1", "evaluate", ["1 + 1", { isolated: true }]],
			["web", "p1", "attach", [7]],
			["web", "http://127.0.0.1/page", "inspect", [{ screenshot: true, width: 390 }]],
		]);
		h.pageEvent("web", { type: "attached", page: "p1", state });
		expect(seen).toEqual(["web attached p1"]);
		await h.setEnabled("web", false);
		h.pageEvent("web", { type: "detached", page: "p1", state });
		expect(seen).toEqual(["web attached p1"]);

		let bare: PluginContext["pages"] | undefined;
		await host().load([entry({ name: "bare", apply: (ctx) => void (bare = ctx.pages) } satisfies Plugin)]);
		await expect(bare!.state("p")).rejects.toThrow(/没有网页/);
	});

	it("serve 开给界面入口的方法：CallContext 追加在最后，只认自己的方法，停用后收回", async () => {
		class Api {
			echo(text: string, context: { signal: AbortSignal }) {
				return { text, cancellable: context.signal instanceof AbortSignal };
			}
		}
		const h = host();
		await h.load([
			entry({ name: "ui", apply: (ctx) => ctx.serve(new Api()) } satisfies Plugin),
			entry({ name: "twice", apply: (ctx) => (ctx.serve({}), ctx.serve({})) } satisfies Plugin),
		]);
		const context = { signal: new AbortController().signal };
		expect(h.call("ui", "echo", ["hi"], context)).toEqual({ text: "hi", cancellable: true });
		expect(() => h.call("ui", "toString", [], context)).toThrow(/没有方法 toString/);
		expect(() => h.call("ui", "constructor", [], context)).toThrow(/没有方法/);
		expect(() => h.call("nobody", "echo", [], context)).toThrow(/没有开放/);
		expect(h.status().find((status) => status.name === "twice")?.state).toBe("failed");
		expect(() => h.call("twice", "x", [], context)).toThrow(/没有开放/);
		await h.dispose();
		expect(() => h.call("ui", "echo", ["hi"], context)).toThrow(/没有开放/);
	});

	it("运行中装上、停用、再启用、卸下插件，注册随之出现和撤销", async () => {
		let applied = 0;
		const h = host();
		await h.load([entry({ name: "core", apply: () => undefined } satisfies Plugin)]);
		const late: PluginEntry = {
			key: "late-dir",
			load: async () => ({ name: "late", apply: (ctx) => void (applied++, ctx.tools.register(tool("late_tool"))) }) satisfies Plugin,
		};
		await h.add(late);
		expect(h.status().find((status) => status.key === "late-dir")).toMatchObject({ name: "late", state: "active" });
		expect(h.tool("late_tool")?.plugin).toBe("late");
		await expect(h.add(late)).rejects.toThrow(/已经加载过/);

		expect(await h.setEnabled("late", false)).toEqual(["late"]);
		expect(h.tool("late_tool")).toBeUndefined();
		expect(h.status().find((status) => status.name === "late")?.state).toBe("disabled");
		expect(await h.setEnabled("late", true)).toEqual([]);
		expect(h.tool("late_tool")?.plugin).toBe("late");
		expect(applied).toBe(2);

		await h.remove("late-dir");
		expect(h.tool("late_tool")).toBeUndefined();
		expect(h.status().map((status) => status.name)).toEqual(["core"]);
		// 卸下以后同一个 key 可以重新装（更新就是先卸再装）。
		await h.add(late);
		expect(h.tool("late_tool")?.plugin).toBe("late");
	});
});

declare module "@plume/contract" {
	interface Services {
		echo: { say(text: string): string };
	}
}

describe("服务", () => {
	const echo = (name: string, label: string, builtin = false): PluginEntry => ({
		key: name,
		...(builtin ? { builtin } : {}),
		load: async () => ({ name, apply: (ctx) => ctx.provide("echo", { say: (text: string) => `${label}:${text}` }) }) satisfies Plugin,
	});
	/** 用 echo 的插件：每次加载记下这次拿到的服务说了什么。 */
	const consumer = (heard: string[]): PluginEntry =>
		entry({
			name: "listener",
			inject: ["echo"],
			apply: (ctx) => {
				heard.push(ctx.use("echo").say("hi"));
			},
		} satisfies Plugin);

	it("用的服务还没人提供就等着，提供方加载了再加载；拿到的只有方法，改不动", async () => {
		const heard: string[] = [];
		const h = host();
		await h.load([consumer(heard)]);
		expect(h.status()).toEqual([expect.objectContaining({ name: "listener", state: "waiting", waitingFor: ["echo"] })]);
		await h.add(echo("speaker", "a"));
		expect(heard).toEqual(["a:hi"]);
		expect(h.status().map((status) => [status.name, status.state])).toEqual([
			["listener", "active"],
			["speaker", "active"],
		]);

		let facade: { say(text: string): string } | undefined;
		await h.add(entry({ name: "peek", inject: ["echo"], apply: (ctx) => void (facade = ctx.use("echo")) } satisfies Plugin));
		expect(() => {
			(facade as { say: unknown }).say = () => "改了";
		}).toThrow(TypeError);
		expect(facade?.say("x")).toBe("a:x");
	});

	it("没写进 inject 的服务用不了，加载失败", async () => {
		const h = host();
		await h.load([echo("speaker", "a"), entry({ name: "sneaky", apply: (ctx) => void ctx.use("echo") } satisfies Plugin)]);
		expect(h.status()[1]).toEqual(expect.objectContaining({ name: "sneaky", state: "failed" }));
	});

	it("非内置的提供方替换内置的，用它的插件重新加载；卸掉以后回到内置的", async () => {
		const heard: string[] = [];
		const h = host();
		await h.load([echo("builtin-echo", "内置", true), consumer(heard)]);
		expect(heard).toEqual(["内置:hi"]);
		await h.add(echo("market-echo", "市场"));
		expect(heard).toEqual(["内置:hi", "市场:hi"]);
		await h.remove("market-echo");
		expect(heard).toEqual(["内置:hi", "市场:hi", "内置:hi"]);
	});

	it("两个非内置的提供同一项服务，先加载的生效，另一个记一条警告", async () => {
		const heard: string[] = [];
		const h = host();
		await h.load([echo("first", "一"), echo("second", "二"), consumer(heard)]);
		expect(heard).toEqual(["一:hi"]);
		expect(logs).toContainEqual(expect.stringContaining("服务 echo 由插件 first 提供"));
	});

	it("提供方停用，用它的插件回到等待；再启用又加载上", async () => {
		const heard: string[] = [];
		const h = host();
		await h.load([echo("speaker", "a"), consumer(heard)]);
		await h.setEnabled("speaker", false);
		expect(h.status()[1]).toEqual(expect.objectContaining({ name: "listener", state: "waiting", waitingFor: ["echo"] }));
		await h.setEnabled("speaker", true);
		expect(heard).toEqual(["a:hi", "a:hi"]);
		expect(h.status()[1]?.state).toBe("active");
	});

	it("内置插件不能停用，配置里写了停用也照常加载", async () => {
		const h = host(["builtin-echo"]);
		await h.load([echo("builtin-echo", "内置", true)]);
		expect(h.status()).toEqual([expect.objectContaining({ name: "builtin-echo", state: "active", builtin: true })]);
		await expect(h.setEnabled("builtin-echo", false)).rejects.toThrow(/不能停用/);
	});
});

it("运行观察各拿副本，观察者失败不影响运行，卸载时撤下", async () => {
	const h = host();
	let seen = 0;
	await h.load([
		entry({
			name: "bad-observer",
			apply(ctx) {
				ctx.sessions.observe((value) => {
					value.sessionId = "changed";
					throw new Error("observer failed");
				});
			},
		} satisfies Plugin),
		entry({
			name: "observer",
			apply(ctx) {
				ctx.sessions.observe((value) => {
					expect(value.sessionId).toBe("s");
					seen++;
				});
			},
		} satisfies Plugin),
	]);
	const value = { sessionId: "s", at: 0, timestamp: 1, event: { type: "running" as const, running: true } };
	expect(() => h.observe(value)).not.toThrow();
	expect(value.sessionId).toBe("s");
	expect(seen).toBe(1);
	expect(logs.some((line) => line.includes("observer failed"))).toBe(true);
	await h.setEnabled("observer", false);
	h.observe(value);
	expect(seen).toBe(1);
	await h.dispose();
});
