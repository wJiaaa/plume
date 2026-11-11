/**
 * 市场测试的夹具：在本机起一个只听 127.0.0.1 的静态服务，按插件仓库 build-dist.mjs 的格式发插件
 * （marketplace.json、assets/<名字>/、plugins/<名字>/<版本>/<平台>-<架构>.tgz），再开一个连着它的市场。
 * 不启动 Electron；IPC 和窗口 API 不在这些路径上。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type { TestContext } from "node:test";
import { TARGET } from "../src/main/market-remote.ts";

const electron = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "electron")
			return {
				url: 'data:text/javascript,export const app = { getPreferredSystemLanguages: () => ["zh-CN"] }, BrowserWindow = {}, ipcMain = {}, shell = {};',
				shortCircuit: true,
			};
		return nextResolve(specifier, context);
	},
});
const { createMarket } = await import("../src/main/market.ts").finally(() => electron.deregister());

export interface FixturePlugin {
	id: string;
	version: string;
	/** 包里的文件，相对插件目录；缺省只有 package.json 和 dist/index.mjs。 */
	files?: Record<string, string | Buffer>;
	icon?: Buffer;
	readme?: string;
	/** assets/<名字>/ 下的文件，README 里的图。 */
	assets?: Record<string, Buffer>;
	/** 写进索引这一条的其余字段（prompts、category……）。 */
	extra?: Record<string, unknown>;
}

async function put(file: string, content: string | Buffer) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, content);
}

/** 起服务。publish 换掉整个市场；requests 是收到过的路径。 */
export async function serveMarket(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "plume-market-served-"));
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		requests.push(path);
		const file = join(root, normalize(path));
		if (!file.startsWith(root)) return void response.writeHead(404).end();
		readFile(file).then(
			(bytes) => response.writeHead(200, { "content-length": bytes.length }).end(bytes),
			() => response.writeHead(404).end(),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
	});
	const { port } = server.address() as { port: number };
	const base = `http://127.0.0.1:${port}/`;

	async function publish(plugins: FixturePlugin[]): Promise<{ plugins: Record<string, unknown>[] }> {
		const index = { name: "test", plugins: [] as Record<string, unknown>[] };
		for (const plugin of plugins) {
			const staging = await mkdtemp(join(tmpdir(), "plume-market-pack-"));
			const files = plugin.files ?? { "package.json": JSON.stringify({ name: plugin.id, version: plugin.version }), "dist/index.mjs": "export default {};" };
			for (const [path, content] of Object.entries(files)) await put(join(staging, path), content);
			const path = `plugins/${plugin.id}/${plugin.version}/${TARGET}.tgz`;
			const archive = join(root, path);
			await mkdir(dirname(archive), { recursive: true });
			execFileSync("tar", ["-czf", archive, "-C", staging, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
			await rm(staging, { recursive: true, force: true });
			const bytes = await readFile(archive);
			const entry: Record<string, unknown> = {
				name: plugin.id,
				displayName: plugin.id,
				description: `${plugin.id} 的说明`,
				version: plugin.version,
				...plugin.extra,
				builds: { [TARGET]: { path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } },
			};
			if (plugin.icon) {
				await put(join(root, "assets", plugin.id, "icon.png"), plugin.icon);
				entry.icon = `assets/${plugin.id}/icon.png`;
			}
			if (plugin.readme) {
				await put(join(root, "assets", plugin.id, "README.md"), plugin.readme);
				entry.readme = `assets/${plugin.id}/README.md`;
			}
			for (const [name, content] of Object.entries(plugin.assets ?? {})) await put(join(root, "assets", plugin.id, name), content);
			index.plugins.push(entry);
		}
		await writeIndex(index);
		return index;
	}

	/** 直接写索引：测坏条目时用。 */
	const writeIndex = (index: unknown) => writeFile(join(root, "marketplace.json"), JSON.stringify(index));

	return { url: `${base}marketplace.json`, base, root, requests, publish, writeIndex };
}

/** 开一个连着 catalogUrl 的市场，自动更新关着；added、removed 是让 agent 进程加载、卸下的插件；busy 是 agent 进程有没有会话在跑，缺省一直闲着。 */
export async function openMarket(t: TestContext, catalogUrl: string, { busy = () => false }: { busy?: () => boolean } = {}) {
	const work = await mkdtemp(join(tmpdir(), "plume-market-"));
	t.after(() => rm(work, { recursive: true, force: true }));
	const settingsFile = join(work, "market.json");
	await writeFile(settingsFile, JSON.stringify({ autoUpdate: false }));
	const added: string[] = [];
	const removed: string[] = [];
	const logs: string[] = [];
	const market = createMarket({
		catalogUrl,
		builtinDir: join(work, "builtin"),
		installDir: join(work, "plugins"),
		uploadDir: join(work, "local-plugins"),
		settingsFile,
		pluginDirs: new Map(),
		agent: {
			addPlugin: async ({ key }) => void added.push(key),
			removePlugin: async (key) => void removed.push(key),
			busy: async () => busy(),
		},
		announce: () => undefined,
		log: (line) => void logs.push(line),
	});
	return { market, work, installDir: join(work, "plugins"), uploadDir: join(work, "local-plugins"), added, removed, logs };
}
