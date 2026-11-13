import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { nativeTheme, type BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { plumeHome } from "./home.ts";
import { clickVisible, clickVisibleIn } from "./smoke-kit.ts";

/** 只用本次冒烟数据目录；通过真实界面选肤、复制、AI工具应用和停用恢复。 */
export async function checkSkinStudio(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; install(name: string): Promise<void>; installDir: string };
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, plugin, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const deadline = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error(`换肤验证等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const click = (selector: string) => clickVisible(page, selector);
	/** `scope` 里文字或无障碍名是 `label` 的按钮。 */
	const button = (label: string, scope = "") =>
		clickVisibleIn(
			page,
			`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter(e => e.textContent.trim() === ${JSON.stringify(label)} || e.getAttribute('aria-label') === ${JSON.stringify(label)})`,
			`${scope} 里的按钮「${label}」`,
		);
	const type = (selector: string, value: string) =>
		page(`(() => {
		const input = document.querySelector(${JSON.stringify(selector)});
		const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)});
		input.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	const capture = async (name: string) => {
		await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
		await page(
			`Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))`,
		);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const token = (name: string) => page<string>(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(`--plume-${name}`)}).trim()`);
	const library = async () =>
		JSON.parse(await readFile(join(plumeHome(), "plugin-data/plume.skin-studio/skins.json"), "utf8")) as {
			activeId: string | null;
			custom: Array<{ id: string; name: string; base: string; colors: Record<string, string> }>;
		};
	const settings = async (section: string) => {
		window.webContents.send("plume:command", "settings");
		await until(`document.querySelector('[aria-label=设置章节]') !== null`, "设置打开");
		await button(section, "[aria-label=设置章节]");
	};
	// 插件的开关在插件市场的详情页里：回到工作区，从侧栏进市场，详情开着时先回网格，再点工坊那张卡片。
	const studioSwitch = '[data-plugin-detail="skin-studio"] [role=switch]';
	/**
	 * 点工坊的开关，把它拨到 `on`。开关的状态取自界面的市场缓存，要等 agent 发来插件变化才更新，比 `agent.plugins()` 慢一拍：
	 * 上一次拨动刚在 agent 那边生效就接着点，开关还显示旧状态，这一下又按旧方向拨一次。所以先等界面上它确实在另一边再点。
	 */
	const toggleStudio = async (on: boolean) => {
		await until(
			`document.querySelector(${JSON.stringify(studioSwitch)})?.getAttribute('aria-checked') === '${!on}'`,
			on ? "工坊开关显示未启用" : "工坊开关显示已启用",
		);
		await click(studioSwitch);
	};
	const openStudioDetail = async () => {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-nav=market]') !== null`, "回到工作区");
		await clickVisible(page, `[data-nav=market]`);
		if (await page<boolean>(`document.querySelector('nav[aria-label="插件市场"] button') !== null`))
			await clickVisible(page, `nav[aria-label="插件市场"] button`);
		await until(`document.querySelector('[data-card="skin-studio"] > button') !== null`, "市场列出换肤工坊");
		await clickVisible(page, `[data-card="skin-studio"] > button`);
		await until(`document.querySelector(${JSON.stringify(studioSwitch)}) !== null`, "工坊详情有开关");
	};
	// 拨完开关回工作区：换肤工坊的入口在输入框上，市场页里没有。
	const leaveMarket = async () => {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "从市场回到工作区");
	};

	window.webContents.send("plume:command", "new-session");
	await until(`document.querySelector('[data-screen=empty]') !== null`, "空白对话");
	await page(`window.plume.saveAppearance({ theme: 'light', lightForeground: '#263748', accent: '#336699' })`);
	await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "原偏好为浅色");
	await wait(async () => (await readFile(join(plumeHome(), "appearance.json"), "utf8")).includes("#263748"), "原偏好已落盘");
	const before = await readFile(join(plumeHome(), "appearance.json"), "utf8");
	const originalInk = await token("ink");
	assert.ok(plugin.cli);
	await plugin.install("skin-studio");
	await wait(async () => (await agent.plugins()).some((item) => item.name === "plume.skin-studio" && item.state === "active"), "工坊安装");
	await button("换肤工坊", ".plume-composer");
	// 浅色、深色各挑一套：会话窗底色、字色、强调色和深浅模式都换过来。侧栏底色（root）新旧两版插件不同，冒烟装的是线上那版，不断言。
	for (const [id, base, bg, ink, accent] of [
		["light-peach", "light", "#FFF8F6", "#3A1F1D", "#E0527A"],
		["dark-teal", "dark", "#0F2124", "#EAF5F4", "#0D9488"],
	] as const) {
		const selector = `[data-skin-id="${id}"] .skin-studio-choice`;
		await click(selector);
		await until(`getComputedStyle(document.documentElement).getPropertyValue('--plume-ink').trim().toUpperCase() === '${ink}'`, "皮肤字色应用");
		await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${base === "dark"}`, "皮肤深浅模式应用");
		assert.equal((await token("bg")).toUpperCase(), bg);
		assert.equal((await token("accent")).toUpperCase(), accent);
		assert.equal((await library()).activeId, id);
		await page(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
		await capture(`smoke-skin-preset-${base}.png`);
	}
	await page(`document.querySelector('[data-skin-default]').scrollIntoView({ block: 'center' })`);
	// 「系统外观」三个按钮就是外观页的主题卡片：撤下工坊皮肤，改存下的主题偏好；配色照用户自己的，外圈照常是窗口材质。
	for (const [mode, label] of [
		["light", "浅色"],
		["dark", "深色"],
		["system", "跟随系统"],
	] as const) {
		await button(label, "[data-skin-default]");
		await wait(
			async () =>
				nativeTheme.themeSource === mode &&
				(await library()).activeId === null &&
				JSON.parse(await readFile(join(plumeHome(), "appearance.json"), "utf8")).theme === mode,
			"主题偏好改成所选并撤下工坊皮肤",
		);
		const dark = nativeTheme.shouldUseDarkColors;
		await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${dark}`, "页面响应原生主题");
		await until(`document.querySelector('[data-skin-default] button[aria-pressed=true]')?.textContent.trim() === ${JSON.stringify(label)}`, "工坊亮所选主题");
		assert.equal((await token("bg")).toUpperCase(), dark ? "#171717" : "#F8F8F8");
		assert.equal((await token("fg")).toUpperCase(), dark ? "#D4D4D4" : "#263748");
		assert.equal((await token("accent")).toUpperCase(), "#336699");
		assert.equal(await page<string>(`document.querySelector('[data-plume-head-fill]').dataset.plumeHeadFill`), "window");
		await capture(`smoke-skin-default-${mode}.png`);
	}
	// 选回原来的浅色：偏好文件和开始时一字不差，配色没被动过。
	await button("浅色", "[data-skin-default]");
	await wait(async () => (await readFile(join(plumeHome(), "appearance.json"), "utf8")) === before, "选回浅色后偏好与原来一致");
	await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "回到用户的浅色");
	await wait(async () => (await token("ink")) === originalInk, "恢复用户字色");
	await page(`document.querySelector('[data-skin-id="light-peach"]').scrollIntoView({ block: 'center' })`);
	await click('[data-skin-id="light-peach"] .skin-studio-choice');
	await until(`getComputedStyle(document.documentElement).getPropertyValue('--plume-ink').trim().toUpperCase() === '#3A1F1D'`, "蜜桃配色应用");
	await capture("smoke-skin-peach.png");
	await click('[data-skin-id="light-mint"] .skin-studio-choice');
	await until(`getComputedStyle(document.documentElement).getPropertyValue('--plume-ink').trim().toUpperCase() === '#173226'`, "浅色字色应用");
	await capture("smoke-skin-light.png");
	await click('[data-skin-id="dark-berry"] .skin-studio-choice');
	await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "深色皮肤切换系统材质");
	assert.equal((await token("ink")).toUpperCase(), "#F6EEF2");
	assert.equal((await token("ink-muted")).toUpperCase(), "#C39CAE");
	assert.equal((await token("accent-dim")).toUpperCase(), "#3D1530");
	assert.ok(
		await page<boolean>(`(() => {
		const sidebar = document.querySelector('aside[aria-label="侧边栏"]');
		return sidebar && getComputedStyle(sidebar).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(sidebar).backgroundImage === 'none';
	})()`),
		"停靠侧栏透明，和窗口外圈共用底层，不产生色差接缝",
	);
	await capture("smoke-skin-dark.png");
	await button("保存当前皮肤");
	await type("[role=dialog] input", "冒烟莓果");
	await button("保存副本", "[role=dialog]");
	await until(`document.querySelector('[role=dialog]') === null`, "保存完成");
	const saved = (await library()).custom.find((skin) => skin.name === "冒烟莓果");
	assert.ok(saved);
	await settings("外观");
	await until(`document.querySelector('[data-managed-skin]') !== null`, "外观页显示只读皮肤");
	assert.ok(await page<boolean>(`document.querySelector('[data-managed-skin]').textContent.includes('冒烟莓果')`));
	assert.ok(
		await page<boolean>(
			`(() => { const field = document.querySelector('[data-plume-number=uiFontSize] input'); return field && !field.disabled && !field.readOnly; })()`,
		),
		"字体偏好仍可编辑",
	);
	await capture("smoke-skin-appearance.png");
	await button("返回工作区");
	// 剪贴板出口留在本次测试窗口内，避免覆盖用户正在使用的系统剪贴板。
	await page(
		`window.__skinClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = async value => { window.__skinCopied = value; }; void 0;`,
	);
	try {
		await click(`[data-skin-id="${saved.id}"] button[aria-label^="复制"]`);
		await until(`typeof window.__skinCopied === 'string'`, "复制 JSON");
		const exported = await page<string>(`window.__skinCopied`);
		assert.deepEqual(Object.keys(JSON.parse(exported)).sort(), ["base", "colors", "name"]);
		await button("导入别人分享的皮肤");
		await type('[name="skin-json"]', "{invalid");
		await until(`document.querySelector('[role=dialog] [role=alert]') !== null`, "错误 JSON 保留在弹窗");
		assert.equal((await library()).activeId, saved.id);
		await type('[name="skin-json"]', JSON.stringify({ ...JSON.parse(exported), name: "导入莓果" }));
		await button("导入并应用", "[role=dialog]");
		await until(`!document.querySelector('[role=dialog]')`, "导入完成");
		const imported = (await library()).custom.find((skin) => skin.name === "导入莓果");
		assert.ok(imported);
		await click(`[data-skin-id="${imported.id}"] button[aria-label^="删除"]`);
		await button("删除作品", "[role=dialog]");
		await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "删除正在使用的皮肤恢复原偏好");
		await click(`[data-skin-id="${saved.id}"] .skin-studio-choice`);
		await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "重新应用保存的皮肤");
	} finally {
		await page(`navigator.clipboard.writeText = window.__skinClipboardWrite; delete window.__skinClipboardWrite; delete window.__skinCopied;`);
	}

	const size = window.getSize();
	window.setSize(520, 540);
	await until(`innerWidth <= 520`, "窄窗口");
	await capture("smoke-skin-compact.png");
	assert.ok(
		await page<boolean>(`(() => { const el = document.querySelector('[data-skin-studio]'); return el && el.scrollWidth <= el.clientWidth + 1; })()`),
		"窄面板不横向溢出",
	);
	window.setSize(size[0]!, size[1]!);
	await until(`innerWidth === ${size[0]} && document.querySelector('.cm-content')?.getBoundingClientRect().width > 0`, "输入框重新可见");
	await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
	await page(`document.querySelector('.cm-content').focus()`);
	await until(`document.activeElement === document.querySelector('.cm-content')`, "输入框获得焦点");
	await window.webContents.insertText("我的偏好：莓果色。");
	await until(`document.querySelector('.cm-content')?.textContent.includes('我的偏好：莓果色。')`, "原草稿输入完成");
	await button("让 AI 设计皮肤");
	await until(`document.querySelector('.cm-content')?.textContent.includes('skin_studio_theme')`, "设计请求进入草稿");
	assert.ok(await page<boolean>(`document.querySelector('.cm-content').textContent.includes('我的偏好：莓果色。')`), "AI设计保留原草稿");
	// 关闭面板后工具仍应立即换色，不依赖画廊是否挂载。
	if (await page<boolean>(`document.querySelector('[data-panel-area] button[aria-label="收起面板"]') !== null`))
		await clickVisible(page, `[data-panel-area] button[aria-label="收起面板"]`);
	let offered = false;
	setModel((request) => {
		offered ||= ((request.tools ?? []) as Array<{ name: string }>).some((tool) => tool.name === "skin_studio_theme");
		return JSON.stringify(request.messages).includes("toolu_skin_studio")
			? { text: "AI 皮肤已应用。" }
			: {
					toolCalls: [
						{ id: "toolu_skin_studio", name: "skin_studio_theme", args: { action: "apply", name: "AI 冒烟皮肤", base: "dark", colors: saved.colors } },
					],
				};
	});
	try {
		await click("[data-composer-send=send]");
		await until(`document.querySelector('[data-approval-card]') !== null`, "AI 换肤经过审批");
		await button("允许一次", "[data-approval-card]");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('AI 皮肤已应用。')`, "AI工具完成");
		assert.ok(offered);
		assert.ok((await library()).custom.some((skin) => skin.name === "AI 冒烟皮肤"));
	} finally {
		setModel(undefined);
	}
	await openStudioDetail();
	await toggleStudio(false);
	await wait(async () => (await agent.plugins()).some((item) => item.name === "plume.skin-studio" && item.state === "disabled"), "停用工坊");
	await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "停用恢复原模式");
	assert.equal(await token("ink"), originalInk);
	assert.equal(await readFile(join(plumeHome(), "appearance.json"), "utf8"), before, "工坊从未覆盖用户偏好");
	await toggleStudio(true);
	await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "重启插件恢复保存的皮肤");
	await leaveMarket();
	await button("换肤工坊", ".plume-composer");
	await button("恢复原外观");
	await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "恢复原外观");
	assert.equal((await library()).activeId, null);

	window.webContents.send("plume:command", "new-session");
	await until(`document.querySelector('[data-screen=empty]') !== null`, "首页背景验证使用新对话");
	await button("换肤工坊", ".plume-composer");
	const appearance = async () => JSON.parse(await readFile(join(plumeHome(), "appearance.json"), "utf8")) as Record<string, unknown>;
	const background = "[data-skin-studio] [data-chat-background-settings]";
	await page(`document.querySelector('${background}').scrollIntoView({ block: 'end' })`);
	await capture("smoke-skin-background-empty.png");
	// 原生选图的冒烟替身读取 smoke.png；专项入口尚未生成这张完整截图。
	await capture("smoke.png");
	// 磨砂是整个窗口的质感，不要图、不看皮肤：打开后外圈和新对话底下、预览里都铺上颗粒，设置落盘；看完关掉，后面选图的步骤照旧。
	await button("磨砂", background);
	await wait(async () => (await appearance()).grain === true, "磨砂设置落盘");
	await until(
		`document.querySelector('[data-screen=empty] > .chat-grain') !== null && document.querySelector('${background} [data-chat-background-drop] > .chat-grain') !== null`,
		"不选图也铺上磨砂",
	);
	for (const selector of ["[data-screen=empty] > .chat-grain", "[data-plume-head-fill]"])
		assert.ok(
			await page<boolean>(`getComputedStyle(document.querySelector('${selector}')).backgroundImage.startsWith('url("data:image/svg+xml')`),
			`${selector} 铺的是噪点图`,
		);
	await capture("smoke-skin-background-grain.png");
	await button("无", background);
	await wait(async () => (await appearance()).grain === false, "关掉磨砂");
	await until(
		`document.querySelector('.chat-grain') === null && getComputedStyle(document.querySelector('[data-plume-head-fill]')).backgroundImage === 'none'`,
		"关掉后外圈和对话区都不再铺颗粒",
	);
	const formatResults = await page<Array<{ name?: string; error?: string }>>(`(async () => {
		const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
		const results = [];
		for (const [mime, name] of [['image/jpeg', 'test.jpg'], ['image/webp', 'test.webp']]) {
			const blob = await new Promise(resolve => canvas.toBlob(resolve, mime));
			results.push(await window.plume.chatBackground.import(new Uint8Array(await blob.arrayBuffer()), name));
		}
		const gif = Uint8Array.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b'.match(/../g), x => parseInt(x, 16));
		results.push(await window.plume.chatBackground.import(gif, 'test.gif'));
		return results;
	})()`);
	assert.ok(
		formatResults.every((result) => typeof result.name === "string"),
		`原有图片格式仍可导入：${JSON.stringify(formatResults)}`,
	);
	// 跟在外观那段后面跑时已经有一张背景图：等引用换掉，不能只看「有没有」，否则拿旧图当成这次选的，后面拖入的那张又被当成选图。
	const previousImage = (await appearance().catch(() => ({}) as Record<string, unknown>)).chatBackground;
	await button("选择图片", background);
	await until(`document.querySelector('${background} [data-chat-background-preview] .chat-backdrop') !== null`, "工坊选图完成");
	await wait(async () => {
		const image = (await appearance()).chatBackground;
		return typeof image === "string" && image !== previousImage;
	}, "背景图引用落盘");
	const firstImage = (await appearance()).chatBackground;
	await button("平铺", background);
	await until(`document.querySelector('${background} .chat-backdrop')?.dataset.fit === 'tile'`, "背景预览平铺");
	await wait(async () => (await appearance()).chatBackgroundFit === "tile", "平铺设置落盘");
	assert.equal(await page(`getComputedStyle(document.querySelector('${background} .chat-backdrop')).backgroundRepeat`), "repeat");
	await page(`document.querySelector('${background}').scrollIntoView({ block: 'end' })`);
	await capture("smoke-skin-background-tile.png");

	// 浏览器 File 与 DragEvent 走真实 drop 处理，不直接调用导入接口绕过界面。
	await page(`(async () => {
		const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
		const ctx = canvas.getContext('2d'); ctx.fillStyle = '#D9F4E6'; ctx.fillRect(0, 0, 64, 64); ctx.fillStyle = '#C03959'; ctx.fillRect(0, 0, 32, 32);
		const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
		const data = new DataTransfer(); data.items.add(new File([blob], 'drop.png', { type: 'image/png' }));
		document.querySelector('${background} [data-chat-background-preview]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
	})()`);
	await wait(async () => (await appearance()).chatBackground !== firstImage, "拖入图片替换原图");
	const droppedImage = (await appearance()).chatBackground;
	await until(`document.querySelector('[data-screen=empty] > .chat-backdrop')?.dataset.fit === 'tile'`, "首页实际背景使用平铺");
	await page(`(() => {
		const data = new DataTransfer(); data.items.add(new File(['not an image'], 'bad.png', { type: 'image/png' }));
		document.querySelector('${background} [data-chat-background-preview]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
	})()`);
	await until(`document.querySelector('${background} [role=alert]')?.textContent.includes('图片无法识别')`, "无效图片显示原因");
	assert.equal((await appearance()).chatBackground, droppedImage, "导入失败保留原背景");
	await page(`(() => {
		const data = new DataTransfer(); data.items.add(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }));
		document.querySelector('${background} [data-chat-background-preview]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
	})()`);
	await until(`document.querySelector('${background} [role=alert]')?.textContent.includes('20 MB')`, "超限图片在读取前拒绝");
	assert.equal((await appearance()).chatBackground, droppedImage);

	await settings("外观");
	await until(`document.querySelector('[data-screen=settings] [data-plume-code-appearance]') !== null`, "外观页打开");
	assert.ok(await page<boolean>(`document.querySelector('[data-screen=settings] [data-chat-background-settings]') === null`), "首页背景只在换肤工坊里设置");
	await button("返回工作区");
	await button("换肤工坊", ".plume-composer");
	await button("铺满", background);
	await wait(async () => (await appearance()).chatBackgroundFit === "cover", "工坊修改铺放设置");
	await until(`document.querySelector('${background} .chat-backdrop')?.dataset.fit === 'cover'`, "背景预览铺满");
	await button("深色", "[data-skin-default]");
	await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "深色背景预览");
	await page(`document.querySelector('${background}').scrollIntoView({ block: 'end' })`);
	await capture("smoke-skin-background-dark.png");
	window.setSize(380, 440);
	await until(`innerWidth <= 380`, "背景最小窗口");
	await page(`document.querySelector('${background}').scrollIntoView({ block: 'end' })`);
	assert.ok(
		await page(`(() => { const el = document.querySelector('[data-skin-studio]'); return el.scrollWidth <= el.clientWidth + 1; })()`),
		"背景控件在最小窗口不横向溢出",
	);
	await capture("smoke-skin-background-compact.png");
	window.setSize(size[0]!, size[1]!);
	await until(`innerWidth === ${size[0]}`, "恢复背景验证窗口");
	await openStudioDetail();
	await toggleStudio(false);
	await wait(async () => !(await agent.plugins()).some((item) => item.name === "plume.skin-studio" && item.state === "active"), "工坊停用");
	// 「深色」改的是用户自己的主题偏好，不是工坊的皮肤：停用、再启用工坊都还是深色。
	assert.equal((await appearance()).theme, "dark", "停用工坊不改用户选的主题");
	assert.equal(await page<boolean>(`matchMedia('(prefers-color-scheme: dark)').matches`), true);
	assert.equal((await appearance()).chatBackground, droppedImage, "停用工坊保留背景图");
	assert.equal((await appearance()).lightForeground, "#263748");
	await toggleStudio(true);
	await wait(async () => (await agent.plugins()).some((item) => item.name === "plume.skin-studio" && item.state === "active"), "工坊重新启用");
	await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "重新启用工坊仍是用户选的深色");
	await leaveMarket();
	await button("换肤工坊", ".plume-composer");
	await button("清除", background);
	await wait(async () => (await appearance()).chatBackground === undefined, "清除背景图引用");
	await until(`document.querySelector('${background} [data-chat-background-preview]') === null`, "清除后显示空状态");
	await button("浅色", "[data-skin-default]");
	await wait(async () => (await appearance()).theme === "light", "选回用户原来的浅色");
	console.log(
		"PLUME_SKIN_STUDIO_SMOKE " +
			JSON.stringify({
				palette: true,
				textColors: true,
				mode: true,
				saved: true,
				ai: true,
				restore: true,
				readonly: true,
				defaults: true,
				background: true,
				drop: true,
				tile: true,
			}),
	);
}
