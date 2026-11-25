/**
 * 给插件的逻辑入口写测试用：`@plumeai/plugin-sdk/testing`。不起 Plume、不调模型，在测试进程里把插件的 `apply` 跑一遍，
 * 再直接跑它注册的工具、按 `order` 串起它加的钩子层，看返回了什么。
 *
 * 假的 ctx 只在内存里实现插件最常用、行为由本体约定好的那几样：工具、钩子、effect、settings、store、sessionStore、
 * serve、provide / use、命令、日志、提示，和 ctx.sessions 的 `on*` 订阅、observe。其余成员（fetch、model、workspace、
 * sessions 的读写……）背后是真实的会话、模型和文件系统，假的一份只会让测试测到假的那份：碰到就抛错，测试经 `options.ctx` 给出自己要的。
 * 工具的 run 也一样，`ask`、`request`、`exec`、`files` 这些按调用给。
 *
 * 不模拟的本体行为：参数按 `parameters` 整理和查类型、审批、沙箱、钩子链里别的插件的层、系统提示词冻结。
 * 这几样要在 Plume 里装上实际跑一遍（plume-plugin dev），或看 `ctx.sessions.observe` 的调用轨迹。
 *
 * 不依赖测试框架：node:test、vitest 里都能用。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 这些名字会被测试框架、await、JSON 顺手探一下，不当成插件在用这个成员。 */
const PROBED = new Set(["then", "toJSON", "asymmetricMatch", "$$typeof"]);

/**
 * 没实现的成员一碰就抛错，说出它的全名和怎么给。
 * @param {string} path 报错里这个对象的名字（`ctx`、`ctx.sessions`、`run`）
 * @param {string} how 怎么给它
 */
function strict(target, path, how) {
	return new Proxy(target, {
		get(object, key, receiver) {
			if (typeof key === "symbol" || key in object || PROBED.has(key)) return Reflect.get(object, key, receiver);
			throw new Error(`测试里的 ${path} 没有 ${key}：${how}`);
		},
	});
}

/** 都是普通对象时浅合并，别的情况 override 整个换掉 base。 */
function merge(base, override) {
	const plain = (value) => typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
	if (plain(base) && plain(override)) return { ...base, ...override };
	return override;
}

/** 从 list 里拿掉 item；拿过了不再动。 */
function remove(list, item) {
	const index = list.indexOf(item);
	if (index >= 0) list.splice(index, 1);
}

/** ctx.sessions 上测试能经 `emit` 触发的订阅。 */
const SESSION_EVENTS = ["observe", "onDeleted", "onArchived", "onEnded", "onStopped", "onContextReset"];

/**
 * @param {import("./testing.d.mts").TestedPlugin} plugin 插件的默认导出
 * @param {import("./testing.d.mts").LoadOptions} [options]
 */
export async function loadPlugin(plugin, options = {}) {
	const name = plugin.name;
	// 临时目录用到时才建：只测钩子、不碰文件的测试不用 dispose 也不留东西。
	let root;
	const temp = (...parts) => {
		root ??= mkdtempSync(join(tmpdir(), "plume-plugin-test-"));
		const path = join(root, ...parts);
		mkdirSync(path, { recursive: true });
		return path;
	};

	const tools = new Map();
	/** @type {Array<{ name: string, layer: Function, order: number, seq: number }>} */
	const layers = [];
	const effects = [];
	const commands = [];
	const notices = [];
	const logs = [];
	const provided = new Map();
	const stores = new Map();
	const sessionStores = new Map();
	const listeners = Object.fromEntries(SESSION_EVENTS.map((event) => [event, []]));
	let api;
	let settings;
	let calls = 0;

	const listTools = () => [
		...(options.tools ?? []),
		...[...tools.values()].map((tool) => ({ name: tool.name, plugin: name, kind: tool.kind, category: tool.category })),
	];

	const sessions = Object.fromEntries(
		SESSION_EVENTS.map((event) => [
			event,
			(listener) => {
				listeners[event].push(listener);
				return () => remove(listeners[event], listener);
			},
		]),
	);

	const base = {
		name,
		// 本体在 apply 之前建好 dataDir。
		get dataDir() {
			return temp("data");
		},
		get appDataDir() {
			return temp("app");
		},
		locale: () => options.locale ?? "en",
		log: {
			info: (message) => void logs.push({ level: "info", message }),
			warn: (message) => void logs.push({ level: "warn", message }),
			error: (message) => void logs.push({ level: "error", message }),
		},
		notice: (sessionId, text, level) => void notices.push({ sessionId, text, level }),
		tools: {
			register(tool) {
				tools.set(tool.name, tool);
				return () => tools.delete(tool.name);
			},
			names: () => listTools().map((tool) => tool.name),
			list: listTools,
		},
		hook(hookName, layer, hookOptions) {
			layers.push({ name: hookName, layer, order: hookOptions?.order ?? 0, seq: layers.length });
		},
		effect: (dispose) => void effects.push(dispose),
		serve(served) {
			if (api !== undefined) throw new Error("一个插件只能 serve 一次");
			api = served;
		},
		async settings(defaults, normalize) {
			if (settings !== undefined) throw new Error("一个插件只能调一次 ctx.settings");
			const read = (saved) => {
				const merged = { ...defaults, ...saved };
				if (normalize) return normalize(merged);
				return Object.fromEntries(Object.keys(defaults).map((key) => [key, merged[key]]));
			};
			let value = read(options.settings ?? {});
			const changed = [];
			settings = {
				get: () => value,
				async set(patch) {
					value = read({ ...value, ...patch });
					for (const listener of changed) listener(value);
					return value;
				},
				onChange(listener) {
					changed.push(listener);
					return () => remove(changed, listener);
				},
			};
			return settings;
		},
		store(key, initial) {
			if (stores.has(key)) throw new Error(`store ${key} 登记过了`);
			let value = initial;
			const store = {
				get: () => value,
				set: (next) => void (value = next),
				update: (change) => void (value = change(value)),
			};
			stores.set(key, store);
			return store;
		},
		sessionStore(key, initial) {
			if (sessionStores.has(key)) throw new Error(`sessionStore ${key} 登记过了`);
			const values = new Map();
			const get = (sessionId) => (values.has(sessionId) ? values.get(sessionId) : initial);
			const store = {
				get,
				set: (sessionId, value) => void values.set(sessionId, value),
				update: (sessionId, change) => void values.set(sessionId, change(get(sessionId))),
				delete: (sessionId) => void values.delete(sessionId),
			};
			sessionStores.set(key, store);
			return store;
		},
		commands: { provide: (provider) => void commands.push(provider) },
		provide: (serviceName, service) => void provided.set(serviceName, service),
		use(serviceName) {
			if (!plugin.inject?.includes(serviceName)) throw new Error(`用服务 ${serviceName} 要先写进插件的 inject`);
			const service = options.services?.[serviceName];
			if (service === undefined) throw new Error(`测试没给服务 ${serviceName}：经 loadPlugin 的 options.services 给一份`);
			return service;
		},
		sessions,
	};

	const overrides = options.ctx ?? {};
	// 按属性描述复制：展开会读一遍 dataDir 这些 getter，临时目录就建出来了。
	const members = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base));
	for (const [key, value] of Object.entries(overrides)) {
		const current = Object.getOwnPropertyDescriptor(base, key)?.value;
		Object.defineProperty(members, key, { value: merge(current, value), enumerable: true, writable: true, configurable: true });
	}
	members.sessions = strict(members.sessions, "ctx.sessions", "经 loadPlugin 的 options.ctx.sessions 给一份");
	const ctx = strict(members, "ctx", "经 loadPlugin 的 options.ctx 给一份");

	await plugin.apply(ctx);

	const tool = (toolName) => {
		const found = tools.get(toolName);
		if (!found) throw new Error(`插件没有注册工具 ${toolName}；注册了的：${[...tools.keys()].join("、") || "（没有）"}`);
		return found;
	};

	return {
		ctx,
		tool,
		get api() {
			return api;
		},
		commands,
		provided,
		notices,
		logs,
		get settings() {
			return settings;
		},
		store(key) {
			const found = stores.get(key);
			if (!found) throw new Error(`插件没有登记 store ${key}`);
			return found;
		},
		sessionStore(key) {
			const found = sessionStores.get(key);
			if (!found) throw new Error(`插件没有登记 sessionStore ${key}`);
			return found;
		},

		async runTool(toolName, args = {}, run = {}) {
			const sessionId = run.sessionId ?? "session";
			const defaults = {
				sessionId,
				session: { id: sessionId, kind: "top" },
				toolCallId: `call-${++calls}`,
				cwd: options.cwd ?? temp("cwd"),
				scratchDir: temp("scratch", sessionId),
				signal: new AbortController().signal,
				progress() {},
				tools: listTools,
				calls: [],
			};
			return tool(toolName).execute(args, strict({ ...defaults, ...run }, "run", "经 runTool 的第三个参数给一份"));
		},

		async hook(hookName, input, inner) {
			// order 小的在外层，相同时按注册先后，和本体一样。
			const chain = layers.filter((entry) => entry.name === hookName).sort((a, b) => a.order - b.order || a.seq - b.seq);
			const call = (index, value) => (index === chain.length ? inner(value) : chain[index].layer(value, (next) => call(index + 1, next)));
			return call(0, input);
		},

		async emit(event, ...args) {
			if (!SESSION_EVENTS.includes(event)) throw new Error(`emit 只认 ${SESSION_EVENTS.join("、")}`);
			// 本体删会话时自己丢掉按会话的状态，插件不用在 onDeleted 里清。
			if (event === "onDeleted") for (const store of sessionStores.values()) store.delete(args[0]);
			for (const listener of [...listeners[event]]) await listener(...args);
		},

		async dispose() {
			// 后登记的先执行，和停用时一样。
			for (const dispose of effects.reverse()) await dispose();
			effects.length = 0;
			if (root) rmSync(root, { recursive: true, force: true });
		},
	};
}
