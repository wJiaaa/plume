import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { clipboard, nativeImage, type BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { clickEachVisible, clickReal as clickRealIn, clickVisible } from "./smoke-kit.ts";

const HTML = `<!doctype html><html><head><style>
body{color:var(--foreground);font-family:var(--font-sans)}section{padding:20px;background:var(--card);border-radius:var(--radius)}h2{margin:0 0 12px}button{background:var(--primary);color:var(--primary-foreground);border:0;padding:8px 16px;border-radius:var(--radius)}.long{height:2400px;padding-top:24px}
</style></head><body><section><h2>交互网页验收</h2><p>页面状态会跟随这段对话保存。</p><button id="count">计数 0</button> <button id="send">发送当前选择</button></section><div class="long">长页面的中间内容</div><footer>页面底部验收</footer><script>
window.autoSend=plume.send('禁止自动发送');
let n=plume.state?.count||0;const button=document.getElementById('count');const draw=()=>button.textContent='计数 '+n;draw();button.onclick=()=>{n++;plume.setState({count:n});draw()};
const design={size:20,color:'#339cff',enabled:true,layout:'grid'};
const paint=()=>{document.querySelector('section').style.padding=design.size+'px';document.querySelector('h2').style.color=design.color;document.querySelector('section p').hidden=!design.enabled;document.body.dataset.layout=design.layout;};paint();
plume.tweak({label:'布局设计',onChange:paint}).slider(design,'size',{label:'留白',min:8,max:48,step:1,unit:'px'}).color(design,'color',{label:'标题颜色'}).toggle(design,'enabled',{label:'显示说明'}).select(design,'layout',{label:'排列',options:['grid','list']});
document.querySelector('#send').onclick=()=>{window.lastSend=plume.send('页内选择 '+n);plume.send('重复消息不能发送');setTimeout(()=>window.timerSend=plume.send('禁止计时器发送'),0)};
</script></body></html>`;

export async function checkPreview({
	window,
	agent,
	plugin,
	outDir,
	setModel,
}: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; install(name: string): Promise<void>; installDir: string };
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const deadline = Date.now() + 25_000;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error(`网页预览冒烟超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const click = (selector: string) => clickVisible(page, selector);
	const send = async (text: string) => {
		await page("document.querySelector('.cm-content').focus()");
		await window.webContents.insertText(text);
		await until("document.querySelector('[data-composer-send=send]')?.disabled === false", "可以发送");
		await click("[data-composer-send=send]");
	};
	const capture = async (name: string) => {
		await page(
			"Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))",
		);
		await page(`(() => {
			const card = document.querySelector('[data-screen=chat] .preview-card');
			card.closest('.plume-scroll-view').dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
			card.scrollIntoView({block:'start',behavior:'instant'});
		})()`);
		await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	assert.ok(plugin.cli);
	await plugin.install("preview");
	await wait(async () => (await agent.plugins()).some((item) => item.name === "plume.preview" && item.state === "active"), "插件安装");
	let step = 0;
	let id = "";
	let sawError = false;
	let sawImage = false;
	let sawState = false;
	let sawSend = false;
	let sawTweaks = false;
	const tool = (args: Record<string, unknown>): FakeReply => ({ toolCalls: [{ id: `preview_smoke_${step}`, name: "preview", args }] });
	setModel((request) => {
		const messages = JSON.stringify(request.messages);
		sawError ||= messages.includes("preview-smoke-error");
		sawImage ||= messages.includes('"type":"image"');
		sawState ||= messages.includes("page-state") && messages.includes("count");
		sawSend ||= messages.includes("页内选择 1");
		sawTweaks ||= messages.includes("design-settings");
		id ||= /id: ([a-f0-9-]{36})/.exec(messages)?.[1] ?? "";
		switch (step++) {
			case 0:
				return tool({ title: "异常页面不能发布", html: '<!doctype html><p>broken</p><script>throw new Error("preview-smoke-error")</script>' });
			case 1:
				return { ...tool({ title: "交互网页验收", check: true, html: HTML, width: 390 }), stream: { chunkSize: 100, delayMs: 60 } };
			case 2:
				assert.ok(id);
				return tool({ id, check: true, width: 720, from: 2160 });
			case 3:
				return tool({ id });
			default:
				return { text: sawTweaks ? "收到设计修改。" : sawSend ? "收到页内选择。" : sawState ? "收到页面状态。" : "交互网页已发布。" };
		}
	});
	const size = window.getSize();
	try {
		window.webContents.send("plume:command", "new-session");
		await until("document.querySelector('[data-screen=empty]') !== null", "新建会话");
		await send("请展示交互网页验收。");
		await until(
			"document.querySelector('[data-tool-call=preview_smoke_2] [data-preview-draft=page] iframe')?.contentDocument?.querySelector('h2')?.textContent === '交互网页验收'",
			"流式草稿可见",
		);
		assert.equal(
			await page("document.querySelector('[data-tool-call=preview_smoke_2] [data-preview-draft] iframe').contentDocument.querySelector('script')"),
			null,
		);
		await until("document.querySelector('[data-tool-call=preview_smoke_2] .preview-draft-surface')?.getBoundingClientRect().height>=150", "草稿绘制完成");
		await page("document.querySelector('[data-tool-call=preview_smoke_2] .preview-draft').scrollIntoView({block:'start',behavior:'instant'})");
		await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
		await writeFile(join(outDir, "smoke-preview-draft.png"), (await window.webContents.capturePage()).toPNG());
		await until("document.querySelector('[data-screen=chat]')?.textContent.includes('交互网页已发布。') === true", "检查后发布");
		await until("document.querySelector('[data-screen=chat] .preview-frame[data-ready]') !== null", "页面加载");
		assert.ok(sawError, "模型收到脚本异常");
		assert.ok(sawImage, "模型收到检查截图");
		assert.equal(await page<number>("document.querySelectorAll('[data-screen=chat] .preview-card').length"), 1, "只展示通过检查的页面");
		const frame = () => window.webContents.mainFrame.framesInSubtree.find((frame) => frame.url.includes("127.0.0.1") && frame.url.includes("/index.html"));
		await wait(async () => Boolean(frame()), "找到沙箱页面");
		const sandbox = await frame()!.executeJavaScript(
			"({node:typeof require,app:typeof window.plume?.saveAppearance,parent:(()=>{try{return !!parent.document}catch{return false}})()})",
		);
		assert.deepEqual(sandbox, { node: "undefined", app: "undefined", parent: false });
		await clickVisible((code) => frame()!.executeJavaScript(code), "#count");
		await wait(async () => Boolean(await frame()!.executeJavaScript("plume.state.count===1")), "页面交互");
		await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
		await click('.preview-actions button[aria-label="重新运行"]');
		await wait(async () => {
			try {
				return !!frame() && Boolean(await frame()!.executeJavaScript("plume.state?.count===1 && document.querySelector('#count').textContent.includes('1')"));
			} catch {
				return false;
			}
		}, "重跑恢复状态");
		/**
		 * 真点：宿主页面里的元素经共用的 clickReal 点；`nested` 时点沙箱页（跨进程的 iframe）里的元素，落点要加上 iframe 的位置、
		 * 落没落到要在沙箱页里核对，共用的那份做不到，只有这一段要，留在这里。
		 */
		const clickReal = async (selector: string, nested = false) => {
			await until("document.querySelector('.preview-handover')===null", "页面交接结束");
			// 先往上滚一格，对话不再跟着底部走，下面滚到目标处才不会被拉回去。
			await page(
				`(() => { const el=document.querySelector(${JSON.stringify(nested ? ".preview-card iframe" : selector)}); el.closest('.plume-scroll-view').dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true})); ${nested ? "el.scrollIntoView({block:'start',behavior:'instant'});" : ""} })()`,
			);
			if (!nested) return clickRealIn(window, selector);
			await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
			await wait(
				async () =>
					Boolean(
						await frame()!.executeJavaScript(
							`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && e.checkVisibility({ visibilityProperty: true }) && !e.matches(':disabled'); })()`,
						),
					),
				`沙箱页里的 ${selector} 看得见、能点`,
			);
			const point = (await frame()!.executeJavaScript(
				`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
			)) as { x: number; y: number };
			const offset = await page<{ x: number; y: number }>(
				"(() => {const r=document.querySelector('.preview-card iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()",
			);
			point.x += offset.x;
			point.y += offset.y;

			const press = async () => {
				await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
					type: "mousePressed",
					button: "left",
					clickCount: 1,
					x: point.x,
					y: point.y,
				});
				await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
					type: "mouseReleased",
					button: "left",
					clickCount: 1,
					x: point.x,
					y: point.y,
				});
			};
			// 刚滚过的沙箱页：浏览器进程认点到哪个渲染进程，用的是合成器交上来的命中区域，可能还是滚动前的那一份，
			// 这一下就落在宿主页面的 <iframe> 元素上、进不了沙箱页（宿主收到 pointerdown，沙箱页什么都没收到）。
			// 沙箱页没收到才再点：落空的那一下在宿主那边没有作用，不会多发。
			await frame()!.executeJavaScript(
				"window.__smokePressed = false; addEventListener('pointerdown', () => { window.__smokePressed = true; }, { capture: true, once: true }); 0",
			);
			for (let attempt = 0; attempt < 5; attempt++) {
				await press();
				const end = Date.now() + 1000;
				while (Date.now() < end) {
					if (await frame()!.executeJavaScript("window.__smokePressed")) return;
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}
			throw new Error(`网页预览冒烟：点不进沙箱页的 ${selector}`);
		};
		assert.equal(await frame()!.executeJavaScript("window.autoSend"), false);
		// 故意用脚本点，不经 clickVisible：页面里程序触发的发送不算人话，下面断言它没有发出去；人点的那一下紧接着经 clickReal。
		await frame()!.executeJavaScript("document.querySelector('#send').click()");
		assert.equal(await frame()!.executeJavaScript("window.timerSend ?? false"), false);

		await clickReal("#send", true);
		await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

		await until("document.querySelector('[data-screen=chat]')?.textContent.includes('收到页内选择。') === true", "页内真实点击发送");
		assert.ok(sawSend);
		const human = await page<string[]>("Array.from(document.querySelectorAll('[data-screen=chat] [data-plume-quote=user]'), e=>e.textContent)");
		assert.equal(human.length, 2, "程序点击、计时器和重复发送不能新增人话");
		assert.ok(JSON.stringify(human[1]).includes("页内选择 1"));
		await clickReal('.preview-card .preview-actions button[aria-label="设计旋钮"]');
		await until("document.querySelectorAll('.preview-card input[type=range]').length===1", "四类旋钮加载");
		assert.equal(await page("document.querySelectorAll('.preview-card .preview-tweak-field').length"), 4);
		await clickReal(".preview-card input[type=range]");
		await wait(async () => Boolean(await frame()!.executeJavaScript("design.size !== 20")), "滑块即时调整");
		const adjusted = await frame()!.executeJavaScript("design.size");
		await clickReal(".preview-card .preview-tweak-actions button:nth-child(2)");
		await wait(async () => Boolean(await frame()!.executeJavaScript("design.size===20")), "对照原版");
		await clickReal(".preview-card .preview-tweak-actions button:nth-child(2)");
		await wait(async () => Boolean(await frame()!.executeJavaScript(`design.size===${adjusted}`)), "恢复修改");
		await clickReal(".preview-card .preview-tweak-actions button:first-child");
		await wait(async () => Boolean(await frame()!.executeJavaScript("design.size===20")), "复位");
		await clickReal(".preview-card [role=switch]");
		await wait(async () => Boolean(await frame()!.executeJavaScript("design.enabled===false")), "开关调整");
		await clickEachVisible(page, "[data-plume-toaster] button[aria-label=关闭]");
		await writeFile(join(outDir, "smoke-preview-tweaks.png"), (await window.webContents.capturePage()).toPNG());
		await clickReal(".preview-card .preview-tweak-actions button:last-child");
		await until("document.querySelector('[data-screen=chat]')?.textContent.includes('收到设计修改。') === true", "发送设计修改");
		assert.ok(sawTweaks);
		const settingsMessage = await page<string>("[...document.querySelectorAll('[data-screen=chat] [data-plume-quote=user]')].at(-1)?.textContent");
		assert.ok(settingsMessage.includes("请调整") && !settingsMessage.includes("design-settings"), "气泡只显示可读的修改说明");
		await clickReal('.preview-card .preview-actions button[aria-label="复制整页"]');
		await until("document.querySelector('.preview-card .preview-actions button[aria-label=已复制]') !== null", "复制整页");
		const items = await clipboard.read();
		const png = await items.find((item) => item.types.includes("image/png"))?.getType("image/png");
		assert.ok(png);
		const copied = nativeImage.createFromBuffer(Buffer.from(await png.arrayBuffer()));
		assert.ok(copied.getSize().height > 2400, "整页图包含折叠的底部");
		await writeFile(join(outDir, "smoke-preview-copy.png"), copied.toPNG());
		const { width: imageWidth, height: imageHeight } = copied.getSize();
		const pixels = copied.toBitmap();
		assert.equal(pixels.length, imageWidth * imageHeight * 4);
		for (let y = Math.floor(imageHeight / 3); y < imageHeight - 500; y += 5) {
			const color = pixels.subarray((y * imageWidth + 10) * 4, (y * imageWidth + 10) * 4 + 4);
			for (let x = Math.floor(imageWidth * 0.4); x < imageWidth * 0.6; x += 3)
				assert.deepEqual(pixels.subarray((y * imageWidth + x) * 4, (y * imageWidth + x) * 4 + 4), color, "空白区域不能混入宿主浮动按钮");
		}
		assert.equal(await frame()!.executeJavaScript("n"), 1, "复制没有重新运行页面");
		assert.equal(await frame()!.executeJavaScript("design.enabled"), false, "复制保留旋钮的当前状态");
		assert.equal(await page("document.querySelector('.preview-card iframe').style.transform"), "", "复制恢复页面位置");
		await page("window.plume.saveAppearance({theme:'light'})");
		await until("matchMedia('(prefers-color-scheme: light)').matches", "浅色");
		await capture("smoke-preview-light.png");
		await page("window.plume.saveAppearance({theme:'dark'})");
		await until("matchMedia('(prefers-color-scheme: dark)').matches", "深色");
		await capture("smoke-preview-dark.png");
		window.setSize(600, size[1]!);
		await until("innerWidth===600", "窄窗口");
		assert.ok(await page<boolean>("document.querySelector('.preview-card').getBoundingClientRect().right <= innerWidth"));
		await capture("smoke-preview-compact.png");
		window.setSize(size[0]!, size[1]!);
		await click(".preview-more button");
		await until("document.querySelector('.preview-surface').getBoundingClientRect().height>2400", "长页面展开");
		await click('.preview-actions button[aria-label="恢复高度"]');
		await until("document.querySelector('.preview-surface').getBoundingClientRect().height<=720", "长页面折回");
		await click('.preview-actions button[aria-label="在面板中打开"]');
		await until("document.querySelector('.preview-panel .preview-frame[data-ready]') !== null", "侧边面板");
		await page(
			"Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))",
		);
		await writeFile(join(outDir, "smoke-preview-panel.png"), (await window.webContents.capturePage()).toPNG());
		await send("我调整过页面，请读取当前状态。");
		await until("document.querySelector('[data-screen=chat]')?.textContent.includes('收到设计修改。') === true", "状态带回模型");
		assert.ok(sawState);
		console.log(
			"PLUME_PREVIEW_SMOKE",
			JSON.stringify({
				ok: true,
				errors: true,
				screenshot: true,
				slices: true,
				state: true,
				sandbox: true,
				themes: ["light", "dark"],
				panel: true,
				compact: true,
				streaming: true,
				tweaks: true,
				send: true,
				copy: true,
			}),
		);
	} finally {
		setModel(undefined);
		window.setSize(size[0]!, size[1]!);
		await page("window.plume.saveAppearance({theme:'light'})");
	}
}
