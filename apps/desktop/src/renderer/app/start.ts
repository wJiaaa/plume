import type { AgentService } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import { translate } from "@plume/ui";
import { FileText, Folder } from "@plume/ui/icons";
import { notify } from "../toast/index.ts";
import { appendConversationDraft, conversationDraftTarget } from "../plugin-navigation.ts";
import { connectModels, settingsView, subscribeModels } from "../models/store.ts";
import { connectPluginHost, registerHostPanel } from "../plugins.tsx";
import { connectFiles, setFileOpener, setFileMovedHandler, setFileRemovedHandler, movedPath, shownPath } from "../files/open-file.ts";
import { connectLiveSessions } from "../session-live.ts";
import { startMarket, usePluginDisplayName } from "../market/store.ts";
import { check as checkUpdates } from "../update/store.ts";
import { sessionWindows } from "../session-windows.ts";
import { agent, connectAgent, draftScope, errorText, panelWindow, sessionWindow, setDraft, state, update, useAppPick, useChrome } from "./state.ts";
import { follow, heldView, openNew, select } from "./sessions.ts";
import { closeTab, openFileTab, panelScope, persistTabs, removeTab, scopeOf, setTabs, showPanel, tabsOf, togglePanel } from "./panels.ts";
import { openSessionFor, pluginDraft, quoteInPanel } from "./actions.ts";
import { PluginConversation } from "./Chat.tsx";
import { ProjectFilePanel, ProjectFiles } from "./PanelArea.tsx";

export function start(service: Remote<AgentService>): void {
	connectAgent(service);
	connectModels(service);
	connectLiveSessions(service, heldView);
	connectFiles(service);
	setFileOpener(openFileTab);
	setFileMovedHandler((from, to) => {
		const panelTabs = Object.fromEntries(
			Object.entries(state.panelTabs).map(([scope, layout]) => [
				scope,
				{
					...layout,
					tabs: layout.tabs.map((tab) => (tab.file ? { ...tab, file: { ...tab.file, path: movedPath(tab.file.path, from, to) } } : tab)),
				},
			]),
		);
		update({ panelTabs });
		persistTabs(panelTabs);
	});
	setFileRemovedHandler((paths) => {
		for (const [scope, layout] of Object.entries(state.panelTabs)) {
			const removed = layout.tabs.filter((tab) => {
				const path = shownPath(tab.id) ?? tab.file?.path;
				return path && paths.some((gone) => path === gone || path.startsWith(`${gone}/`) || path.startsWith(`${gone}\\`));
			});
			if (!removed.length) continue;
			const tabs = layout.tabs.filter((tab) => !removed.includes(tab));
			setTabs(scope, tabs.length ? { tabs, active: tabs.some((tab) => tab.id === layout.active) ? layout.active : tabs.at(-1)!.id } : undefined);
			if (panelWindow && removed.some((tab) => tab.id === panelWindow?.tab)) void window.plume.panelWindows.close();
		}
	});
	connectPluginHost({
		openPanel: (key, sessionId, options) => showPanel(key, false, sessionId, options),
		quoteInPanel,
		closePanel: (key, sessionId, only) => {
			const scope = sessionId ? panelScope(sessionId) : scopeOf(state);
			const owner = sessionId && sessionId !== scope ? sessionId : undefined;
			for (const tab of tabsOf(state, scope).tabs) if (tab.panel === key && tab.sessionId === owner && (!only || tab.id === only)) void closeTab(tab.id, scope);
		},
		openConversationDraft: async (options) => {
			const target = conversationDraftTarget(options, state.projects);
			openNew(target);
			const scope = draftScope();
			setDraft(scope, appendConversationDraft(state.drafts[scope], options.text));
		},
		draftInSession: async (sessionId, draft) => {
			// 面板窗口只能交给自己来源的那个会话：主窗口先选中来源会话，再放进它的输入框。不给会话是眼前的输入框。
			if (panelWindow) {
				if (sessionId !== undefined && sessionId !== panelWindow.scope) throw new Error(translate("plugin.mainWindowOnly"));
			} else if (sessionId !== undefined) await openSessionFor(sessionId);
			pluginDraft({ text: draft.text, append: !draft.replace, images: draft.images, send: draft.send });
		},
		openSession: openSessionFor,
		openSettings: (key) => update({ screen: "settings", settingsSection: `plugin:${key}`, drawerOpen: false }),
		openPage: (key) => update({ screen: `page:${key}`, drawerOpen: false }),
		Conversation: PluginConversation,
		useProjects: () => useAppPick((current) => current.projects),
		usePluginDisplayName,
		useSessionModel: () => {
			const { currentId, sessions } = useChrome();
			return sessions.find((summary) => summary.id === currentId)?.model;
		},
		openModelSettings: () => update({ screen: "settings", settingsSection: "models" }),
		queueTask: async (sessionId, instruction) => await agent.queueTask(sessionId, instruction),
	});
	// ⌘P 开文件树，⌥⌘P（Windows、Linux 上 Ctrl+P、Ctrl+Alt+P）开文件本身：同一个字母，加 ⌥ 表示「另一个」。
	registerHostPanel("file", ProjectFilePanel, {
		title: () => translate("dock.fileContents"),
		icon: FileText,
		shortcut: "CommandOrControl+Alt+P",
		multiple: true,
		restore: true,
		detachable: true,
	});
	registerHostPanel(
		"files",
		ProjectFiles,
		{
			title: () => translate("fileTree.projectFiles"),
			icon: Folder,
			shortcut: "CommandOrControl+P",
			restore: true,
			available: ({ cwd, session }) => Boolean(cwd && session),
		},
		true,
	);
	startMarket(service);
	// 模型设置由 models/store.ts 管：哪里改了都经它重新取一次，这里跟着换。
	subscribeModels(() => update({ settings: settingsView() }));
	window.plume.onAgentExit((code) => update({ fatal: translate("app.agentExited", { code }) }));
	window.plume.onFullScreenChange((fullScreen) => update({ fullScreen }));
	window.addEventListener("resize", () => {
		update({ windowWidth: window.innerWidth, windowHeight: window.innerHeight, panelMoving: false });
	});
	window.plume.panelWindows.onChanged(async ({ target, reason }) => {
		if (panelWindow) {
			if (reason === "closing") await closeTab(panelWindow.tab, panelWindow.scope);
			return;
		}
		if (reason === "opened") {
			const panelWindows = [...state.panelWindows.filter((entry) => entry.tab !== target.tab), target];
			const remaining = state.panelTabs[target.scope]?.tabs.some((tab) => !panelWindows.some((entry) => entry.tab === tab.id));
			update({ panelWindows, ...(!remaining && target.scope === scopeOf(state) ? { panelOpen: false } : {}) });
			return;
		}
		if (reason === "closing") return;
		update({ panelWindows: state.panelWindows.filter((entry) => entry.tab !== target.tab) });
		if (reason === "closed") removeTab(target.tab, target.scope);
		else {
			const saved = state.panelTabs[target.scope];
			if (saved) setTabs(target.scope, { ...saved, active: target.tab });
			void select(target.scope).then(() => togglePanel(true));
		}
	});
	if (!panelWindow && !sessionWindow) {
		// 开在独立窗口里的会话：侧栏把它们点亮；那边点「在主窗口中打开」时回到主窗口。
		void window.plume.sessionWindows.list().then((ids) => sessionWindows.set(ids));
		window.plume.sessionWindows.onChanged((ids) => sessionWindows.set(ids));
		window.plume.sessionWindows.onShow((sessionId) => void select(sessionId));
		// 菜单栏图标的菜单和 plume:// 链接（main/tray.ts、main/deep-link.ts）。
		window.plume.onCommand((command) => {
			if (command.startsWith("open-session:")) void select(command.slice("open-session:".length));
			else if (command === "new-session") openNew();
			else if (command === "settings") update({ screen: "settings", drawerOpen: false });
			else if (command === "updates") {
				update({ screen: "settings", settingsSection: "about", drawerOpen: false });
				void checkUpdates(true);
			}
		});
		void window.plume.panelWindows.list().then((panelWindows) => update({ panelWindows }));
		window.plume.panelWindows.onReveal(({ scope, request }) => {
			void select(scope)
				.then(async () => {
					if ("file" in request) await openFileTab(request.file.path, request.file.lines, request.file.sessionId);
					else if ("quote" in request) quoteInPanel(request.quote.panel, request.quote.sessionId, request.quote.quote);
					else if ("draft" in request) pluginDraft(request.draft);
					else showPanel(request.panel, false, request.sessionId ?? scope);
				})
				.catch((error: unknown) => notify(errorText(error), "error"));
		});
	}
	void follow();
}
