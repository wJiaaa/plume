/**
 * 装着全部内置插件的默认会话，第一次请求发给模型的系统提示词和工具表，和 `__snapshots__/default-request.txt` 逐字对照。
 *
 * 钉住的是「发给模型的文字没有被顺手改掉」：内置插件之间不点名、改成按声明在工具表里现查名字以后，默认情况下查到的就是原来写死的那个，
 * 发出去的字一个都不该变。有意改提示词、工具说明时，看一眼差异，再用 `pnpm --filter @plume/agent exec vitest run default-request -u` 更新。
 *
 * 工具表的顺序由宿主按固定规则排（见 `host.ts` 的 `compareTools`），和插件的加载先后、依赖声明无关：倒着装一遍内置插件，工具表一个都不挪。
 *
 * 内置插件按应用的加载顺序（`packages/builtin/` 下的目录名排序）全部装上。随机器变的部分换成占位：临时目录、会话 id、平台和 shell 那两行，
 * 以及只在 Windows 上才有的 shell 写法（它们跟着平台变，不跟着插件变）。家目录指到一个空的临时目录，本机装的技能不会混进来。
 */

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Plugin, PluginEntry } from "@plume/contract";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, fakeAnthropic } from "../src/testing.ts";

const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../builtin");

let dir: string;
let model: FakeModel;
let agent: Agent;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-default-request-"));
	await mkdir(join(dir, "home"));
	await mkdir(join(dir, "workspace"));
	process.env.HOME = join(dir, "home");
	process.env.USERPROFILE = join(dir, "home");
});

afterAll(async () => {
	await agent?.shutdown();
	await model?.close();
	process.env.HOME = saved.HOME;
	process.env.USERPROFILE = saved.USERPROFILE;
	await rm(dir, { recursive: true, force: true });
});

async function builtins(): Promise<PluginEntry[]> {
	const names = (await readdir(BUILTIN_DIR)).sort().filter((name) => existsSync(join(BUILTIN_DIR, name, "src/index.ts")));
	return Promise.all(
		names.map(async (name) => {
			const plugin = ((await import(join(BUILTIN_DIR, name, "src/index.ts"))) as { default: Plugin }).default;
			return { key: name, builtin: true, load: async () => plugin };
		}),
	);
}

/** 随机器变的换成占位，见文件头。 */
function normalize(text: string): string {
	return text
		.replaceAll(dir.replace(/\\/g, "/"), "<tmp>")
		.replaceAll(dir, "<tmp>")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
		.replace(/^- Platform: .*$/m, "- Platform: <platform>")
		.replace(/^- Shell: .*$/m, "- Shell: <shell>")
		.replace(/^- Commands run in .*$/gm, "");
}

it("默认会话发给模型的系统提示词和工具表和基准逐字相同", async () => {
	model = await fakeAnthropic([{ text: "好" }]);
	agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "model.json"), plugins: await builtins(), log: () => undefined });
	const service = agent.service;
	const providerId = await service.saveProvider({
		id: "",
		name: "假模型",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		models: [
			{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: false, supportsTools: true },
		],
		apiKey: "test-key",
	});
	await service.setDefaultModel(`${providerId}/fake`);
	const session = await service.createSession({ cwd: join(dir, "workspace") });
	service.send(session.id, { content: [{ type: "text", text: "你好" }] });
	const deadline = Date.now() + 20_000;
	const first = () => model.requests.find((request) => JSON.stringify(request.system ?? "").includes("You are Plume"));
	while (!first() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	const request = first();
	expect(request).toBeDefined();
	const system = (request!.system as Array<{ text: string }>).map((block) => block.text).join("\n\n");
	const tools = (request!.tools as Array<{ name: string; description: string; input_schema: unknown }>).map(
		(tool) => `## ${tool.name}\n\n${tool.description}\n\n${JSON.stringify(tool.input_schema)}`,
	);
	await expect(normalize(`# system\n\n${system}\n\n# tools\n\n${tools.join("\n\n")}\n`)).toMatchFileSnapshot("__snapshots__/default-request.txt");
}, 30_000);

it("倒着装一遍内置插件（加载先后、等服务的先后都变了），工具表的顺序不变", async () => {
	const names = async (entries: PluginEntry[], name: string) => {
		const other = await createAgent({ dataDir: join(dir, name), settingsFile: join(dir, `${name}.json`), plugins: entries, log: () => undefined });
		try {
			return (await other.service.listTools()).map((tool) => tool.name);
		} finally {
			await other.shutdown();
		}
	};
	const forward = await builtins();
	const listed = await names(forward, "forward");
	expect(listed.length).toBeGreaterThan(10);
	expect(await names([...forward].reverse(), "reversed")).toEqual(listed);
}, 30_000);
