import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Remote } from "@plume/rpc";
import { type BrowserWindow, ipcMain, nativeTheme } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import type { ModelOverride } from "./smoke-browser.ts";
import { nativeClick, nativeEnter } from "./smoke-message-edits.ts";

/** 本体会话界面：项目折叠、项目草稿、置顶、停止后保留队列及手动发送。 */
export async function checkConversations(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	workspace: string;
	outDir: string;
	setModel(override: ModelOverride | undefined): void;
}): Promise<void> {
	const { window, agent, workspace, outDir, setModel } = options;
	const page = <T = unknown>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const deadline = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error(`会话验证等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 80));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const find = (selector: string, text?: string) =>
		`[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => ${text === undefined ? "true" : `element.textContent.trim() === ${JSON.stringify(text)}`})`;
	const click = async (selector: string, text?: string) => {
		await until(`Boolean(${find(selector, text)})`, `${selector} ${text ?? ""}`);
		await page(`${find(selector, text)}.click()`);
	};
	const type = (selector: string, value: string) =>
		page(`(() => {
			const input = document.querySelector(${JSON.stringify(selector)});
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
			input.dispatchEvent(new Event('input', { bubbles: true }));
		})()`);
	const capture = async (name: string) => {
		await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
		await page(
			`Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))`,
		);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const menu = '[role=menu][aria-label="会话选项"]';
	const openMenu = async (sessionId: string) => {
		await until(`document.querySelector(${JSON.stringify(menu)}) === null`, "上一次会话菜单已关闭");
		await page(
			`(() => { const row = document.querySelector('[data-plume-row="${sessionId}"]'); const rect = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 12 })); })()`,
		);
		await until(`document.querySelector(${JSON.stringify(menu)}) !== null`, "会话右键菜单出现");
	};
	const menuItem = (label: string, within = menu) => click(`${within} [role^=menuitem]`, label);

	// 一、默认会话列表：建一个项目、在里面聊一段；折起来显示数目，悬停时数目让给新建、更多两个按钮，移开再回来。
	ipcMain.removeHandler("plume:pick-folder");
	const extraSource = join(outDir, "extra-source");
	await mkdir(extraSource, { recursive: true });
	await writeFile(join(extraSource, "extra.txt"), "来自第二个源目录");
	let pickedFolder = workspace;
	ipcMain.handle("plume:pick-folder", () => pickedFolder);
	let hang = false;
	let reply = "项目里答了一句。";
	// 某一段要按请求内容回话时临时接管。
	let script: ModelOverride | undefined;
	setModel((request) => {
		if (script) return script(request);
		return hang ? { text: "我先想想。", hang: true } : { text: reply };
	});
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty] .cm-content') !== null`, "标准欢迎页已就绪");
		if (await page<boolean>(`document.querySelector('button[aria-label="不在项目中工作"]') !== null`)) await click('button[aria-label="不在项目中工作"]');
		await click("button", "开发功能");
		await until(`document.querySelector('.cm-content')?.textContent.includes('新增一个功能')`, "欢迎页建议填入项目外草稿");
		await click('[data-plume-section-action] button[aria-label="新建项目"]');
		await until(`document.querySelector('[data-plume-project-dialog=create]') !== null`, "新建项目对话框");
		await type("[data-plume-project-dialog=create] input", "冒烟项目");
		await click("[data-plume-add-folder]");
		await until(`document.querySelector('[data-plume-source-folder]') !== null`, "选好项目目录");
		pickedFolder = extraSource;
		await click("[data-plume-add-folder]");
		await until(`document.querySelectorAll('[data-plume-source-folder]').length === 2`, "项目添加第二个源目录");
		await click("[data-plume-add-folder]");
		if ((await page<number>(`document.querySelectorAll('[data-plume-source-folder]').length`)) !== 2) throw new Error("重复添加了源目录");
		await click("[data-plume-make-main]");
		await until(
			`document.querySelector('[data-plume-source-folder]').getAttribute('data-plume-source-folder') === ${JSON.stringify(extraSource)}`,
			"切换主文件夹",
		);
		await click("[data-plume-make-main]");
		await capture("smoke-project-sources.png");
		await click("button", "创建项目");
		await until(`document.querySelector('[data-plume-project="冒烟项目"]') !== null`, "项目出现在默认会话列表");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "打开新项目");
		await click('button[aria-label="不在项目中工作"]');
		await until(
			`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent === '想聊点什么？' && document.querySelector('.cm-content')?.textContent.includes('新增一个功能')`,
			"项目切换保留项目外草稿",
		);
		await click("[data-project-trigger]");
		await click("[role=menuitem]", "冒烟项目");
		await until(
			`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('冒烟项目') && document.querySelector('.cm-placeholder') !== null`,
			"返回项目使用独立草稿",
		);
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("项目里的会话");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "项目会话可发送");
		await nativeClick(window, page, "[data-composer-send=send]");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('项目里答了一句。')`, "项目会话有回答");

		const group = '[data-plume-project="冒烟项目"]';
		await click(`${group} button[aria-expanded=true]`);
		const count = `${group} button[aria-expanded=false] > span:last-child`;
		await until(`document.querySelector(${JSON.stringify(count)})?.textContent === '1'`, "折起来的项目显示数目");
		const head = await page<{ x: number; y: number }>(
			`(() => { const rect = document.querySelector(${JSON.stringify(group)}).getBoundingClientRect(); return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2) }; })()`,
		);
		window.webContents.sendInputEvent({ type: "mouseMove", ...head });
		await until(`getComputedStyle(document.querySelector(${JSON.stringify(count)})).opacity === '0'`, "悬停时数目让位给按钮");
		await until(`document.querySelectorAll('[data-plume-project-card-folder]').length === 2`, "项目悬停卡列出全部源目录");
		await capture("smoke-project-collapsed-hover.png");
		window.webContents.sendInputEvent({ type: "mouseMove", x: head.x + 600, y: head.y + 300 });
		await until(`getComputedStyle(document.querySelector(${JSON.stringify(count)})).opacity === '1'`, "移开后数目回来");
		await capture("smoke-project-collapsed-idle.png");
		await click(`${group} button[aria-expanded=false]`);

		const sessionId = await page<string>(`document.querySelector('[data-plume-session]').dataset.plumeSession`);
		await openMenu(sessionId);
		if (await page<boolean>(`[...document.querySelectorAll('${menu} [role^=menuitem]')].some(item => item.textContent.trim() === '对话样式')`))
			throw new Error("会话菜单仍然提供整页渲染器选择");
		await menuItem("置顶");
		await wait(async () => (await agent.sessions()).some((session) => session.id === sessionId && session.pinned === true), "会话置顶");
		await until(`document.querySelector('[data-plume-section="pinned"]') !== null`, "置顶分组显示");
		await openMenu(sessionId);
		await menuItem("取消置顶");

		hang = true;
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("等待停止的一轮");
		await nativeClick(window, page, "[data-composer-send=send]");
		await wait(async () => (await agent.sessions()).some((session) => session.id === sessionId && session.running), "会话开始运行");
		await until(`document.querySelector('.cm-placeholder') !== null`, "已发送的草稿清空");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("排队的下一句");
		nativeEnter(window);
		await until(`document.querySelectorAll('[data-queue-row]:not([data-leaving])').length === 1`, "消息进入本体队列");
		await until(`document.querySelector('.cm-placeholder') !== null`, "排队后输入框清空");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("尚未发送的草稿");
		await nativeClick(window, page, "[data-composer-send=stop]");
		await wait(async () => !(await agent.sessions()).some((session) => session.id === sessionId && session.running), "会话已停止");
		if (!(await page<boolean>(`document.querySelector('[data-queue-row]:not([data-leaving])')?.textContent.includes('排队的下一句')`)))
			throw new Error("停止后排队消息丢失");
		await until(`document.querySelector('.cm-content')?.textContent === '尚未发送的草稿'`, "停止后草稿保留");
		await capture("smoke-conversation-queue-held.png");
		hang = false;
		reply = "排队消息已回复。";
		await nativeClick(window, page, 'button[aria-label="现在就发"]');
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('排队消息已回复。')`, "手动发送排队消息得到回复");
		await until(`document.querySelectorAll('[data-queue-row]:not([data-leaving])').length === 0`, "队列已发送");
		if (!(await page<boolean>(`document.querySelector('.cm-content')?.textContent === '尚未发送的草稿'`))) throw new Error("发送队列改变了输入框草稿");
		await capture("smoke-conversation-host.png");

		// 一轮以完成收尾时，排着的下一句由 agent 当场发出；那一刻上一条回复得已经整段在屏上，不能先冒出问话、回复再在它上面接着长完。
		// 先调一次参数慢慢流的 ls 撑住这一轮好排队，结果回来后回复一次到齐、这一轮随即收尾，正是屏幕还在按节奏放字的时候。
		const answer = "先做完的这一轮，回复要在下一句问话出现之前整段画完。";
		script = (request) => {
			const messages = JSON.stringify(request.messages ?? []);
			if (messages.includes("排队自动发出的一句")) return { text: "自动发出的那句也答了。" };
			if (!messages.includes("toolu_queue_ls"))
				return { toolCalls: [{ id: "toolu_queue_ls", name: "ls", args: { path: "." } }], stream: { chunkSize: 1, delayMs: 150 } };
			return { text: answer };
		};
		await page(`(() => {
			const rows = document.querySelector('[data-plume-transcript-rows]');
			window.__plumeQueueOrder = undefined;
			const observer = new MutationObserver(() => {
				if (!rows.textContent.includes('排队自动发出的一句')) return;
				window.__plumeQueueOrder = { answered: rows.textContent.includes(${JSON.stringify(answer)}) };
				observer.disconnect();
			});
			observer.observe(rows, { childList: true, subtree: true, characterData: true });
		})()`);
		await nativeClick(window, page, "[data-composer-send=send]");
		await wait(async () => (await agent.sessions()).some((session) => session.id === sessionId && session.running), "带工具的一轮开始运行");
		await until(`document.querySelector('.cm-placeholder') !== null`, "草稿发出");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("排队自动发出的一句");
		nativeEnter(window);
		await until(`document.querySelectorAll('[data-queue-row]:not([data-leaving])').length === 1`, "排在带工具的那一轮后面");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('自动发出的那句也答了。')`, "这一轮收尾后自动发出排着的一句");
		const order = await page<{ answered: boolean } | undefined>(`window.__plumeQueueOrder`);
		if (!order?.answered) throw new Error("排着的一句自动发出时，上一条回复还没整段画出来");
		script = undefined;
		// 二、后续会话同组嵌套，折叠后选中会话会展开；置顶后脱离来源，再取消置顶回去。
		await nativeClick(window, page, "[data-screen=chat] [data-plume-quote=assistant] [data-message-fork]");
		await until(`document.querySelector('[data-plume-screen-title]')?.textContent.endsWith('（分叉）')`, "分叉会话打开");
		const forkId = await page<string>(`document.querySelector('[data-plume-session]').dataset.plumeSession`);
		const forkRow = `[data-plume-row="${forkId}"]`;
		await until(`document.querySelector('${forkRow}')?.hasAttribute('data-plume-row-nested')`, "分叉缩在来源下面");
		await click(`[data-plume-row="${sessionId}"] [data-plume-row-fold]`);
		await until(`document.querySelector('[data-plume-row="${sessionId}"] [data-plume-row-folded]')?.textContent === '1'`, "后续会话可收起且不立即弹开");
		window.webContents.send("plume:command", `open-session:${sessionId}`);
		await until(`document.querySelector('[data-plume-session]')?.dataset.plumeSession === '${sessionId}'`, "切回来源");
		window.webContents.send("plume:command", `open-session:${forkId}`);
		await until(`document.querySelector('[data-plume-row="${sessionId}"] [data-plume-row-folded]') === null`, "切到后续会话展开来源");
		await openMenu(forkId);
		await menuItem("置顶");
		await until(
			`document.querySelector('${forkRow}') && !document.querySelector('${forkRow}').hasAttribute('data-plume-row-nested')`,
			"置顶的后续会话独立显示",
		);
		await openMenu(forkId);
		await menuItem("取消置顶");
		await until(`document.querySelector('${forkRow}')?.hasAttribute('data-plume-row-nested')`, "取消置顶恢复嵌套");

		const hover = async (selector: string) => {
			const point = await page<{ x: number; y: number }>(
				`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({ block: 'nearest' }); const box = node.getBoundingClientRect(); return { x: Math.round(box.left + 60), y: Math.round(box.top + box.height / 2) }; })()`,
			);
			window.webContents.sendInputEvent({ type: "mouseMove", x: point.x + 500, y: point.y });
			window.webContents.sendInputEvent({ type: "mouseMove", ...point });
		};
		const theme = nativeTheme.themeSource;
		try {
			for (const mode of ["light", "dark"] as const) {
				nativeTheme.themeSource = mode;
				await hover(`[data-plume-row="${sessionId}"]`);
				await until(`document.querySelector('[data-plume-session-figures]')?.textContent.includes('轮')`, "会话悬停卡加载真实统计");
				await capture(`smoke-sidebar-card-${mode}.png`);
			}
		} finally {
			nativeTheme.themeSource = theme;
		}
		await openMenu(sessionId);
		await until(`document.querySelector('[data-plume-session-card]') === null`, "右键菜单打开时悬停卡消失");
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
		await until(`document.querySelector(${JSON.stringify(menu)}) === null`, "关闭菜单");

		// 三、拖会话只改本项目的次序；项目拖动独立保存，刷新后两者都在。
		await click(`${group} button[aria-label="在「冒烟项目」里新建会话"]`);
		await until(`document.querySelector('[data-screen=empty] .cm-content') !== null`, "新建第二条顶层会话");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("侧栏排序测试");
		await nativeClick(window, page, "[data-composer-send=send]");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('排队消息已回复。')`, "排序会话已创建");
		const secondId = await page<string>(`document.querySelector('[data-plume-session]').dataset.plumeSession`);
		const drag = async (source: string, target: string) => {
			const points = await page<Array<{ x: number; y: number }>>(
				`([${JSON.stringify(source)}, ${JSON.stringify(target)}]).map((selector) => { const node = document.querySelector(selector); node.scrollIntoView({ block: 'nearest' }); const box = node.getBoundingClientRect(); return { x: Math.round(box.left + 60), y: Math.round(box.top + box.height / 3) }; })`,
			);
			const from = points[0]!;
			const to = points[1]!;
			window.webContents.sendInputEvent({ type: "mouseMove", ...from });
			window.webContents.sendInputEvent({ type: "mouseDown", ...from, button: "left", clickCount: 1 });
			window.webContents.sendInputEvent({ type: "mouseMove", x: from.x + 8, y: from.y, button: "left", modifiers: ["leftbuttondown"] });
			window.webContents.sendInputEvent({ type: "mouseMove", ...to, button: "left", modifiers: ["leftbuttondown"] });
			await new Promise((resolve) => setTimeout(resolve, 80));
			window.webContents.sendInputEvent({ type: "mouseUp", ...to, button: "left", clickCount: 1 });
		};
		const ordered = `(() => { const rows = [...document.querySelectorAll('[data-plume-row]:not([data-plume-row-nested])')].map((node) => node.dataset.plumeRow); return rows.indexOf('${sessionId}') < rows.indexOf('${secondId}'); })()`;
		await drag(`[data-plume-row="${sessionId}"] > button`, `[data-plume-row="${secondId}"] > button`);
		// 拖过的那个项目单独切成手动，列表设置的排法不跟着变，别的项目照旧。
		await until(
			`JSON.parse(localStorage.getItem('plume.sidebar.manualProjects') ?? '[]').length === 1 && localStorage.getItem('plume.sidebar.sort') !== 'manual' && ${ordered}`,
			"拖动会话把这个项目切成手动排序",
		);
		await capture("smoke-sidebar-reordered.png");
		pickedFolder = workspace;
		await click('[data-plume-section-action] button[aria-label="新建项目"]');
		await type("[data-plume-project-dialog=create] input", "第二项目");
		await click("[data-plume-add-folder]");
		await click("button", "创建项目");
		await until(`document.querySelector('[data-plume-project="第二项目"]') !== null`, "第二项目出现");
		await drag(`${group} > button`, '[data-plume-project="第二项目"] > button');
		await until(`document.querySelector('[data-plume-project]')?.getAttribute('data-plume-project') === '冒烟项目'`, "项目拖动排序");
		// 等新页面载完再执行脚本：重载途中旧的渲染帧已经销毁，这时 executeJavaScript 会报「Render frame was disposed」。
		const reloaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
		window.webContents.reload();
		await reloaded;
		await until(
			`document.querySelector('[data-plume-project]')?.getAttribute('data-plume-project') === '冒烟项目' && ${ordered}`,
			"刷新后项目和会话手动顺序保留",
		);
		// 四、滚进一个项目里，项目名停在列表顶上：把侧栏的滚动区压矮，滚过项目名 20px 再量。
		const held = await page<{ before: number; after: number }>(`(() => {
			const host = document.querySelector('aside .plume-scroll-host');
			const view = host.querySelector('.plume-scroll-view');
			host.style.flex = 'none';
			host.style.height = '90px';
			const head = document.querySelector('[data-plume-project="冒烟项目"]').closest('[data-plume-head]');
			const before = head.getBoundingClientRect().top - view.getBoundingClientRect().top;
			view.scrollTop += before + 20;
			const after = head.getBoundingClientRect().top - view.getBoundingClientRect().top;
			return { before, after };
		})()`);
		// 毛玻璃下滑到标题底下的那截靠滚动时间线遮掉，等它跟上这次滚动再截图。
		await new Promise((resolve) => setTimeout(resolve, 300));
		await capture("smoke-sidebar-sticky.png");
		await page(`(() => {
			const host = document.querySelector('aside .plume-scroll-host');
			host.querySelector('.plume-scroll-view').scrollTop = 0;
			host.style.flex = '';
			host.style.height = '';
		})()`);
		if (held.before <= 0 || Math.abs(held.after) > 1) throw new Error(`项目名没有吸顶：${JSON.stringify(held)}`);
		window.webContents.send("plume:command", `open-session:${sessionId}`);
		await until(`document.querySelector('[data-plume-session]')?.dataset.plumeSession === '${sessionId}'`, "切回多源项目");
		// 跟在换肤工坊那段后面跑时面板区已经开着（停在「开始」页），没有展开开关可点。
		if (await page<boolean>("document.querySelector('[data-panel-area]')?.inert === true")) await click("[data-panel-toggle] button");
		await click('[data-panel-launch="plume/files"]');
		const extraRoot = `[data-panel]:not([inert]) [data-file-tree] [data-path=${JSON.stringify(extraSource)}]`;
		await until(`document.querySelector(${JSON.stringify(extraRoot)}) !== null`, "文件树列出第二个源目录");
		if (!(await page<boolean>(`document.querySelector(${JSON.stringify(extraRoot)})?.getAttribute('aria-expanded') === 'true'`))) await click(extraRoot);
		const extraFile = `[data-panel]:not([inert]) [data-file-tree] [data-path=${JSON.stringify(join(extraSource, "extra.txt"))}]`;
		await until(`document.querySelector(${JSON.stringify(extraFile)}) !== null`, "文件树列出第二个源目录的文件");
		await capture("smoke-sidebar-files.png");
		await click(extraFile);
		await until(`document.querySelector('[data-panel]:not([inert])')?.textContent.includes('来自第二个源目录')`, "第二源目录文件可预览");

		console.log(
			"PLUME_CONVERSATIONS_SMOKE",
			JSON.stringify({
				projectCountYields: true,
				projectDrafts: true,
				pinned: true,
				queueKept: true,
				queueSent: true,
				sourceFolders: true,
				fileTree: true,
				hoverCards: true,
				nested: true,
				reorder: true,
				stickyHeads: true,
			}),
		);
	} finally {
		setModel(undefined);
	}
}
