import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * 去掉 KaTeX 的 `woff` 和 `ttf` 字体。
 *
 * KaTeX 的二十来个字体每个都带三份，给不支持 `woff2` 的老浏览器用。Plume 只跑在一个引擎上，它支持 `woff2`
 * 已经很多年——另外两份是 3MB 多永远不会被请求的文件。
 *
 * 在产物上做而不是在样式表上做：Vite 看到样式表时 Tailwind 已经把 `@import` 内联了，文件不再认得出是 KaTeX 的；
 * 产物里的文件名还认得出。
 */
function katexWoff2Only(): Plugin {
	return {
		name: "katex-woff2-only",
		generateBundle(_options, bundle) {
			const dropped: string[] = [];
			for (const file of Object.keys(bundle)) {
				// `.woff2` 不匹配：`$` 要求名字在 `woff` 处结束。
				if (/KaTeX_[^/]*\.(woff|ttf)$/.test(file)) {
					dropped.push(file.split("/").pop() as string);
					delete bundle[file];
				}
			}
			if (dropped.length === 0) return;

			for (const asset of Object.values(bundle)) {
				if (asset.type !== "asset" || !asset.fileName.endsWith(".css")) continue;
				let css = String(asset.source);
				for (const name of dropped) {
					// 整个 `, url(…) format(…)` 子句一起去掉；留下一个悬空的逗号会让整条规则失效。
					const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					css = css.replace(new RegExp(`\\s*,\\s*url\\(["']?[^)"']*${escaped}["']?\\)\\s*format\\([^)]*\\)`, "g"), "");
				}
				asset.source = css;
			}
		},
	};
}

export default defineConfig({
	main: {
		build: {
			rolldownOptions: {
				input: {
					index: resolve(import.meta.dirname, "src/main/index.ts"),
					// agent 进程（utilityProcess）的入口。
					"agent-process": resolve(import.meta.dirname, "src/main/agent-process.ts"),
					// Windows 上沙箱的 runner（`@plume/sandbox` 经 ELECTRON_RUN_AS_NODE 起它），agent 进程经 useSandboxRunner 指过去。
					"sandbox-runner": resolve(import.meta.dirname, "src/main/sandbox-runner.ts"),
				},
			},
		},
	},
	preload: {
		build: {
			rolldownOptions: {
				input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
				// 沙箱里的预加载脚本只能是 CommonJS。
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
	renderer: {
		root: resolve(import.meta.dirname, "src/renderer"),
		build: {
			rolldownOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
		},
		plugins: [react(), tailwindcss(), katexWoff2Only()],
	},
});
