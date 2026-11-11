/**
 * 渲染进程入口：把共享模块交出去、连上 agent 进程、加载插件的界面入口、画产品界面。
 */

import type { AgentService } from "@plume/contract";
import type { ScreenCaptureSession, ScreenRect } from "@plume/contract/ui";
import type { Appearance, AppearancePatch } from "../shared/appearance.ts";
import type { MarketResult, MarketState, PluginUpdateState } from "../shared/market.ts";
import type { OpenTarget } from "../shared/open-targets.ts";
import { type Remote, RpcChannel, remote } from "@plume/rpc";
import * as plumeStyles from "@plume/styles";
import * as plumeUi from "@plume/ui";
import { ErrorBoundary, I18nProvider, installTooltips, setWindowMinimized, type UiLocale, useI18n } from "@plume/ui";
import * as React from "react";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import { App, start } from "./app.tsx";
import { applyFontSmoothing, readFontSmoothing } from "./appearance.ts";
import { applyAppearance } from "./appearance-settings.ts";
import { useLocaleSetting } from "./locale.ts";
import { installChipCopy } from "./markdown/copy-chips.ts";
import { loadPluginUis, usePluginUis } from "./plugins.tsx";
import { PinnedShotHost, ScreenOverlayHost, screenWindow } from "./screen.tsx";

declare global {
	interface Window {
		plume: {
			platform: string;
			/** 应用版本，取自安装包。 */
			version: string;
			panelWindows: import("../shared/panel-window.ts").PanelWindowsBridge;
			sessionWindows: import("../shared/session-window.ts").SessionWindowsBridge;
			/** 窗口底层是不是系统材质：是的话外壳铺半透明底色，见 app.tsx。 */
			vibrancy: boolean;
			/** 启动时的外观设置，没校验过，用前过 cleanAppearance。之后的变化在 renderer/appearance-settings.ts 里。 */
			appearance: unknown;
			saveAppearance(patch: AppearancePatch): Promise<Appearance>;
			onAppearanceChanged(listener: (appearance: Appearance) => void): void;
			/** 宿主皮肤的暂态深浅模式，按当前窗口登记，不写用户偏好。 */
			setThemeOverride(mode: "system" | "light" | "dark" | null): Promise<void>;
			/** 启动时的界面语言设置，没校验过；之后的变化在 renderer/locale.ts 里。 */
			locale: unknown;
			saveLocale(locale: UiLocale): Promise<void>;
			/** 「运行期间不让电脑休眠」，存盘和系统声明都在主进程（main/keep-awake.ts）。 */
			keepAwake: {
				get(): boolean;
				set(on: boolean): Promise<void>;
			};
			chatBackground: {
				/** 选图或导入拖入的图片；取消是 null，失败返回 error，成功返回主进程文件名。 */
				pick(title?: string): Promise<{ name: string } | { error: "too-large" | "invalid" | "failed" } | null>;
				import(bytes: Uint8Array, name: string): Promise<{ name: string } | { error: "too-large" | "invalid" | "failed" }>;
				read(name: string): Promise<Uint8Array | null>;
				remove(): Promise<void>;
			};
			registerShared(exports: Record<string, string[]>): Promise<void>;
			connect(): void;
			pickFolder(title?: string): Promise<string | undefined>;
			/** 供应商导入导出要写、要读的文件路径；取消是 undefined。文件本身由 agent 进程读写。 */
			providerFile: {
				save(title: string, name: string): Promise<string | undefined>;
				open(title: string): Promise<string | undefined>;
			};
			/** 导出会话记录要写到哪；取消是 undefined。文件由 agent 进程另存。 */
			sessionsExportPath(title: string, name: string, format?: "database" | "markdown"): Promise<string | undefined>;
			/** 在默认浏览器里打开，只认 http(s)。 */
			captureWindow(rect: { x: number; y: number; width: number; height: number }): Promise<string>;
			openExternal(url: string): Promise<void>;
			/** `openExternal` 交给的那个浏览器叫什么；查不到是空串。 */
			defaultBrowser(): Promise<string>;
			/** 附件用的系统操作，见 main/files.ts。路径不限在项目里。 */
			files: {
				pickReference(directory: boolean): Promise<string | undefined>;
				/** Markdown 文档的 HTTPS 图片，主进程限时限量读取，不携带浏览器 Cookie。 */
				remoteImage(url: string): Promise<string | null>;
				/** 一个 File 在磁盘上的位置；不是文件（剪贴板里的截图）时是空串。 */
				pathFor(file: File): string;
				exists(path: string): Promise<boolean>;
				/** 用默认应用打开；直接打开会运行它时改成在文件夹里指出来（`revealed`）。 */
				open(path: string): Promise<"opened" | "revealed" | "failed">;
				reveal(path: string): Promise<void>;
				/** 用「默认文件打开目标」那一类的目标打开（main/open-targets.ts）；认不出的 id 同 `open`。 */
				openIn(target: string, path: string): Promise<"opened" | "revealed" | "failed">;
				/** 这台机器上能选的打开目标，第一项是 reveal。 */
				targets(): Promise<OpenTarget[]>;
				copyText(text: string): Promise<void>;
				readText(): Promise<string>;
				/** `data:` URL 的图片按 PNG 进剪贴板；解不出图是 false。 */
				copyImage(dataUrl: string): Promise<boolean>;
			};
			/** 托管图片的受限路径和系统定位。 */
			media: {
				path(name: string): Promise<string | null>;
				reveal(name: string): Promise<boolean>;
			};
			/** 插件市场，见 main/market.ts。 */
			market: {
				read(): Promise<MarketState>;
				install(id: string): Promise<MarketResult>;
				installFolder(dir: string): Promise<MarketResult>;
				uninstall(id: string): Promise<MarketResult>;
				update(ids?: string[]): Promise<PluginUpdateState>;
				setAutoUpdate(auto: boolean): Promise<PluginUpdateState>;
				readme(id: string): Promise<string | null>;
				readmeImage(id: string, path: string): Promise<string | null>;
				openFolder(id: string): Promise<void>;
				onChanged(listener: (state: PluginUpdateState) => void): void;
			};
			/** 应用更新，见 main/update/updates.ts 和 renderer/update/。 */
			updates: {
				check(force?: boolean): Promise<import("../shared/update.ts").UpdateInfo>;
				state(): Promise<import("../shared/update.ts").UpdatePhase>;
				download(version: string): Promise<import("../shared/update.ts").UpdatePhase>;
				pause(): Promise<import("../shared/update.ts").UpdatePhase>;
				cancel(): Promise<import("../shared/update.ts").UpdatePhase>;
				relaunch(): Promise<boolean>;
				open(url: string): Promise<boolean>;
				onProgress(listener: (phase: import("../shared/update.ts").UpdatePhase) => void): () => void;
			};
			/** 主进程叫界面做的事，见 shared/app-command.ts；只有主窗口订阅。 */
			onCommand(listener: (command: import("../shared/app-command.ts").AppCommand) => void): void;
			onAgentExit(listener: (code: number) => void): void;
			onFullScreenChange(listener: (full: boolean) => void): void;
			onMinimizedChange(listener: (minimized: boolean) => void): void;
			/** Windows、Linux 上系统画在页面右上角那几颗按钮的底色和符号色（`#rrggbb`），见 renderer/window-overlay.ts。 */
			setWindowOverlay(colors: { color: string; symbolColor: string }): void;
			/** 截屏，见 main/screenshot/ 和 renderer/screen.tsx。 */
			screen: {
				start(): Promise<boolean>;
				setShortcut(plugin: string, accelerator: string | null): Promise<"ok" | "taken" | "invalid">;
				pickDirectory(title: string): Promise<string | null>;
				desktopDirectory(): Promise<string>;
				onSession(listener: (session: ScreenCaptureSession) => void): void;
				onEscape(listener: () => void): void;
				onHidden(listener: () => void): void;
				ready(session: number): void;
				finish(png?: string): Promise<void>;
				cancel(): void;
				pin(png: string, at: ScreenRect): Promise<void>;
				copy(png: string): Promise<void>;
				passThrough(on: boolean): void;
			};
			pin: {
				request(): Promise<{ src: string; width: number; height: number } | null>;
				ready(): void;
				close(): void;
				dragStart(): void;
				dragMove(dx: number, dy: number): void;
			};
		};
	}
	var __PLUME_SHARED__: Record<string, object>;
}

/** 键必须和 index.html 里 import map 的键一致。 */
const shared: Record<string, object> = { react: React, "react/jsx-runtime": jsxRuntime, "@plume/ui": plumeUi, "@plume/styles": plumeStyles };

function connect(): Promise<MessagePort> {
	return new Promise((resolve) => {
		const onMessage = (event: MessageEvent) => {
			if (event.source !== window || event.data !== "plume:port" || !event.ports[0]) return;
			window.removeEventListener("message", onMessage);
			resolve(event.ports[0]);
		};
		window.addEventListener("message", onMessage);
		window.plume.connect();
	});
}

async function boot(): Promise<void> {
	globalThis.__PLUME_SHARED__ = shared;
	await window.plume.registerShared(Object.fromEntries(Object.entries(shared).map(([name, module]) => [name, Object.keys(module)])));
	const port = await connect();
	const channel = new RpcChannel({
		post: (message) => port.postMessage(message),
		listen: (listener) => {
			const handler = (event: MessageEvent) => listener(event.data);
			port.addEventListener("message", handler);
			port.start();
			return () => port.removeEventListener("message", handler);
		},
	});
	const agent = remote<AgentService>(channel);
	// 先装好插件卡片再画，免得已有会话先画成通用卡片再跳成插件卡片。
	await loadPluginUis(await agent.listPlugins(), agent);
	const root = createRoot(document.getElementById("root") as HTMLElement);
	// 截屏浮层和钉图窗口也是这一页，只画插件注册的那一个组件。
	const kind = screenWindow();
	if (kind) {
		void followScreenPluginUis(agent);
		root.render(<ScreenRoot kind={kind} />);
		return;
	}
	start(agent);
	root.render(<Root agent={agent} />);
}

function Root({ agent }: { agent: Remote<AgentService> }) {
	return (
		<ErrorBoundary>
			<I18nProvider locale={useLocaleSetting()}>
				<LocaleSync agent={agent} />
				<App />
			</I18nProvider>
		</ErrorBoundary>
	);
}

/** 截屏浮层会常驻但不启动会话事件流，也要收回停用或热重载的界面入口。 */
async function followScreenPluginUis(agent: Remote<AgentService>): Promise<void> {
	while (true) {
		try {
			const stream = agent.watch();
			await loadPluginUis(await agent.listPlugins(), agent);
			for await (const event of stream) {
				if (event.type === "plugins") await loadPluginUis(event.plugins, agent);
			}
		} catch (error) {
			console.error("截屏窗口插件事件流中断：", error);
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
}

function ScreenRoot({ kind }: { kind: "overlay" | "pin" }) {
	usePluginUis();
	return (
		<ErrorBoundary>
			<I18nProvider locale={useLocaleSetting()}>{kind === "overlay" ? <ScreenOverlayHost /> : <PinnedShotHost />}</I18nProvider>
		</ErrorBoundary>
	);
}

/** agent 进程给人看的报错、提示也要换语言：解析出的语言一变就告诉它。 */
function LocaleSync({ agent }: { agent: Remote<AgentService> }) {
	const { resolvedLocale } = useI18n();
	useEffect(() => {
		agent.setLocale(resolvedLocale).catch((error: unknown) => console.error("没能把界面语言告诉 agent 进程：", error));
	}, [agent, resolvedLocale]);
	return null;
}

// 外观偏好先于连 agent 进程生效，界面一画出来就是对的。
applyFontSmoothing(readFontSmoothing());
applyAppearance();
// 悬停提示认 data-plume-tip，整个文档装一次；最小化时 JS 驱动的动画放慢、停住。
installTooltips();
installChipCopy();
window.plume.onMinimizedChange(setWindowMinimized);
void boot();
