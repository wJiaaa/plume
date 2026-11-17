import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginProvider } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { plumeHome } from "./home.ts";
import { clickVisible, waitFor } from "./smoke-kit.ts";
import { runPluginCli } from "./smoke-plugin-cli.ts";

const PROBE = "example.provider-probe";
const PROVIDER = "probe-gw";

/**
 * 插件提供的模型供应商（`ctx.providers.provide`），经测试插件「供应商探针」（packages/testing/provider-probe）走一遍真界面：
 * 先在它的数据目录里放好一个供应商，构建、装上它；设置 › 模型里列出这个供应商、标着由它提供，改地址、协议和模型都写回它的文件、
 * 不进 settings.json，重新载入后还在；开关停用再启用；设置页开着时卸下、重新加载探针，列表不重新载入就跟着变；最后删掉，它的文件里也没了。
 */
export async function checkProviders(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; builtinDir: string; uploadDir: string };
	outDir: string;
	modelUrl: string;
}): Promise<void> {
	const { window, agent, plugin, outDir, modelUrl } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const until = (code: string, label: string) => waitFor(async () => Boolean(await page(code)), `插件供应商：${label}`);
	const click = (selector: string, text?: string) => clickVisible(page, selector, text);
	const type = (selector: string, value: string) =>
		page(`(() => {
			const input = document.querySelector(${JSON.stringify(selector)});
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
			input.dispatchEvent(new Event('input', { bubbles: true }));
		})()`);
	const capture = async (name: string) => {
		await page(`new Promise(resolve => setTimeout(resolve, 500))`);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};

	// 1. 探针启用时读一次数据目录里的供应商，所以先放好再装。价格是 Magpie 那种按 token 的字符串：本体不认，按模型目录补。
	const dataDir = join(plumeHome(), "plugin-data", PROBE);
	const dataFile = join(dataDir, "providers.json");
	const seeded: PluginProvider[] = [
		{
			id: PROVIDER,
			name: "探针网关",
			api: "openai-responses",
			baseUrl: modelUrl,
			enabled: true,
			apiKey: "probe-smoke-key",
			models: [
				{
					modelId: "probe-model",
					name: "probe-model",
					contextWindow: 200_000,
					maxOutputTokens: 32_000,
					supportsThinking: false,
					supportsImages: false,
					supportsTools: true,
					pricing: { prompt: "0.000003", completion: "0.000015" } as never,
				},
			],
		},
	];
	await mkdir(dataDir, { recursive: true });
	await writeFile(dataFile, JSON.stringify(seeded), { mode: 0o600 });
	const stored = async () => JSON.parse(await readFile(dataFile, "utf8")) as PluginProvider[];

	if (!plugin.cli) throw new Error("没有生成 plume-plugin 启动脚本");
	const dir = join(outDir, "provider-probe");
	const source = join(plugin.builtinDir, "../testing/provider-probe");
	await Promise.all(["src", "package.json", "README.md"].map((name) => cp(join(source, name), join(dir, name), { recursive: true })));
	await runPluginCli(plugin.cli, ["build", dir]);
	await runPluginCli(plugin.cli, ["install", dir, "--to", plugin.uploadDir]);
	await waitFor(async () => (await agent.plugins()).some((status) => status.name === PROBE && status.state === "active"), "供应商探针已启用");

	// 2. 设置 › 模型里列出它，标着由探针提供；所有修改都真点界面。
	const editor = `[data-provider-editor="${PROVIDER}"]`;
	const openModels = async () => {
		window.webContents.reload();
		await until(`document.querySelector('[data-screen=empty]') !== null`, "重新载入");
		window.webContents.send("plume:command", "settings");
		await click('[aria-label="设置章节"] button', "模型设置");
		await click(`[data-provider-item="${PROVIDER}"]`);
		await until(`document.querySelector('${editor}') !== null`, "打开探针的供应商");
	};
	await openModels();
	await until(`document.querySelector('${editor} [data-provider-managed]')?.textContent.includes('供应商探针') === true`, "标着由供应商探针提供");
	await until(`document.querySelector('[data-provider-url]')?.disabled === false && document.querySelector('[data-add-model]') !== null`, "编辑入口没有锁住");

	await type("[data-provider-url]", `${modelUrl}/v1`);
	await waitFor(async () => (await stored())[0]?.baseUrl === `${modelUrl}/v1`, "地址修改写回探针的文件");
	await click("[data-provider-connection] [data-segmented] button", "Messages");
	await waitFor(async () => (await stored())[0]?.api === "anthropic-messages", "协议修改写回探针的文件");
	await click('[data-model-row="probe-model"]');
	await type("[data-model-editor-id]", "probe-edited");
	await type('[data-model-editor] input[inputmode="numeric"]', "500000");
	await click("[data-model-editor-save]");
	await until(`document.querySelector('[data-model-row="probe-edited"]') !== null`, "模型修改已保存");
	await waitFor(async () => {
		const [saved] = await stored();
		return saved?.apiKey === "probe-smoke-key" && saved.models[0]?.modelId === "probe-edited" && saved.models[0]?.contextWindow === 500_000;
	}, "模型修改写回探针的文件，key 留着");
	const settings = await readFile(join(plumeHome(), "settings.json"), "utf8").catch(() => "");
	if (settings.includes(PROVIDER) || settings.includes("probe-smoke-key")) throw new Error("插件的供应商写进了 settings.json");

	await openModels();
	await until(`document.querySelector('[data-model-row="probe-edited"]') !== null`, "重新载入后修改仍保留");
	await capture("smoke-plugin-provider.png");

	const providerSwitch = `${editor} [role=switch]`;
	await click(providerSwitch);
	await waitFor(async () => (await stored())[0]?.enabled === false, "停用写回探针的文件");
	await click(providerSwitch);
	await waitFor(async () => (await stored())[0]?.enabled === true, "重新启用写回探针的文件");

	// 设置页开着、不重新载入：卸下探针（插件市场停用、更新时走的同一条路），它的供应商从列表里消失；再加载又回来
	// （本体发 `models` 事件，界面自己重取）。
	const probeKey = (await agent.plugins()).find((status) => status.name === PROBE)?.key;
	if (!probeKey) throw new Error("插件列表里没有供应商探针");
	await agent.removePlugin(probeKey);
	await until(`!document.querySelector('[data-provider-item="${PROVIDER}"]')`, "卸下探针后它的供应商当场消失");
	await agent.addPlugin({ key: probeKey, dir: join(plugin.uploadDir, probeKey) });
	await until(`document.querySelector('[data-provider-item="${PROVIDER}"]') !== null`, "重新加载探针后它的供应商当场回来");
	await click(`[data-provider-item="${PROVIDER}"]`);
	await until(`document.querySelector('${editor}') !== null`, "再打开探针的供应商");

	await click("[data-provider-delete]");
	await click("button", "删除");
	await until(`!document.querySelector('[data-provider-item="${PROVIDER}"]')`, "删掉探针的供应商");
	if ((await stored()).length !== 0) throw new Error("删掉以后探针的文件里还有这个供应商");
}
