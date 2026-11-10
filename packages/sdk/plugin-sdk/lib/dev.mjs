/**
 * 开发一个插件：构建、装进 Plume，然后盯着源码，一改就重新构建、重新装。Plume 开着的话每次都当场换上新的。
 */

import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { buildPlugin } from "./build.mjs";
import { installPlugin } from "./install.mjs";

/** 连续保存（编辑器、agent 一次改几个文件）只算一次。 */
const SETTLE_MS = 200;

/**
 * @param {string} target 插件目录
 * @param {{ root?: string, log?: (line: string) => void }} [options] root：装到哪个目录下
 * @returns {() => void} 停止监视
 */
export function devPlugin(target, options = {}) {
	const dir = resolve(target);
	const log = options.log ?? console.log;
	let timer;
	let running = Promise.resolve();

	const round = () => {
		running = running.then(async () => {
			try {
				const built = await buildPlugin(dir);
				const installed = installPlugin(dir, options.root);
				log(`✓ ${built} → ${installed}`);
			} catch (error) {
				// esbuild 的报错它自己已经打过了；没构建成功就不装，Plume 里还是上一份能用的。
				if (!error?.errors) log(`✗ ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	};

	round();
	const watchers = [
		watch(join(dir, "src"), { recursive: true }, schedule),
		watch(dir, (_event, name) => {
			if (name === "package.json" || name === "README.md") schedule();
		}),
	];
	function schedule() {
		clearTimeout(timer);
		timer = setTimeout(round, SETTLE_MS);
	}
	return () => {
		clearTimeout(timer);
		for (const watcher of watchers) watcher.close();
	};
}
