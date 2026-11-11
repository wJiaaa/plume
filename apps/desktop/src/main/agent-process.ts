/**
 * agent 进程（utilityProcess）的入口：建 agent、加载插件，然后在两条通道上提供服务——
 * parentPort 上给主进程（插件状态、关闭、网页事件），每个渲染进程转交来的 MessagePort 上给界面（AgentService）；
 * 插件的网页（ctx.pages）反过来经 parentPort 调主进程。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgent, SessionDbUnavailable } from "@plume/agent";
import type { PluginEntry } from "@plume/contract";
import { type Port, RpcChannel, remote, serve } from "@plume/rpc";
import { net, type MessagePortMain } from "electron";
import {
	type AgentProcessApi,
	CATALOG_FILE_ENV,
	DATA_DIR_ENV,
	LOCALE_ENV,
	type MainProcessApi,
	NATIVE_ROOTS_ENV,
	PLUGINS_ENV,
	type PluginDir,
	SETTINGS_FILE_ENV,
} from "../shared/protocol.ts";
import { redirectNativeLoads } from "./native-cache.ts";

const parent = process.parentPort;
const listeners = new Set<(message: unknown) => void>();
parent.on("message", (event) => {
	const data = event.data as { t?: unknown } | undefined;
	if (data?.t === "connect") {
		const port = event.ports[0];
		// agent 起不来时由下面的 ready.catch 报给主进程；这里不能让它变成未处理的拒绝，进程会在报告送达前崩掉。
		if (port) connect(port).catch(() => port.close());
		return;
	}
	for (const listener of listeners) listener(event.data);
});

const toMain = new RpcChannel({
	post: (message) => parent.postMessage(message),
	listen: (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
});

const main = remote<MainProcessApi>(toMain);

// i18n-exempt：主进程总会传这两个变量，缺了只会在开发时的日志里看到。
const dataDir = process.env[DATA_DIR_ENV];
if (!dataDir) throw new Error(`缺少环境变量 ${DATA_DIR_ENV}`);
const settingsFile = process.env[SETTINGS_FILE_ENV];
if (!settingsFile) throw new Error(`缺少环境变量 ${SETTINGS_FILE_ENV}`);
const dirs = JSON.parse(process.env[PLUGINS_ENV] ?? "[]") as PluginDir[];
// 在加载任何插件之前：之后插件 require 的 .node 才都经过它。
redirectNativeLoads(process, {
	platform: process.platform,
	roots: JSON.parse(process.env[NATIVE_ROOTS_ENV] ?? "[]") as string[],
	cacheDir: join(dataDir, "native-cache"),
});

/**
 * 插件的入口。地址带上加载时刻：插件市场更新了文件再加载时，模块缓存按地址认，
 * 不换地址拿到的还是旧模块（界面入口同理）。
 */
function entryOf({ key, dir, builtin }: PluginDir): PluginEntry {
	const stamp = Date.now();
	return {
		key,
		dir,
		...(builtin ? { builtin } : {}),
		load: async () => ((await import(/* @vite-ignore */ `${pathToFileURL(join(dir, "dist/index.mjs")).href}?v=${stamp}`)) as { default?: unknown }).default,
		...(existsSync(join(dir, "dist/ui.mjs")) ? { ui: `plume-plugin://${key}/dist/ui.mjs?v=${stamp}` } : {}),
	};
}

const ready = createAgent({
	dataDir,
	settingsFile,
	trash: async (path) => await main.trash(path),
	...(process.env[CATALOG_FILE_ENV] ? { catalogFile: process.env[CATALOG_FILE_ENV] } : {}),
	plugins: dirs.map(entryOf),
	// utility process 直接使用 Chromium 网络栈，继承系统代理，令牌不经过界面。
	fetch: (url, init) => net.fetch(url, init),
	locale: process.env[LOCALE_ENV] === "en" ? "en" : "zh-CN",
	// 插件的网页只有主进程碰得到，ctx.pages 的调用都转过去。
	pages: { call: async (plugin, id, method, args) => await main.page(plugin, id, method, args) },
	log: (source, level, message) => console[level === "info" ? "log" : level](`[${source}] ${message}`),
});
ready.catch(async (error: unknown) => {
	console.error("agent 启动失败：", error);
	// 什么都离不开会话库，起不来就交给主进程说清楚在哪、为什么，由它退出应用；它没接住才自己退出。
	const where = error instanceof SessionDbUnavailable ? error : { path: dataDir, reason: error instanceof Error ? error.message : String(error) };
	await main.startupFailed(where.path, where.reason).catch(() => undefined);
	process.exit(1);
});

serve(toMain, {
	async *watch(call) {
		yield* (await ready).service.watch(call);
	},
	plugins: async () => (await ready).service.listPlugins(),
	addPlugin: async (dir) => (await ready).addPlugin(entryOf(dir)),
	removePlugin: async (key) => (await ready).removePlugin(key),
	busy: async () => (await ready).busy(),
	filePath: async (sessionId, path) => (await ready).filePath(sessionId, path),
	sessions: async () => (await ready).service.listSessions(),
	pageEvent: async (plugin, event) => (await ready).host.pageEvent(plugin, event),
	shutdown: async () => {
		await (await ready).shutdown();
		// 先把这次调用的结果回给主进程，再退出。
		setTimeout(() => process.exit(0), 0);
	},
} satisfies AgentProcessApi);

async function connect(port: MessagePortMain): Promise<void> {
	const agent = await ready;
	const wire: Port = {
		post: (message) => port.postMessage(message),
		listen: (listener) => {
			const handler = (event: { data: unknown }) => listener(event.data);
			port.on("message", handler);
			return () => port.off("message", handler);
		},
	};
	const channel = new RpcChannel(wire);
	serve(channel, agent.service);
	port.on("close", () => channel.close());
	port.start();
}
