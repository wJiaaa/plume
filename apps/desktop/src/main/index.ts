/**
 * 主进程：窗口、启动和关闭 agent 进程、把渲染进程的 MessagePort 转交给 agent 进程、选文件夹对话框、外观设置（见 appearance.ts）、
 * 插件市场（读目录、装卸更新，见 market.ts）并用 plume-plugin:// 提供插件文件，菜单栏图标（tray.ts）和 plume:// 链接（deep-link.ts）、应用更新（update/），
 * 以及插件网页（ctx.pages）的那一半（web-pages.ts）。会话、循环、插件逻辑都在 agent 进程里。
 */

import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { RpcChannel, remote, serve } from "@plume/rpc";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	MessageChannelMain,
	nativeTheme,
	Notification,
	shell,
	type OpenDialogOptions,
	type SaveDialogOptions,
	utilityProcess,
	type UtilityProcess,
} from "electron";
import iconPath from "../assets/icon.png?asset";
import type { AppCommand } from "../shared/app-command.ts";
import {
	type AgentProcessApi,
	CATALOG_FILE_ENV,
	type ConnectMessage,
	DATA_DIR_ENV,
	LOCALE_ENV,
	NATIVE_ROOTS_ENV,
	type MainProcessApi,
	PLUGINS_ENV,
	SETTINGS_FILE_ENV,
} from "../shared/protocol.ts";
import type { Appearance } from "../shared/appearance.ts";
import { hasVibrancy, windowChrome } from "../shared/window-chrome.ts";
import { applicationMenuTemplate } from "./app-menu.ts";
import { loadAppearance, registerAppearanceIpc } from "./appearance.ts";
import { sessionFromUrl } from "./deep-link.ts";
import { registerFilesIpc } from "./files.ts";
import { registerMediaFilesIpc } from "./media-files.ts";
import { registerKeepAwake } from "./keep-awake.ts";
import { registerOpenTargetsIpc } from "./open-targets.ts";
import { registerPanelWindowsIpc } from "./panel-windows.ts";
import { registerSessionWindowsIpc } from "./session-windows.ts";
import { loadLocale, registerLocaleIpc, resolvedLocale } from "./locale.ts";
import { announceToWindows, createMarket, registerMarketIpc } from "./market.ts";
import { MARKET_URL } from "./market-remote.ts";
import { plumeHome } from "./home.ts";
import { writePluginCli } from "./plugin-cli.ts";
import { nativeText } from "./i18n.ts";
import { handleProtocols, registerSchemes, sharedExports } from "./protocols.ts";
import { useBundledRipgrep } from "./ripgrep.ts";
import { registerScreenshot } from "./screenshot/index.ts";
import { runSmoke, smokeOutput } from "./smoke.ts";
import { chromeLogins, startChromeLogins } from "./chrome-logins.ts";
import { callPage, guardWebviews, registerWebPages, webSession } from "./web-pages.ts";
import { createNotifications } from "./notifications.ts";
import { createTray, hasTray } from "./tray.ts";
import { registerUpdateIpc } from "./update/updates.ts";
import { reopenMaximized } from "./window-bounds.ts";
import { readWindowState, rememberWindowState } from "./window-state.ts";
import { registerWindowOverlayIpc } from "./window-overlay.ts";

registerSchemes();

// 应用名在任何人问它之前定下。package.json 里只有 name（@plume/desktop），electron-builder.yml 的 productName 不写进去，
// 不设的话 app.getName() 就是 @plume/desktop：应用内更新按它找解出来的 Plume.app 找不到，应用菜单的「关于」「退出」
// 跟着它叫，开发时程序坞写着 Electron。它也决定 userData 的默认目录，所以要在下面改 userData 之前设。
app.setName("Plume");

const smoke = smokeOutput();
if (smoke) process.env.PLUME_HOME = join(smoke.dir, "home");
// 换了数据目录时，Chromium 自己的目录（缓存、localStorage、单实例锁）也跟过去，两份数据才不会互相串。
// 没换时留在系统默认的位置。
if (process.env.PLUME_HOME) app.setPath("userData", join(plumeHome(), "chromium"));
// Windows 的通知、任务栏分组认这个 id；不设时通知挂在 electron.exe 名下，安装包里的快捷方式也对不上。和 electron-builder.yml 的 appId 一致。
if (process.platform === "win32") app.setAppUserModelId("dev.plume.app");

/**
 * 一个数据目录只开一个 Plume，后来的启动都交给已经开着的那个。
 *
 * 关窗口只是收起来（见 hideMainWindow），应用看着像关了，再点图标就会起第二份：两份 agent 进程写同一个 ~/.plume，
 * 同一段会话被两边往里追加，Windows 上通知区域还会多出一排点了没反应的图标。后来的那份什么都还没初始化，
 * 直接 exit；先开的那份收到 second-instance，把窗口拿出来，双击图标看上去就是打开了它。
 */
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => revealMainWindow());

/** 关闭时等 agent 进程收尾的上限，超过就直接结束它。 */
const SHUTDOWN_GRACE_MS = 5_000;

/** 主窗口第一次打开的大小。 */
const WINDOW_DEFAULT = { width: 1100, height: 720 };
/** 再窄界面就放不下：侧栏收成抽屉以后，输入框和发送按钮要排在一行里。 */
const WINDOW_MIN = { width: 380, height: 440 };

/** 主窗口；boot 里建好之前是 undefined。 */
let mainWindow: BrowserWindow | undefined;
/** 主窗口的界面订阅了命令没有（见 sendCommand）。 */
let commandsListening = false;
const pendingCommands: AppCommand[] = [];

/**
 * 叫主窗口的界面做一件事（菜单栏图标的菜单、plume:// 链接），并把窗口拿到前面来。
 *
 * 界面连上 agent、订阅命令之前到的先攒着，订阅了再一起送过去：冷启动时点的菜单、启动应用的那个地址，
 * 在那之前发给页面都会被丢掉，应用只会停在默认的那一页上。
 */
function sendCommand(command: AppCommand): void {
	revealMainWindow();
	if (commandsListening && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("plume:command", command);
	else pendingCommands.push(command);
}

/** 主窗口是人收起来的（关窗口、菜单栏图标）：点 Dock 图标时放回来。截屏藏起来的窗口由截屏自己管（screenshot/overlay.ts）。 */
let putAway = false;

/**
 * 关窗口只是把它收起来，不扔掉：窗口里就是人留下的现场——开着哪个会话、对话滚到哪、没发出去的字、面板里的终端。
 * 退出应用照样走 before-quit。只在有路回来的时候这样：macOS 有 Dock 图标，Windows 有通知区域的图标（见 boot 里的 close）。
 *
 * 全屏的窗口先退出全屏再藏：直接藏，它的那个桌面空间还留着，人对着一个空桌面，看不到应用也不知道怎么回去。
 */
function hideMainWindow(): void {
	const window = mainWindow;
	if (!window || window.isDestroyed()) return;
	putAway = true;
	if (window.isFullScreen()) {
		window.once("leave-full-screen", () => {
			if (!window.isDestroyed()) window.hide();
		});
		window.setFullScreen(false);
		return;
	}
	window.hide();
}

function revealMainWindow(): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}

/**
 * 别的应用经 plume:// 地址点名要打开的会话（见 deep-link.ts）。在 ready 之前就登记：地址就是启动应用的那个时，
 * macOS 在 ready 之前送来，那时还没有窗口，命令先攒着。
 */
app.on("open-url", (event, url) => {
	event.preventDefault();
	const id = sessionFromUrl(url);
	if (id) sendCommand(`open-session:${id}`);
});

app.whenReady().then(boot, (error: unknown) => {
	console.error(error);
	app.exit(1);
});

/**
 * 模型设置放在数据目录的 settings.json（缺省 ~/.plume/settings.json），只有 agent 进程读写；供应商的 API key 由 agent 进程
 * 加密存进同目录的 credentials.json（钥匙是 vault.key），不在 settings.json 里。
 * Magpie 的 Agent 插件（integrations/magpie）按缺省路径找这个文件；~/.plume 这个目录也是 Magpie 判断 Plume
 * 装没装的依据，所以启动时就建好。
 */
async function userSettingsFile(): Promise<string> {
	const dir = plumeHome();
	await mkdir(dir, { recursive: true });
	return join(dir, "settings.json");
}

async function boot(): Promise<void> {
	app.dock?.setIcon(iconPath);
	// 在开任何窗口之前换掉默认菜单，免得哪个窗口带着重载、开发者工具的快捷键出生。只换打包好的，见 app-menu.ts。
	const menu = applicationMenuTemplate({ platform: process.platform, packaged: app.isPackaged });
	if (menu) Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
	// 在派生 agent 进程之前：它带着主进程的环境启动。
	useBundledRipgrep({
		platform: process.platform,
		arch: process.arch,
		packaged: app.isPackaged,
		appPath: app.getAppPath(),
		resourcesPath: process.resourcesPath,
	});
	const dataDir = plumeHome();
	const settingsFile = await userSettingsFile();
	// 插件：从线上市场（market-remote.ts）装进 ~/.plume/plugins 的，本地上传进 ~/.plume/local-plugins 的
	// （冒烟时 PLUME_HOME 在冒烟目录里）。开发版和装好的应用用同一份；同名时谁生效见 market.ts 的 found。
	// 内置插件是仓库的 packages/builtin/，同样随应用放进资源目录。
	const builtinDir = app.isPackaged ? join(process.resourcesPath, "builtin") : resolve(app.getAppPath(), "../../packages/builtin");
	const installDir = join(dataDir, "plugins");
	const uploadDir = join(dataDir, "local-plugins");
	const sdkDir = app.isPackaged ? join(process.resourcesPath, "plugin-sdk") : resolve(app.getAppPath(), "../../packages/sdk/plugin-sdk");
	// 写插件用的命令 ~/.plume/bin/plume-plugin（见 plugin-cli.ts）；写不了不耽误应用本身。
	const cliDir = join(dataDir, "bin");
	const pluginCli =
		app.isPackaged || smoke
			? await writePluginCli(cliDir, sdkDir).catch((error: unknown) => void console.warn(`写不了 plume-plugin 启动脚本：${String(error)}`))
			: undefined;
	const pluginDirs = new Map<string, string>();
	const market = createMarket({
		catalogUrl: MARKET_URL,
		builtinDir,
		installDir,
		uploadDir,
		settingsFile: join(dataDir, "market.json"),
		pluginDirs,
		agent: { addPlugin: async (dir) => await agent.addPlugin(dir), removePlugin: async (key) => await agent.removePlugin(key) },
		announce: announceToWindows,
		log: (message) => console.warn(message),
	});
	const plugins = await market.plugins();
	for (const { key, dir } of plugins) pluginDirs.set(key, dir);
	// agent 在下面才启动；协议处理器只在有请求时调它，那时已经连上了。
	handleProtocols(pluginDirs, join(dataDir, "session-media"), async (sessionId, path) => await agent.filePath(sessionId, path));
	registerMarketIpc(market);
	// 冒烟测试按中文界面找按钮，不跟随系统。
	loadLocale(smoke ? "zh-CN" : undefined);
	registerLocaleIpc();
	registerKeepAwake();
	registerFilesIpc();
	registerMediaFilesIpc(join(dataDir, "session-media"));
	registerOpenTargetsIpc();
	registerUpdateIpc({ offline: Boolean(smoke) });
	// 截屏的宿主能力（浮层、钉图窗口、剪贴板、全局快捷键），要在开主窗口之前登记：它得看着主窗口什么时候关。
	registerScreenshot();
	// 插件的网页（ctx.pages）：页面一出生就要挂上规矩，所以在开窗之前登记。事件推给 agent 进程里的插件。
	registerWebPages({ emit: (plugin, event) => void agent.pageEvent(plugin, event).catch(() => {}) });
	// 从 Chrome 同步登录状态：上次开着就接着同步。冒烟用自己的数据目录，不会开着。
	void startChromeLogins({ session: webSession(), locale: resolvedLocale });

	const child = utilityProcess.fork(join(import.meta.dirname, "agent-process.js"), [], {
		serviceName: "Plume agent",
		stdio: "pipe",
		env: {
			...process.env,
			[DATA_DIR_ENV]: dataDir,
			[SETTINGS_FILE_ENV]: settingsFile,
			[PLUGINS_ENV]: JSON.stringify(plugins),
			// 会在 Plume 开着时被换掉的插件目录；内置插件不在里面。
			[NATIVE_ROOTS_ENV]: JSON.stringify([installDir, uploadDir]),
			[LOCALE_ENV]: resolvedLocale(),
			// 冒烟验证不访问外网，断言的目录值也不能随上游变。
			...(smoke ? {} : { [CATALOG_FILE_ENV]: join(plumeHome(), "model-catalog.json") }),
		},
	});
	child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(prefixLines("[agent] ", chunk)));
	child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(prefixLines("[agent] ", chunk)));
	const agent = connectAgent(child);
	const notifyEvent = createNotifications({
		active: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible() && window.isFocused() && !window.isMinimized()),
		supported: () => !smoke && Notification.isSupported(),
		locale: resolvedLocale,
		create: (options) => new Notification({ ...options, icon: iconPath }),
		open: (id) => sendCommand(`open-session:${id}`),
	});
	const notices = agent.watch();
	void (async () => {
		for await (const event of notices) notifyEvent(event);
	})().catch((error: unknown) => console.warn("系统通知订阅结束：", String(error)));
	child.once("exit", () => notices.cancel());
	let quitting = false;
	child.once("exit", (code) => {
		if (quitting) return;
		console.error(`agent 进程退出，退出码 ${code}`);
		for (const window of BrowserWindow.getAllWindows()) window.webContents.send("plume:agent-exited", code);
	});

	ipcMain.handle("plume:window:capture", async (event, rect: unknown) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window || event.senderFrame !== event.sender.mainFrame || !rect || typeof rect !== "object") throw new Error("Invalid capture source");
		const { x, y, width, height } = rect as Record<string, unknown>;
		if (![x, y, width, height].every((value) => typeof value === "number" && Number.isInteger(value))) throw new Error("Invalid capture rectangle");
		const area = { x: x as number, y: y as number, width: width as number, height: height as number };
		const [w = 0, h = 0] = window.getContentSize();
		if (area.x < 0 || area.y < 0 || area.width < 1 || area.height < 1 || area.x + area.width > w || area.y + area.height > h)
			throw new Error("Capture must stay within this window");
		return (await event.sender.capturePage(area)).toDataURL();
	});
	ipcMain.handle("plume:shared", (_event, exports: Record<string, string[]>) => {
		for (const [specifier, names] of Object.entries(exports)) sharedExports.set(specifier, names);
	});
	ipcMain.on("plume:version", (event) => {
		event.returnValue = app.getVersion();
	});
	ipcMain.on("plume:connect", (event) => {
		const { port1, port2 } = new MessageChannelMain();
		child.postMessage({ t: "connect" } satisfies ConnectMessage, [port1]);
		event.sender.postMessage("plume:port", null, [port2]);
	});
	ipcMain.handle("plume:pick-folder", async (event, title: unknown) => {
		// 冒烟验证没有人点对话框，直接给准备好的工作目录。
		if (smoke) return smoke.workspace;
		const options: OpenDialogOptions = { title: typeof title === "string" ? title : undefined, properties: ["openDirectory", "createDirectory"] };
		const window = BrowserWindow.fromWebContents(event.sender);
		const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		return result.canceled ? undefined : result.filePaths[0];
	});

	// 供应商导入导出的文件由 agent 进程读写（文件里有 key），这里只问用户放在哪、选哪个。
	ipcMain.handle("plume:providers:save-path", async (event, title: unknown, name: unknown) => {
		// 冒烟验证没有人点对话框，固定写进冒烟目录。
		if (smoke) return join(smoke.dir, "providers.json");
		const options: SaveDialogOptions = {
			title: typeof title === "string" ? title : undefined,
			defaultPath: typeof name === "string" ? join(app.getPath("downloads"), basename(name)) : undefined,
			filters: [{ name: "JSON", extensions: ["json"] }],
		};
		const window = BrowserWindow.fromWebContents(event.sender);
		const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
		return result.canceled ? undefined : result.filePath;
	});
	ipcMain.handle("plume:providers:open-path", async (event, title: unknown) => {
		if (smoke) return join(smoke.dir, "providers.json");
		const options: OpenDialogOptions = {
			title: typeof title === "string" ? title : undefined,
			properties: ["openFile"],
			filters: [{ name: "JSON", extensions: ["json"] }],
		};
		const window = BrowserWindow.fromWebContents(event.sender);
		const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		return result.canceled ? undefined : result.filePaths[0];
	});

	// 会话库由 agent 进程另存，这里只问放在哪。
	ipcMain.handle("plume:sessions:save-path", async (event, title: unknown, name: unknown, format: unknown) => {
		const markdown = format === "markdown";
		if (smoke && format === undefined) return join(smoke.dir, "sessions-export.db");
		const options: SaveDialogOptions = {
			title: typeof title === "string" ? title : undefined,
			defaultPath: typeof name === "string" ? join(app.getPath("downloads"), basename(name)) : undefined,
			filters: markdown ? [{ name: "Markdown", extensions: ["md"] }] : [{ name: "SQLite", extensions: ["db"] }],
		};
		const window = BrowserWindow.fromWebContents(event.sender);
		const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
		return result.canceled ? undefined : result.filePath;
	});

	const appearance = loadAppearance();
	registerWindowOverlayIpc();
	registerAppearanceIpc((next) => {
		// 截屏和钉图窗口始终透明，外观只更新主窗口、面板窗口和会话窗口。
		if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
			if (hasVibrancy(process.platform)) window.setVibrancy(next.vibrancy === false ? null : "under-window");
			window.setBackgroundColor(windowColor(next));
		}
		updatePanelAppearance(next);
		sessionWindows.setAppearance(next);
	}, smoke?.file);
	const window = createWindow(Boolean(smoke), appearance);
	mainWindow = window;
	// 不论从哪里放回来（Dock、菜单栏图标、面板窗口收回主窗口），出来了就不再算收起。
	window.on("show", () => {
		putAway = false;
	});
	// 收起来以后要有路回来：macOS 是 Dock，Windows 只有通知区域的图标，图标没建出来时关窗口就是真关、应用随之退出。
	window.on("close", (event) => {
		if (quitting || (process.platform !== "darwin" && !hasTray())) return;
		event.preventDefault();
		hideMainWindow();
	});
	if (process.platform === "darwin") {
		// 系统只恢复应用被藏那一刻可见的窗口，收起来的主窗口要自己放回来。
		app.on("activate", () => {
			if (putAway) revealMainWindow();
		});
	}
	ipcMain.on("plume:command:listening", (event) => {
		if (event.sender !== window.webContents) return;
		commandsListening = true;
		for (const command of pendingCommands.splice(0)) window.webContents.send("plume:command", command);
	});
	// 冒烟的窗口藏着跑，不在人的菜单栏里多出一个图标。
	if (!smoke)
		createTray({ window: () => window, reveal: revealMainWindow, hide: hideMainWindow, send: sendCommand, sessions: async () => await agent.sessions() });
	const sessionWindows = registerSessionWindowsIpc(window, appearance, windowColor);
	const updatePanelAppearance = registerPanelWindowsIpc(window, appearance, windowColor, sessionWindows.sessionOf);
	app.on("window-all-closed", () => app.quit());
	market.start();
	const shutdown = async () => {
		quitting = true;
		market.stop();
		const exited = once(child, "exit");
		await Promise.race([agent.shutdown().then(() => exited), new Promise((done) => setTimeout(done, SHUTDOWN_GRACE_MS))]).catch(() => undefined);
		child.kill();
	};
	app.on("before-quit", (event) => {
		if (quitting) return;
		event.preventDefault();
		void shutdown().finally(() => app.quit());
	});

	if (smoke)
		await runSmoke({
			window,
			agent,
			workspace: smoke.workspace,
			file: smoke.file,
			shutdown,
			plugin: {
				cli: pluginCli,
				// 各段要用的市场插件从线上市场装，和人在「插件市场」里点安装走同一条路。
				install: async (name: string) => {
					const result = await market.install(name);
					if (!result.ok) throw new Error(`market install ${name}: ${result.error === "failed" ? result.message : result.error}`);
				},
				builtinDir,
				installDir,
				uploadDir,
			},
		});
}

/** parentPort 上的 RPC：agent 进程提供插件状态和关闭，主进程给它网页。 */
function connectAgent(child: UtilityProcess) {
	const channel = new RpcChannel({
		post: (message) => child.postMessage(message),
		listen: (listener) => {
			const handler = (message: unknown) => listener(message);
			child.on("message", handler);
			return () => child.off("message", handler);
		},
	});
	// i18n-exempt：主进程和 agent 进程之间的控制通道，关闭原因只进日志。
	child.once("exit", () => channel.close("agent 进程已退出"));
	serve(channel, {
		page: async (plugin, id, method, args) => (method === "chromeLogins" ? await chromeLogins(id) : await callPage(plugin, id, method, args)),
		trash: async (path) => await shell.trashItem(path),
		/*
		 * 会话库打不开（被别的 Plume 占着、更新版本写的）时，界面一直连不上 agent，只会停在加载中。
		 * 什么都离不开它，所以说清楚在哪、为什么，然后退出；文件不动，由人决定怎么处理。冒烟没有人点对话框，只退出。
		 */
		startupFailed: async (path, reason) => {
			const locale = resolvedLocale();
			if (!smoke) dialog.showErrorBox(nativeText(locale, "sessions.unavailableTitle"), nativeText(locale, "sessions.unavailable", { path, reason }));
			app.exit(1);
		},
	} satisfies MainProcessApi);
	return remote<AgentProcessApi>(channel);
}

/**
 * 页面画出来之前、以及快速拖窗口边页面来不及重排时露出来的底色。毛玻璃下必须透明，否则盖住材质；
 * 不透明时和页面的背景色一致（用户挑过就用挑的，否则是 @plume/styles theme.css 的默认 --plume-bg），免得闪一下。
 */
function windowColor(appearance: Appearance): string {
	if (hasVibrancy(process.platform) && appearance.vibrancy !== false) return "#00000000";
	return nativeTheme.shouldUseDarkColors ? (appearance.darkBackground ?? "#171717") : (appearance.lightBackground ?? "#f8f8f8");
}

function createWindow(hidden: boolean, appearance: Appearance): BrowserWindow {
	const saved = readWindowState(WINDOW_MIN);
	const vibrant = hasVibrancy(process.platform) && appearance.vibrancy !== false;
	const window = new BrowserWindow({
		width: saved?.width ?? WINDOW_DEFAULT.width,
		height: saved?.height ?? WINDOW_DEFAULT.height,
		...(saved?.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
		minWidth: WINDOW_MIN.width,
		minHeight: WINDOW_MIN.height,
		title: "Plume",
		icon: iconPath,
		// 页面画出第一帧再显示（见下面的 ready-to-show），不让人看到还没上色的窗口。
		show: false,
		backgroundColor: windowColor(appearance),
		// macOS 窗口底层用系统材质；固定成激活状态，否则别的应用在前面时它会变成一块平的灰。
		...(vibrant ? { vibrancy: "under-window" as const } : {}),
		...(hasVibrancy(process.platform) ? { visualEffectState: "active" as const } : {}),
		// 标题栏由界面自己画（顶行可拖动）：macOS 只留红绿灯，Windows、Linux 由系统把三颗按钮画在页面右上角。
		...windowChrome(process.platform, windowColor(appearance)),
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			sandbox: true,
			contextIsolation: true,
			// 窗口被挡住时照常渲染：Chromium 默认会停掉被遮住窗口的渲染，resize 事件也随之不发，
			// 界面按窗口宽度切换的布局（侧栏推开还是抽屉）就会停在旧的一档；后台跑着的对话也该照常往下画。
			// 最小化时页面自己停掉动画，见下面的 plume:minimized。
			backgroundThrottling: false,
			// 插件的网页（浏览器）画成 <webview>；挂上前由 guardWebviews 拿掉它的 Node、预加载脚本，放进沙箱。
			webviewTag: true,
		},
	});
	guardWebviews(window.webContents);
	rememberWindowState(window, { ...saved, width: saved?.width ?? WINDOW_DEFAULT.width, height: saved?.height ?? WINDOW_DEFAULT.height });
	if (!hidden)
		window.once("ready-to-show", () => {
			// 最大化也会把窗口显示出来；之后的 show 才让它拿到焦点。
			if (reopenMaximized(saved, process.platform)) window.maximize();
			window.show();
		});

	// 原生全屏时红绿灯不画，页面看不到这件事（没有对应的 CSS 或 DOM 信号），由窗口告诉它，好收回顶行左端留的空位。
	// 窗口可能以全屏状态加载页面，所以页面加载完也报一次。
	const reportFullScreen = () => window.webContents.send("plume:fullscreen", window.isFullScreen());
	window.on("enter-full-screen", reportFullScreen);
	window.on("leave-full-screen", reportFullScreen);
	window.webContents.on("did-finish-load", reportFullScreen);
	// 最小化页面也看不到：渲染不节流，页面一直是「可见」的，动画照跑。告诉它，它好停下来。
	const reportMinimized = () => window.webContents.send("plume:minimized", window.isMinimized());
	window.on("minimize", reportMinimized);
	window.on("restore", reportMinimized);

	if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
	else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	return window;
}

function prefixLines(prefix: string, chunk: Buffer): string {
	return `${chunk
		.toString()
		.trimEnd()
		.split("\n")
		.map((line) => prefix + line)
		.join("\n")}\n`;
}
