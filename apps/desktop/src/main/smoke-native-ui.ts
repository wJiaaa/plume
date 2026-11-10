import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { runPluginCli } from "./smoke-plugin-cli.ts";
import { clickReal as clickRealIn } from "./smoke-kit.ts";

const FORM = `<Card title="原生界面验证">
  <Input name="name" label="姓名" value="Ada"/>
  <Slider name="amount" label="完成量" min={0} max={100} step={1} value={34} unit=" 件"/>
  <Tabs name="view"><Tab title="概览"><Progress label="进度" value={amount}/><Row><Each of={["原料就绪","等待烧制"]}><Badge tone="ok">{item}</Badge></Each></Row></Tab><Tab title="说明"><Callout title="操作说明" tone="info"><Text>调整滑杆后确认当前值。</Text></Callout><Divider/></Tab></Tabs>
  <Tabs><Tab title="本地一"><Text>本地第一页</Text></Tab><Tab title="本地二"><Text>本地第二页</Text></Tab></Tabs>
  <Stat label="当前姓名" value={name}/>
  <Button send="选择 {name}" primary>发送选择</Button>
</Card>`;
const fence = (language: string, code: string) => `\x60\x60\x60${language}\n${code}\n\x60\x60\x60`;
const REPLY = [
	fence("ui", FORM),
	fence("ui", '<Table columns={["方案","价格"]} rows={[["基础",29],["专业",99]]}/>'),
	fence("ui", '<Chart kind="bar" data={[{month:"一月",value:12},{month:"二月",value:20}]} x="month" y="value"/>'),
	fence(
		"ui",
		'<Chart kind="area" data={[{month:"一月",value:12,target:16},{month:"二月",value:-4,target:13},{month:"三月",value:27,target:20}]} x="month" y={["value","target"]}/>',
	),
	fence("ui", '<Chart kind="pie" data={[{name:"杯",value:13},{name:"碗",value:21},{name:"盘",value:8}]} x="name" y="value" unit=" 件"/>'),
	fence("ui", '<UnknownWidget title="不能静默丢弃"/>'),
	fence("broken-test", "render-error-fallback"),
].join("\n\n");

/** 真 Electron 中验证注册、流式、回退和用户回传；数据、测试插件只写进本次冒烟目录。 */
export async function checkNativeUi(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; pluginsDir: string; installDir: string };
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, plugin, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const end = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > end) throw new Error(`原生界面验证等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const open = async (id: string, text: string) => {
		window.webContents.send("plume:command", `open-session:${id}`);
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(text)}) === true`, text);
	};
	const create = async (prompt: string) => {
		const previous = new Set((await agent.sessions()).map((item) => item.id));
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建验证对话");
		await page(`document.querySelector('.cm-content').focus()`);
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
		await window.webContents.insertText(prompt);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送问题");
		await page(`document.querySelector('[data-composer-send=send]').click()`);
		await wait(async () => (await agent.sessions()).some((item) => !previous.has(item.id)), "新会话已创建");
		return (await agent.sessions()).find((item) => !previous.has(item.id))!;
	};
	const enabled = async (on: boolean, sessionId: string) => {
		// 插件的开关在插件市场的详情页里：回到工作区，从侧栏进市场，详情开着时先回网格，再点这个插件的卡片。
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-nav=market]') !== null`, "回到工作区");
		await page(`document.querySelector('[data-nav=market]').click()`);
		await page(`document.querySelector('nav[aria-label="扩展"] button')?.click()`);
		await until(`document.querySelector('[data-card="native-ui"] > button') !== null`, "市场列出原生界面插件");
		await page(`document.querySelector('[data-card="native-ui"] > button').click()`);
		const toggle = '[data-plugin-detail="native-ui"] [role=switch]';
		await until(`document.querySelector(${JSON.stringify(toggle)}) !== null`, "找到插件开关");
		await page(`document.querySelector(${JSON.stringify(toggle)}).click()`);
		await wait(
			async () => (await agent.plugins()).some((item) => item.name === "plume.native-ui" && item.state === (on ? "active" : "disabled")),
			"插件状态已更新",
		);
		await open(sessionId, "原生界面验证");
	};
	const capture = async (name: string, selector = "[data-screen=chat] [data-native-ui]") => {
		await page(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' })`);
		await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
		await page(
			`Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))`,
		);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	// 窗口刚改过尺寸、转录还在跟着重排时，算好的落点可能已经不在按钮上：经共用的 clickReal 点，点空了会再点。
	const clickReal = (selector: string) => clickRealIn(window, selector, `原生界面验证：${selector}`);
	assert.ok(plugin.cli);
	await runPluginCli(plugin.cli, ["install", join(plugin.pluginsDir, "native-ui"), "--to", plugin.installDir]);
	await wait(async () => (await agent.plugins()).some((item) => item.name === "plume.native-ui" && item.state === "active"), "插件启用");

	const probeDir = join(outDir, "ui-probe");
	await mkdir(join(probeDir, "dist"), { recursive: true });
	await writeFile(
		join(probeDir, "package.json"),
		JSON.stringify({ name: "ui-probe", version: "0.1.0", type: "module", plume: { displayName: "UI probe", category: "Testing" } }),
	);
	await writeFile(join(probeDir, "dist/index.mjs"), 'export default { name: "example.ui-probe", apply() {} };');
	await writeFile(
		join(probeDir, "dist/ui.mjs"),
		'export default { name: "example.ui-probe", apply(ui) { ui.codeBlock("broken-test", () => { throw new Error("intentional render failure"); }); } };',
	);
	await runPluginCli(plugin.cli, ["install", probeDir, "--to", plugin.installDir]);
	await wait(async () => (await agent.plugins()).some((item) => item.name === "example.ui-probe" && item.state === "active"), "故障渲染器启用");

	const requests: Record<string, unknown>[] = [];
	let mode: "normal" | "stream" = "normal";
	setModel((request) => {
		requests.push(request);
		if (mode === "stream") return { text: `\x60\x60\x60ui\n${FORM}\n<Chart data={[{month:"一月",value:`, hang: true };
		const messages = JSON.stringify(request.messages);
		return { text: messages.includes("选择 Grace") ? "收到 Grace 的选择。" : REPLY };
	});
	try {
		const source = await create(`展示原生界面验证\n\n${fence("ui", '<Button send="should-not-send">用户材料</Button>')}`);
		await wait(async () => (await agent.sessions()).some((item) => item.id === source.id && !item.running), "回复完成");
		await open(source.id, "原生界面验证");
		const form = "[data-screen=chat] [data-native-ui]";
		await until(
			`document.querySelector('[data-screen=chat] [data-native-ui=ready] input') !== null && document.querySelector('${form} [data-native-ui-send=true]')?.disabled === false`,
			"卡片和完整表单可交互",
		);
		assert.ok(JSON.stringify(requests[0]?.system).includes("ui"), "模型能发现 UI 用法");
		assert.equal(await page<boolean>(`document.querySelector('[data-plume-quote=user] [data-native-ui]') !== null`), false, "用户引用的 UI 代码不交给插件");
		await until(`document.querySelector('${form} table') !== null || document.querySelector('[data-screen=chat] [data-native-ui] table') !== null`, "表格渲染");
		await until(`document.querySelector('[data-screen=chat] [data-native-ui] svg') !== null`, "图表渲染");
		await until(`[...document.querySelectorAll('[data-screen=chat] pre')].some(e => e.textContent.includes('UnknownWidget'))`, "不支持的组件回到源码");
		await until(`[...document.querySelectorAll('[data-screen=chat] pre')].some(e => e.textContent.includes('render-error-fallback'))`, "渲染异常回到源码");
		await page(
			`(() => { const input = document.querySelector('${form} input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Grace'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
		);
		await until(`document.querySelector('${form}').textContent.includes('Grace')`, "表单值驱动展示");
		await clickReal('[data-native-ui-field="amount"] input');
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Home" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Home" });
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
		await until(`document.querySelector('[data-native-ui-field="amount"] input').value === '1'`, "滑杆键盘操作");
		await until(`document.querySelector('[role=progressbar]').getAttribute('aria-valuenow') === '1'`, "进度读取滑杆值");
		assert.equal(await page<number>(`document.querySelectorAll('.native-ui-badge').length`), 2, "Each 生成徽章");
		await clickReal('[data-native-ui-tabs="view"] [data-tab="说明"]');
		await clickReal('[data-tab="本地二"]');
		await until(
			`document.querySelector('.native-ui-callout') !== null && document.querySelector('${form}').textContent.includes('本地第二页')`,
			"命名和未命名页签切换",
		);
		const other = await create("隔离状态验证");
		await wait(async () => (await agent.sessions()).some((item) => item.id === other.id && !item.running), "另一个会话完成");
		await until(`document.querySelector('${form} input')?.value === 'Ada'`, "会话状态隔离");
		await open(source.id, "原生界面验证");
		await until(
			`document.querySelector('${form} input')?.value === 'Grace' && document.querySelector('[data-tab="本地二"]').getAttribute('aria-selected') === 'true'`,
			"卸载后恢复值与本地页签",
		);
		assert.equal(await page<string>(`document.querySelector('[data-native-ui-tabs="view"] [aria-selected=true]').textContent`), "说明");
		await page(
			`window.__nativeClipboardWrite = navigator.clipboard.writeText; navigator.clipboard.writeText = async text => { window.__nativeCopied = text; }; void 0;`,
		);
		await clickReal('[data-plume-quote="assistant"] button[aria-label="复制这条消息"]');
		await until(`typeof window.__nativeCopied === 'string'`, "复制回复");
		const copied = await page<string>(`window.__nativeCopied`);
		assert.ok(
			copied.includes("姓名: Grace") && copied.includes("完成量: 1 件") && copied.includes("本地第一页") && copied.includes("本地第二页"),
			"副本含当前值和全部页签",
		);
		assert.ok(copied.includes("| 杯 | 13 |") && !copied.includes("<Slider"), "图表转表格且不复制声明源码");
		assert.ok(copied.includes("UnknownWidget"), "无效块复制仍保留源码");
		await page(`navigator.clipboard.writeText = window.__nativeClipboardWrite; delete window.__nativeClipboardWrite; delete window.__nativeCopied;`);
		await page(`window.plume.saveAppearance({ theme: 'light' })`);
		await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "浅色主题");
		await capture("smoke-native-ui-light.png");
		await capture("smoke-native-ui-chart-light.png", "[data-native-ui-chart]");
		await capture("smoke-native-ui-area-light.png", '[data-native-ui-chart="area"]');
		await capture("smoke-native-ui-pie-light.png", '[data-native-ui-chart="pie"]');
		await page(`window.plume.saveAppearance({ theme: 'dark' })`);
		await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "深色主题");
		await capture("smoke-native-ui-dark.png");
		await capture("smoke-native-ui-chart-dark.png", "[data-native-ui-chart]");
		await capture("smoke-native-ui-area-dark.png", '[data-native-ui-chart="area"]');
		await capture("smoke-native-ui-pie-dark.png", '[data-native-ui-chart="pie"]');
		const size = window.getSize();
		window.setSize(600, size[1]!);
		await until(
			`innerWidth === 600 && [...document.querySelectorAll('[data-native-ui-chart] svg')].every(e => e.getBoundingClientRect().right <= innerWidth)`,
			"窄窗口图表自适应",
		);
		assert.ok(await page<boolean>(`[...document.querySelectorAll('${form}')].every(e => e.getBoundingClientRect().right <= innerWidth)`), "窄窗口不溢出");
		await capture("smoke-native-ui-compact.png");
		await capture("smoke-native-ui-chart-compact.png", "[data-native-ui-chart]");
		await capture("smoke-native-ui-pie-compact.png", '[data-native-ui-chart="pie"]');
		window.setSize(size[0]!, size[1]!);
		await until(`innerWidth === ${size[0]}`, "恢复窗口");

		// DOM.click 是程序事件，不能替用户发送。
		await page(`document.querySelector('${form} [data-native-ui-send=true]').click()`);
		await until(`document.querySelector('${form} [data-native-ui-error]') !== null`, "程序点击被拒绝");
		assert.equal(await page<number>(`document.querySelectorAll('[data-screen=chat] [data-plume-quote=user]').length`), 1);
		await clickReal(`${form} [data-native-ui-send=true]`);
		await until(
			`[...document.querySelectorAll('[data-screen=chat] [data-plume-quote=user]')].some(e => e.textContent.includes('选择 Grace'))`,
			"点击发送回原会话",
		);
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('收到 Grace 的选择。')`, "模型收到表单回答");
		assert.ok(JSON.stringify(requests.at(-1)?.messages).includes("Grace"));
		assert.ok(JSON.stringify(requests.at(-1)?.messages).includes("unknown component UnknownWidget"), "下一次模型请求收到诊断");
		assert.ok(
			!(await page<boolean>(`document.querySelector('[data-screen=chat]').textContent.includes('unknown component UnknownWidget')`)),
			"诊断不显示在转录",
		);

		await enabled(false, source.id);
		await until(
			`document.querySelector('${form}') === null && [...document.querySelectorAll('[data-screen=chat] pre')].some(e => e.textContent.includes('Card title'))`,
			"停用回到源码",
		);
		await enabled(true, source.id);
		await until(`document.querySelector('${form} input') !== null`, "重新启用恢复渲染");
		await until(
			`document.querySelector('${form} [data-native-ui-sent]') !== null && document.querySelector('${form} input').value === 'Grace'`,
			"重载插件后恢复回执与表单",
		);
		assert.equal(await page<boolean>(`document.querySelector('${form} [data-native-ui-send=true]') !== null`), false, "已发送不能重复提交");
		const reloaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
		window.webContents.reload();
		await reloaded;
		await until(`document.querySelector('[data-screen]') !== null`, "重新载入界面");
		await open(source.id, "原生界面验证");
		await until(
			`document.querySelector('${form} [data-native-ui-sent]') !== null && document.querySelector('${form} input').value === 'Grace'`,
			"刷新后从存储恢复值与回执",
		);
		assert.equal(await page<string>(`document.querySelector('[data-native-ui-field="amount"] input').value`), "1");
		await clickReal('[data-native-ui-tabs="view"] [data-tab="概览"]');
		await page(`window.plume.saveAppearance({ theme: 'light' })`);
		await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "进度与徽章浅色主题");
		await capture("smoke-native-ui-progress-light.png");

		mode = "stream";
		const streaming = await create("写到一半");
		await until(`document.querySelector('[data-composer-send=stop]') !== null`, "未完成流式消息");
		await open(streaming.id, "写到一半");
		await until(`document.querySelector('${form} [data-native-ui-pending=Chart]') !== null`, "流式图表占位可见");
		assert.ok(await page<boolean>(`document.querySelector('${form} [data-native-ui-pending] span').getAnimations().length > 0`), "生成占位扫光在运行");
		await capture("smoke-native-ui-writing.png", "[data-native-ui-pending]");
		assert.ok(
			await page<boolean>(
				`(() => { const block = document.querySelector('${form}'); const button = block.querySelector('button'); return block.inert || !!block.querySelector('[inert]') || !button || button.disabled; })()`,
			),
			"流式表单不能提交",
		);
		await page(`document.querySelector('[data-composer-send=stop]').click()`);
		await wait(async () => (await agent.sessions()).some((item) => item.id === streaming.id && !item.running), "中断流式");
		await until(
			`!document.querySelector('${form} button') || document.querySelector('${form} button').disabled || document.querySelector('${form}').inert`,
			"中断后仍不可提交",
		);
		console.log(
			"PLUME_NATIVE_UI_SMOKE",
			JSON.stringify({
				ok: true,
				rendering: ["card", "table", "chart", "form"],
				fallback: ["parse", "render", "disabled"],
				realClick: true,
				streaming: true,
				themes: ["light", "dark"],
				compact: true,
				persistence: ["session-switch", "plugin-reload", "window-reload"],
				copyValues: true,
				diagnostics: true,
			}),
		);
	} finally {
		await page(
			`if (window.__nativeClipboardWrite) { navigator.clipboard.writeText = window.__nativeClipboardWrite; delete window.__nativeClipboardWrite; } delete window.__nativeCopied;`,
		);
		await page(`document.querySelector('[data-composer-send=stop]')?.click()`);
		setModel(undefined);
		await page(`window.plume.saveAppearance({ theme: 'light' })`);
	}
}
