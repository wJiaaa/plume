import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { BrowserWindow } from "electron";
import { NATIVE_HEADER_HEIGHT, ROW_OFFSET, TOP_ROW_HEIGHT, TRAFFIC_LIGHTS_END } from "../shared/window-chrome.ts";

type Rect = { left: number; top: number; width: number; height: number };

/** 卡片标题栏里的面板开关：它打开面板区，开始页上的「项目文件」是宿主自己的面板，不用先装插件。 */
const PANEL_TOGGLE = "[data-panel-toggle] button";
const SIDEBAR = 'aside[aria-label="侧边栏"]';
/** 顶行的后退：从插件市场、设置页回到刚才的会话。 */
const BACK = 'button[aria-label^="后退"]';
const FILES_LAUNCH = '[data-panel-launch="plume/files"]';
const FILES_TAB = '[data-panel-area] [data-panel-tab="plume/files"]';
/** 面板内容不在面板区的卡片里，另放在一层（换会话不搬 DOM），看得见的那一份没有 inert。 */
const FILES_CONTENT = '[data-panel-layer] [data-panel="plume/files"]:not([inert])';
const PRESERVED = '[data-panel="plume/files"] [data-smoke-preserved]';
/** 窗口顶行的侧栏开关；设置页里同一颗按钮开合的是章节列表。 */
const NAV_TOGGLE = 'button[aria-label*="侧边栏 "], button[aria-label*="设置导航 "]';

/**
 * 桌面兼容（`PLUME_SMOKE_ONLY=desktop-compat`）：几种缩放比、窗口大小和明暗主题下，窗口外壳的几何站得住。
 *
 * 1. 顶上各行的控件都压在自己那一行的中线上，面板开关点得到，开出的标签整个露在标签条里；
 * 2. 普通大小的窗口变窄时面板区改成上下排，不丢面板、不重建面板内容、不改写存下的宽度和标签，拉宽回来原样；
 * 3. 125% 下侧栏边缘落在小数设备像素上时，标题栏和面板区的图标还画在同一列设备像素上；
 * 4. 设置页的章节列表滑动时，设置那一列一次到最终宽度，之后只平移。
 *
 * 缩放比经 DevTools 协议模拟（`Emulation.setDeviceMetricsOverride`）：冒烟只起一个 Electron，`--force-device-scale-factor`
 * 要在启动前给、一次只能一种；模拟的缩放比换的是每个 CSS 像素合几个设备像素，布局和栅格化走的是同一条路。
 */
export async function checkDesktopCompat(options: {
	window: BrowserWindow;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, outDir, setModel } = options;
	const cdp = <T>(method: string, params?: Record<string, unknown>) => window.webContents.debugger.sendCommand(method, params) as Promise<T>;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const deadline = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error(`桌面兼容验证等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const frames = (count: number) =>
		page(`new Promise(resolve => { let n = ${count}; const step = () => (--n > 0 ? requestAnimationFrame(step) : resolve()); requestAnimationFrame(step); })`);
	const settle = async () => {
		await frames(2);
		await page(
			`Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))`,
		);
		await frames(2);
	};
	const visible = (selector: string) =>
		`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`;
	/** 用真的指针按：先确认按钮中心落下去点到的就是它自己，没被别的东西盖住。 */
	const press = async (selector: string, button: "left" | "middle" = "left") => {
		await until(`Boolean(${visible(selector)})`, `等到 ${selector}`);
		const at = await page<{ x: number; y: number; hit: boolean }>(`(() => {
			const el = ${visible(selector)}, r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
			return { x, y, hit: el.contains(document.elementFromPoint(x, y)) };
		})()`);
		assert.ok(at.hit, `${selector} 点得到：${JSON.stringify(at)}`);
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
		for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button, clickCount: 1 });
	};
	const shot = async (name: string) => {
		await settle();
		const { data } = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(outDir, name), Buffer.from(data, "base64"));
	};
	const setTheme = async (theme: "light" | "dark") => {
		await page(`window.plume.saveAppearance({ theme: ${JSON.stringify(theme)} })`);
		await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`, `切到${theme}`);
	};
	/** 窗口内容区的大小和缩放比；宽高是真的改窗口，侧栏、面板的分档都跟着窗口宽度走。 */
	const setViewport = async (width: number, height: number, scale: number) => {
		window.setContentSize(width, height);
		await cdp("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: scale, mobile: false });
		await until(`innerWidth === ${width} && innerHeight === ${height} && devicePixelRatio === ${scale}`, `窗口 ${width}×${height} @${scale}`);
		await settle();
	};
	const panelShown = `Boolean(document.querySelector('[data-panel-area]:not([inert])'))`;
	/** 每一组从同一个样子开始：面板区收着；宽窗口里侧栏开着，窄窗口里抽屉关着。 */
	const reset = async () => {
		if (await page<boolean>(panelShown)) {
			await page(`document.querySelector('[data-panel-area] button[aria-label="收起面板"]').click()`);
			await until(`!${panelShown}`, "收起面板区");
		}
		const compact = await page<boolean>(`innerWidth < 760`);
		const open = await page<boolean>(`!document.querySelector(${JSON.stringify(SIDEBAR)}).inert`);
		if (open === compact) {
			await page(`document.querySelector(${JSON.stringify(NAV_TOGGLE)}).click()`);
			await until(`document.querySelector(${JSON.stringify(SIDEBAR)}).inert === ${compact}`, compact ? "关上抽屉" : "打开侧栏");
		}
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
		await settle();
	};

	/*
	 * 每个控件的中心和它那一行的中线差不过半个 CSS 像素（小数缩放比下卡片 1px 的描边会被量化）。
	 * 卡片里的标题栏（对话、面板区）从卡片描边里面算起，各 `TOP_ROW_HEIGHT` 高；窗口自己的那一行在 Windows、Linux 上是
	 * 顶上那条 `NATIVE_HEADER_HEIGHT` 的带子，量它画出来的位置，不拿常量比：拿常量比只说明两边哪个碰巧对上了；
	 * macOS 上没有带子，后退、前进、侧栏开关浮在卡片角上，和红绿灯同在下移 `ROW_OFFSET` 的那一行。
	 */
	const headerAlignment = async (label: string) => {
		const geometry = await page<{
			controls: number;
			maxError: number;
			drift: string[];
			headerCenter: number;
			headerHeight: number | null;
			overlayCenter: number | null;
			overlayHeight: number | null;
		}>(`(() => {
			const errors = [], drift = [];
			const measure = (el, center, name) => {
				if (!el || !el.checkVisibility({ visibilityProperty: true })) return;
				const r = el.getBoundingClientRect();
				if (!(r.height > 0 && r.right > 0 && r.left < innerWidth)) return;
				const error = Math.abs(r.y + r.height / 2 - center);
				errors.push(error);
				if (error > 0.5) drift.push(name + ': ' + (r.y + r.height / 2).toFixed(2) + ' vs ' + center.toFixed(2));
			};
			for (const header of document.querySelectorAll('.rounded-panel.border > header')) {
				const card = header.parentElement;
				const center = card.getBoundingClientRect().top + card.clientTop + ${TOP_ROW_HEIGHT / 2};
				const kind = header.closest('[data-panel-area]') ? 'panel' : 'chat';
				for (const icon of header.querySelectorAll('svg')) measure(icon, center, kind + ' svg');
				for (const button of header.querySelectorAll('button')) measure(button, center, kind + ' ' + (button.getAttribute('aria-label') || button.textContent.trim() || 'button'));
			}
			const header = document.querySelector('[data-plume-window-header]');
			const band = header ? header.getBoundingClientRect() : null;
			const headerCenter = band ? band.top + band.height / 2 : ${ROW_OFFSET + TOP_ROW_HEIGHT / 2};
			const toggle = document.querySelector(${JSON.stringify(NAV_TOGGLE)});
			for (const button of toggle ? toggle.parentElement.closest('div').querySelectorAll('button') : []) {
				const name = button.getAttribute('aria-label');
				measure(button, headerCenter, name);
				measure(button.querySelector('svg'), headerCenter, name + ' svg');
			}
			const overlay = navigator.windowControlsOverlay;
			const rect = overlay?.visible ? overlay.getTitlebarAreaRect() : null;
			return { controls: errors.length, maxError: Math.max(...errors), drift, headerCenter, headerHeight: band ? band.height : null,
				overlayCenter: rect ? rect.y + rect.height / 2 : null, overlayHeight: rect ? rect.height : null };
		})()`);
		assert.ok(geometry.controls >= 2, `${label}：顶行控件看得见：${JSON.stringify(geometry)}`);
		assert.ok(geometry.maxError <= 0.5, `${label}：控件偏离中线：${JSON.stringify(geometry)}`);
		// 带子只按系统按钮的高度画，哪个平台画它都一样。
		if (geometry.headerHeight !== null)
			assert.ok(Math.abs(geometry.headerHeight - NATIVE_HEADER_HEIGHT) <= 0.5, `${label}：带子是 ${NATIVE_HEADER_HEIGHT}px：${JSON.stringify(geometry)}`);
		if (geometry.overlayCenter !== null)
			assert.ok(Math.abs(geometry.overlayCenter - geometry.headerCenter) <= 0.5, `${label}：系统按钮和带子同一条中线：${JSON.stringify(geometry)}`);
		// 带子和系统按钮是同一个数（`titleBarOverlay.height`）：矮了按钮探出带子，高了上下各浮一段空白。
		if (process.platform === "win32")
			assert.ok(
				geometry.headerHeight !== null && geometry.overlayHeight !== null && Math.abs(geometry.overlayHeight - geometry.headerHeight) <= 0.5,
				`${label}：系统按钮和带子一样高：${JSON.stringify(geometry)}`,
			);
		// 红绿灯由主进程摆（`trafficLightPosition`），灯高 14：它的中心也得落在这一行的中线上。
		if (process.platform === "darwin") {
			const lights = window.getWindowButtonPosition();
			assert.ok(lights && Math.abs(lights.y + 7 - geometry.headerCenter) <= 0.5, `${label}：红绿灯在顶行中线上：${JSON.stringify({ lights, geometry })}`);
		}
		return geometry;
	};

	setModel(() => ({ text: "桌面兼容准备好了。" }));
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty] .cm-content') !== null`, "新建对话");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("桌面兼容");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await page(`document.querySelector('[data-composer-send=send]').click()`);
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('桌面兼容准备好了。') === true`, "这一轮答完");
	} finally {
		setModel(undefined);
	}
	const initialSize = window.getContentSize() as [number, number];

	try {
		// ── 1. 顶行对中线，面板开关点得到 ──────────────────────────────
		const results: unknown[] = [];
		for (const [scale, width, height, theme] of [
			[1, 380, 440, "dark"],
			[1.25, 768, 600, "light"],
			[1.5, 980, 640, "dark"],
			[2, 640, 480, "light"],
		] as const) {
			const label = `${scale * 100}% ${width}×${height} ${theme}`;
			await setTheme(theme);
			await setViewport(width, height, scale);
			await reset();
			await headerAlignment(`${label} 初始`);
			const geometry = await page<{ overflow: number; composerVisible: boolean; controlsClear: boolean; dpr: number }>(`(() => {
				const overlay = navigator.windowControlsOverlay;
				const edge = overlay?.visible ? overlay.getTitlebarAreaRect().right : innerWidth;
				const composer = document.querySelector('.plume-composer').getBoundingClientRect();
				const toggle = document.querySelector(${JSON.stringify(NAV_TOGGLE)});
				const header = document.querySelector('[data-plume-window-header]');
				// 窗口顶行的按钮：有带子时右边让开系统按钮；macOS 上左边让开红绿灯。
				const buttons = [...(header ?? toggle.parentElement.closest('div')).querySelectorAll('button')];
				const start = header ? 0 : ${TRAFFIC_LIGHTS_END};
				return { overflow: document.documentElement.scrollWidth - innerWidth, dpr: devicePixelRatio,
					composerVisible: composer.left >= 0 && composer.right <= innerWidth && composer.bottom <= innerHeight && composer.height > 20,
					controlsClear: buttons.every(b => { const r = b.getBoundingClientRect(); return r.right <= edge && r.left >= start; }) };
			})()`);
			assert.equal(geometry.overflow, 0, `${label}：页面不横向溢出`);
			assert.ok(geometry.composerVisible, `${label}：输入框整个在窗口里`);
			assert.ok(geometry.controlsClear, `${label}：顶行按钮不压系统按钮、红绿灯`);

			// Tab 给按到的按钮画看得见的焦点环。Chromium 把描边量化到设备像素：2 CSS px 在 125% 下是 1.6。
			await page(`document.querySelector(${JSON.stringify(NAV_TOGGLE)}).focus()`);
			await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
			await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
			const focus = await page<{ visible: boolean; width: number; style: string; dpr: number; name: string }>(`(() => {
				const el = document.activeElement, style = getComputedStyle(el);
				return { visible: el.matches(':focus-visible') && el !== document.body, width: parseFloat(style.outlineWidth), style: style.outlineStyle,
					dpr: devicePixelRatio, name: el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 20) };
			})()`);
			assert.ok(
				focus.visible && focus.style === "solid" && focus.width >= Math.floor(2 * focus.dpr) / focus.dpr - 0.01,
				`${label}：Tab 到的按钮有焦点环：${JSON.stringify(focus)}`,
			);
			await page(`document.activeElement.blur()`);

			// 面板开关点得到；开始页里点「项目文件」，标签整个露在标签条里，它的 ✕ 和「添加面板」也点得到。
			await press(PANEL_TOGGLE);
			await until(`${panelShown} && Boolean(${visible(FILES_LAUNCH)} ?? ${visible(FILES_TAB)})`, `${label}：面板区打开`);
			await settle();
			// 第一组从开始页点开项目文件；之后各组打开面板区就回到存下的那个标签。
			// 窗口矮时开始页放不下所有面板，贴顶往下滚：先把「项目文件」滚进来再按，和人一样。
			if (await page<boolean>(`!${visible(FILES_TAB)}`)) {
				await page(`${visible(FILES_LAUNCH)}.scrollIntoView({ block: "nearest" })`);
				await press(FILES_LAUNCH);
			}
			await until(`Boolean(${visible(FILES_TAB)})`, `${label}：开出项目文件标签`);
			await settle();
			await headerAlignment(`${label} 面板区`);
			const tab = await page<{ visibleTabWidth: number; tabWidth: number; addHit: boolean; closeHit: boolean }>(`(() => {
				const tab = ${visible(FILES_TAB)}, r = tab.getBoundingClientRect();
				const strip = tab.closest('[role="tablist"]').getBoundingClientRect();
				const hit = b => { if (!b) return false; const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); };
				return { visibleTabWidth: Math.max(0, Math.min(r.right, strip.right) - Math.max(r.left, strip.left)), tabWidth: r.width,
					addHit: hit(${visible("[data-panel-area] [data-panel-add]")}), closeHit: hit(tab.querySelector('[aria-label="关闭项目文件"]')) };
			})()`);
			assert.ok(tab.visibleTabWidth >= tab.tabWidth - 1, `${label}：标签整个露在标签条里：${JSON.stringify(tab)}`);
			assert.ok(tab.addHit && tab.closeHit, `${label}：「添加面板」和关闭标签点得到：${JSON.stringify(tab)}`);
			const tabs = `document.querySelectorAll('[data-panel-area] [role=tablist] [data-panel-tab-id]').length`;
			const before = await page<number>(tabs);
			await press("[data-panel-area] [data-panel-add]");
			await until(`${tabs} === ${before + 1}`, `${label}：「添加面板」多开一个开始页标签`);
			// 中键点标签关掉它，再开一个接着量两个标签。
			await settle();
			await press("[data-panel-area] [data-panel-tab=start] [role=tab]", "middle");
			await until(`${tabs} === ${before}`, `${label}：中键关掉开始页标签`);
			await press("[data-panel-area] [data-panel-add]");
			await until(`${tabs} === ${before + 1}`, `${label}：再开一个开始页标签`);
			await settle();
			await headerAlignment(`${label} 两个标签`);
			// 开合侧栏会让出或收回空间，面板区跟着挪；量落定之后的。
			await press(NAV_TOGGLE);
			await settle();
			await frames(30);
			await headerAlignment(`${label} 开合侧栏后`);
			await shot(`desktop-compat-${scale * 100}-${width}x${height}-${theme}.png`);
			// 把多开的开始页关掉，下一组从项目文件这一个标签开始。
			await page(`[...document.querySelectorAll('[data-panel-area] [data-panel-tab=start] button[aria-label^="关闭"]')].forEach(button => button.click())`);
			await until(`${tabs} === ${before}`, `${label}：关掉多开的标签`);
			results.push({ label, ...geometry, focus: focus.name });
		}
		console.log("PLUME_DESKTOP_COMPAT_HEADER " + JSON.stringify(results));

		// ── 2. 普通窗口里面板区重排 ────────────────────────────────────
		await setTheme("light");
		await setViewport(1200, 800, 1);
		await reset();
		await press(PANEL_TOGGLE);
		await until(`Boolean(${visible(FILES_TAB)})`, "面板区回到项目文件标签");
		await settle();
		// 标在面板内容自己的根上：换排法时它要是被卸下重建，这个标记就没了。
		await page(`document.querySelector(${JSON.stringify(FILES_CONTENT)}).firstElementChild.setAttribute('data-smoke-preserved', '')`);
		const measure = () =>
			page<{ arrangement: string; chat: Rect; panel: Rect; content: Rect; saved: string; sameContent: boolean }>(`(() => {
				const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
				return { arrangement: document.querySelector('[data-panel-layout]').dataset.panelLayout,
					chat: box(document.querySelector('[data-panel-layout] > main')), panel: box(document.querySelector('[data-panel-area]')),
					content: box(document.querySelector(${JSON.stringify(FILES_CONTENT)})),
					saved: JSON.stringify([localStorage.getItem('plume.panel'), localStorage.getItem('plume.panel-tabs')]),
					sameContent: Boolean(document.querySelector(${JSON.stringify(PRESERVED)})) };
			})()`);
		const wide = await measure();
		assert.equal(wide.arrangement, "row", `宽窗口里面板区和对话并排：${JSON.stringify(wide)}`);
		assert.ok(wide.saved.includes("files"), "换排法之前，项目文件标签已经存下");
		// 侧栏还开着，正文横向放不下对话加最窄的面板，纵向够：上下排。
		await setViewport(770, 576, 1);
		const narrow = await measure();
		assert.equal(narrow.arrangement, "column", `变窄后上下排：${JSON.stringify(narrow)}`);
		assert.ok(narrow.chat.width >= 420 && narrow.chat.height >= 260, `对话留得下可读的大小：${JSON.stringify(narrow)}`);
		assert.ok(narrow.panel.width >= 300 && narrow.panel.height >= 150, `面板区留得下可用的大小：${JSON.stringify(narrow)}`);
		assert.ok(Math.abs(narrow.panel.left - narrow.chat.left) < 1, "上下排时左边对齐");
		assert.ok(Math.abs(narrow.panel.top - (narrow.chat.top + narrow.chat.height + 4)) < 1, "面板区接在对话下面，隔一道 4px 的缝");
		// 面板内容另放在一层里（换会话不搬 DOM），它得跟着面板区的卡片走，不留在原处。
		assert.ok(
			narrow.content.left >= narrow.panel.left &&
				narrow.content.top >= narrow.panel.top &&
				narrow.content.top + narrow.content.height <= narrow.panel.top + narrow.panel.height + 0.5,
			`面板内容跟着面板区：${JSON.stringify(narrow)}`,
		);
		assert.equal(narrow.saved, wide.saved, "换排法不改写存下的宽度和标签");
		assert.equal(narrow.sameContent, true, "换排法不重建面板内容");
		const splitter = await page<{ y: number; hit: boolean }>(`(() => {
			const e = document.querySelector('[data-panel-layout] > [role="separator"]'), r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
			return { y, hit: e.contains(document.elementFromPoint(x, y)) };
		})()`);
		assert.equal(splitter.hit, true, "上下之间的分隔条点得到");
		assert.ok(
			splitter.y >= narrow.chat.top + narrow.chat.height - 1 && splitter.y <= narrow.panel.top + 1,
			`分隔条在对话和面板区之间：${JSON.stringify(splitter)}`,
		);
		await shot("desktop-compat-panel-column.png");
		await setViewport(1200, 800, 1);
		const restored = await measure();
		console.log("PLUME_DESKTOP_COMPAT_REFLOW " + JSON.stringify({ wide, narrow, splitter, restored }));
		assert.equal(restored.saved, wide.saved);
		assert.equal(restored.sameContent, true);
		for (const kind of ["chat", "panel"] as const) {
			assert.ok(Math.abs(restored[kind].width - wide[kind].width) < 1, `${kind} 拉宽回来宽度照旧`);
			assert.ok(Math.abs(restored[kind].left - wide[kind].left) < 1, `${kind} 拉宽回来位置照旧`);
			assert.equal(restored[kind].top, wide[kind].top);
		}
		/*
		 * 去插件市场看一眼再回来，面板区原样：同一个标签、同一份存下的布局、同样的位置。项目文件不是常驻面板（keepAlive），
		 * 离开工作区时按契约可以卸下，回来再挂上，所以这里不要求是同一份 DOM；常驻的那种（终端）由它所在插件的冒烟管。
		 */
		await page(`document.querySelector('[data-nav=market]').click()`);
		await until(`document.querySelector('[data-screen=chat]')?.checkVisibility({ visibilityProperty: true }) === false`, "插件市场盖住工作区");
		await page(`document.querySelector(${JSON.stringify(BACK)}).click()`);
		await until(
			`document.querySelector('[data-screen=chat]')?.checkVisibility({ visibilityProperty: true }) === true && Boolean(${visible(FILES_TAB)})`,
			"回到工作区，项目文件标签还在",
		);
		await settle();
		const back = await measure();
		assert.equal(back.saved, wide.saved, "去过别的页面，存下的布局不变");
		assert.ok(Math.abs(back.panel.left - wide.panel.left) < 1 && Math.abs(back.panel.width - wide.panel.width) < 1, "面板区回到原来的位置");

		// ── 3. 125% 下图标不随侧栏边缘漂 ───────────────────────────────
		// 窗口要宽到面板区取它存下的宽度：窄到对话只剩最小宽度时，面板区让出的是「总宽减对话」，对话那一栏的右边本来就跟着侧栏边缘走。
		await setViewport(1200, 760, 1.25);
		await reset();
		await press(PANEL_TOGGLE);
		await until(`Boolean(${visible(FILES_TAB)})`, "125% 下打开面板区");
		await settle();
		// 标题栏右端那一组和面板区右端那一组：都贴着各自卡片的右边，侧栏边缘挪动时布局位置不变，画出来也该不变。
		const rows = {
			toolbar: `[...document.querySelectorAll('[data-panel-layout] > main header .ml-auto button')].filter(b => b.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`,
			pane: `[...document.querySelectorAll('[data-panel-area] header .ml-auto button')].filter(b => b.checkVisibility({ opacityProperty: true, visibilityProperty: true }))`,
		};
		const dpr = await page<number>("devicePixelRatio");
		const placed: Record<string, { icons: { x: number; width: number }[]; clip: { x: number; y: number; width: number; height: number } }> = {};
		for (const [name, list] of Object.entries(rows)) {
			const icons = await page<{ x: number; y: number; width: number }[]>(
				`${list}.map(b => b.getBoundingClientRect()).map(r => ({ x: r.x, y: r.y, width: r.width })).sort((a, b) => a.x - b.x)`,
			);
			assert.ok(icons.length >= 1, `${name} 这一行有图标：${JSON.stringify(icons)}`);
			const left = Math.floor(icons[0]!.x) - 4,
				right = Math.ceil(icons.at(-1)!.x + icons.at(-1)!.width) + 4;
			placed[name] = { icons, clip: { x: left, y: Math.floor(Math.min(...icons.map((icon) => icon.y))) - 4, width: right - left, height: 36 } };
		}
		const samples: { edge: number; row: string; layout: number[]; painted: number[] }[] = [];
		for (const edge of [0, -1, -2, -3, -5, -6, -7]) {
			await page(
				`(() => { const aside = document.querySelector(${JSON.stringify(SIDEBAR)}); aside.style.transition = 'none'; aside.style.marginLeft = '${edge}px'; })()`,
			);
			await frames(4);
			for (const [name, list] of Object.entries(rows)) {
				const { icons, clip } = placed[name]!;
				const layout = await page<number[]>(`${list}.map(b => b.getBoundingClientRect().x).sort((a, b) => a - b)`);
				const image = await paintedPixels(clip);
				// 每个图标自己那一格里墨迹的横向重心，以设备像素计、从截取区的左边算。
				const painted = icons.map((icon) => {
					const from = Math.round((icon.x - clip.x) * dpr),
						to = Math.round((icon.x - clip.x + icon.width) * dpr);
					let ink = 0,
						weighted = 0;
					for (let x = from; x < to; x++)
						for (let y = 0; y < image.height; y++) {
							const value = 255 - image.gray[y * image.width + x]!;
							ink += value;
							weighted += value * x;
						}
					return Math.round((weighted / ink) * 100) / 100;
				});
				samples.push({ edge, row: name, layout, painted });
			}
		}
		await page(`(() => { const aside = document.querySelector(${JSON.stringify(SIDEBAR)}); aside.style.marginLeft = ''; aside.style.transition = ''; })()`);
		console.log("PLUME_DESKTOP_COMPAT_PIXELS " + JSON.stringify({ dpr, samples }));
		for (const name of Object.keys(rows)) {
			const mine = samples.filter((sample) => sample.row === name);
			for (const sample of mine) assert.deepEqual(sample.layout, mine[0]!.layout, `${name}：图标的布局位置不随侧栏边缘动`);
			// 毛病是整整一列设备像素；同一个图标边缘不动时帧与帧之间也有零点零几的抖动，所以按半列判。
			for (const [index] of placed[name]!.icons.entries()) {
				const columns = mine.map((sample) => sample.painted[index]!);
				assert.ok(Math.max(...columns) - Math.min(...columns) < 0.5, `${name}：图标 ${index} 画在同一列上：${[...new Set(columns)].join(", ")}`);
			}
		}

		// ── 4. 设置导航滑动时设置列只平移 ──────────────────────────────
		await setViewport(984, 684, 1);
		await reset();
		window.webContents.send("plume:command", "settings");
		const column = `[...document.querySelectorAll('[data-screen=settings]')].find(e => e.checkVisibility())`;
		await until(`Boolean(${column})`, "打开设置页");
		await settle();
		for (const phase of ["收起", "展开"]) {
			// 指针先移过去，像手一样：顶行按钮悬停之后才接按下。
			const at = await page<{ x: number; y: number }>(
				`(() => { const r = document.querySelector('button[aria-label*="设置导航"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
			);
			await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
			// 采到滑动开始又停下为止，不按固定帧数：机器忙时送到按下的时间可能比一次滑动还长。
			await page(`(() => { window.__smokeHold = (async () => {
				const out = []; let moved = false, still = 0;
				for (let i = 0; i < 400 && still < 12; i++) {
					await new Promise(requestAnimationFrame);
					const el = ${column}, card = el.closest('.rounded-panel');
					const sample = { width: Math.round(el.getBoundingClientRect().width * 10) / 10, left: Math.round(card.getBoundingClientRect().x * 10) / 10 };
					const last = out.at(-1);
					if (last && last.left !== sample.left) { moved = true; still = 0; } else if (moved) still++;
					out.push(sample);
				}
				return out;
			})(); })()`);
			for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
			const held = await page<{ width: number; left: number }[]>("window.__smokeHold");
			const widths = [...new Set(held.map((sample) => sample.width))];
			const lefts = new Set(held.map((sample) => sample.left));
			console.log("PLUME_DESKTOP_COMPAT_SETTINGS " + JSON.stringify({ phase, widths, positions: lefts.size }));
			assert.ok(lefts.size >= 3, `${phase}：章节列表真的滑了，中间有帧，否则宽度说明不了什么`);
			assert.ok(widths.length <= 2, `${phase}：设置列一次到最终宽度：${JSON.stringify(widths)}`);
			await settle();
			if (phase === "收起") await shot("desktop-compat-settings-collapsed.png");
		}
		await page(`document.querySelector(${JSON.stringify(BACK)}).click()`);
	} finally {
		await cdp("Emulation.clearDeviceMetricsOverride");
		window.setContentSize(...initialSize);
	}

	/**
	 * 一块区域里真正画出来的像素，由页面自己解码。布局位置看不出这里要找的毛病：图标画歪了一列时 getBoundingClientRect 分毫不差。
	 * 截图转成 data URL 画进 canvas 是同源的，Node 这边没有 PNG 解码器。截取区按 CSS 像素给，回来的是设备像素，每个 CSS 像素 dpr 个。
	 */
	async function paintedPixels(clip: { x: number; y: number; width: number; height: number }): Promise<{ width: number; height: number; gray: number[] }> {
		const { data } = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
		return page(`(async () => {
			const img = new Image(); img.src = 'data:image/png;base64,${data}'; await img.decode();
			const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
			const g = canvas.getContext('2d'); g.drawImage(img, 0, 0);
			const px = g.getImageData(0, 0, img.width, img.height).data, gray = [];
			for (let i = 0; i < px.length; i += 4) gray.push((px[i] + px[i + 1] + px[i + 2]) / 3);
			return { width: img.width, height: img.height, gray };
		})()`);
	}
}
