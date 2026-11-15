/**
 * plume.terminal 的界面入口：往面板区加「终端」面板。shell 在逻辑入口那边，面板经 ui.remote() 连过去。
 */

import type { PanelProps, UiPlugin } from "@plume/contract/ui";
import { SquareTerminal } from "@plume/ui/icons";
import xtermCss from "@xterm/xterm/css/xterm.css";
import { useEffect, useState } from "react";
import type { TerminalApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import type { DirectoryRequest } from "./open-directory.ts";
import terminalCss from "./terminal.css";
import { TerminalPane } from "./TerminalPane.tsx";

/**
 * 宿主不加载插件的样式表，这里自己挂一份；xterm 是自己打包的，样式表也带自己那一版。按插件名认那个元素：
 * 更新后重新加载时换掉内容，不叠一份。停用后留着也无妨：没有终端面板时这些类名没人用。
 */
function mountStyles(): void {
	const id = "plume.terminal";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = `${xtermCss}\n${terminalCss}`;
}

export default {
	name: "plume.terminal",
	apply(ui) {
		mountStyles();
		const api = ui.remote<TerminalApi>();
		/*
		 * 窗口拿到焦点时让逻辑入口重读 Windows 的注册表环境：装完 Node 从安装程序切回来，下一个终端标签就有 `node`。
		 * 读不读、多久读一次由逻辑入口定，这里每次都说一声。没读成不要紧，下个标签用上一次的环境，所以不报错。
		 */
		const refreshEnv = () => void api.refreshEnv().catch(() => undefined);
		window.addEventListener("focus", refreshEnv);
		ui.effect(() => window.removeEventListener("focus", refreshEnv));
		ui.terminalOpener(async (directory, sessionId) => {
			ui.openPanel("terminal", sessionId);
			await api.openDirectory(sessionId, directory);
		});
		// 已有终端就切过去在那里执行，没有才新开一个；shell 准备好以后才写进去。
		ui.terminalRunner(async (command, sessionId) => {
			ui.openPanel("terminal", sessionId);
			await api.runCommand(sessionId, command);
		});
		// 没有会话时目录为空，shell 起在主目录。
		function TerminalPanel({ session, cwd, ...tab }: PanelProps) {
			const sessionId = session?.summary.id;
			const [request, setRequest] = useState<DirectoryRequest | null>(null);
			useEffect(() => {
				if (!sessionId) return;
				let stopped = false;
				const call = api.watchDirectory(sessionId);
				void (async () => {
					try {
						for await (const next of call) setRequest(next);
					} catch (error) {
						if (!stopped) ui.notify(String(error), "error");
					}
				})();
				return () => {
					stopped = true;
					call.cancel();
				};
			}, [sessionId]);
			return (
				<TerminalPane
					api={api}
					cwd={cwd ?? session?.summary.cwd ?? ""}
					directoryRequest={request}
					takeDirectory={async (id) => (sessionId ? await api.takeDirectory(sessionId, id) : false)}
					onDirectoryError={(error) => ui.notify(String(error), "error")}
					links={{
						// 文件边界按会话算：没有会话时路径都不认。
						find: async (path) => (sessionId ? await ui.findFile(path, sessionId) : null),
						openUrl: (url, external) =>
							void (external ? ui.openExternal(url) : ui.openLink(url, sessionId)).catch((error) => ui.notify(String(error), "error")),
						openFile: (path) => {
							if (sessionId) void ui.openFile(path, sessionId).catch((error) => ui.notify(String(error), "error"));
						},
					}}
					droppedPaths={(transfer) => ui.droppedPaths(transfer)}
					{...tab}
				/>
			);
		}
		ui.panel("terminal", TerminalPanel, {
			title: (locale) => MESSAGES[locale].title,
			description: (locale) => MESSAGES[locale].description,
			icon: SquareTerminal,
			// 系统和编辑器里开关终端的通用键位；焦点在终端里按它就收起面板区。
			shortcut: "Control+`",
			// 排在别的面板后面：插件自己的面板（计划之类）和会话直接相关，先看到它们。
			order: 10,
			// 一个标签一个 shell。
			multiple: true,
			restore: true,
			detachable: true,
		});
	},
} satisfies UiPlugin;
