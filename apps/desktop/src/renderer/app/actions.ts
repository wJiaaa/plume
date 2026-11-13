import { translate } from "@plume/ui";
import { notify } from "../toast/index.ts";
import { sessionReferences } from "../composer/SessionReferences.tsx";
import type { DraftAttachment } from "../composer/attachments/read.ts";
import type { DraftQuote } from "../conversation/quote.ts";
import { seedChildQuote } from "../conversation/child-drafts.ts";
import type { SettingsSection } from "../settings/pages.tsx";
import { projectSessions } from "../sidebar/grouping.ts";
import type { SidebarActions } from "../sidebar/actions.ts";
import { agent, draftScope, errorText, focusComposer, panelWindow, sessionWindow, setDraft, state, update } from "./state.ts";
import { openNew, select } from "./sessions.ts";
import { panelScope, scopeOf, showPanel, tabsOf } from "./panels.ts";

/**
 * 提示条上「新开一个对话来排查」：在当前项目里开一个空白对话，把错误写成一段草稿，不发出去——问不问由人定。
 * 空白页的草稿按项目留着，那里已经写了东西就接在后面，不覆盖。
 */
export function investigate(message: string): void {
	const project = state.projects.find((entry) => entry.id === (state.view?.summary.project ?? state.target.project));
	openNew(project ? { project: project.id } : {});
	const prompt = [
		translate("toaster.investigate"),
		"",
		translate("toaster.errorLabel"),
		message,
		...(project ? ["", translate("toaster.project", { name: project.name })] : []),
	].join("\n");
	const scope = draftScope();
	const held = state.drafts[scope]?.trim();
	setDraft(scope, held ? `${held}\n\n${prompt}` : prompt);
}

/** 把项目里还列在侧栏上的会话都归档。一个一个来：每次都要改同一份会话索引。出错只提示，不往外抛。 */
async function archiveProject(projectId: string): Promise<void> {
	const targets = projectSessions(state.sessions, projectId);
	if (targets.length === 0) return;
	try {
		for (const session of targets) await agent.setSessionArchived(session.id, true);
		notify(translate("workspace.archived", { n: targets.length }));
	} catch (error) {
		notify(translate("workspace.archiveFailed", { reason: errorText(error) }), "error");
	}
}

/** 侧栏上的动作。出错写进提示条，侧栏不等结果。 */
export const sidebarActions: SidebarActions = {
	open: (sessionId) => void select(sessionId),
	newSession: openNew,
	// 建好就在里面开第一段对话：刚建的项目是空的，人建它就是要在里面做事。
	createProject: (name, path, folders) =>
		void agent
			.createProject(name, path, folders)
			.then((project) => openNew({ project: project.id }))
			.catch((error: unknown) => notify(errorText(error), "error")),
	stats: async (id) => await agent.sessionStats(id),
	reorderProjects: async (source, target, placement) => await agent.reorderProjects(source, target, placement),
	reorderSessions: async (project, ids) => await agent.reorderProjectSessions(project, ids),
	updateProject: (projectId, name, path, folders) =>
		void agent.updateProject(projectId, name, path, folders).catch((error: unknown) => notify(errorText(error), "error")),
	// 先把它的聊天归档，再忘掉登记：归档失败只提示，登记照样删掉——项目还挂着才是人要删的那件事没办成。
	removeProject: (projectId) =>
		void archiveProject(projectId)
			.then(async () => await agent.removeProject(projectId))
			.catch((error: unknown) => notify(errorText(error), "error")),
	archiveProject: (projectId) => void archiveProject(projectId),
	archive: (sessionId, archived = true) => void agent.setSessionArchived(sessionId, archived).catch((error: unknown) => notify(errorText(error), "error")),
	rename: async (sessionId, title) => {
		await agent.renameSession(sessionId, title);
	},
	pin: async (sessionId, pinned) => {
		await agent.setSessionPinned(sessionId, pinned);
	},
	unread: async (sessionId, unread) => {
		await agent.setSessionUnread(sessionId, unread);
	},
	move: async (sessionId, projectId) => {
		await agent.moveSessionProject(sessionId, projectId);
	},
	export: async (sessionId, format) => {
		const title = state.sessions.find((session) => session.id === sessionId)?.title || translate("sessionOps.newSession");
		// 标题不是路径；按最严的文件名规则清洗，也不把表情截成半个。
		let name = title
			.replace(/\s+/g, " ")
			.replace(/[\u0000-\u001f\u007f]/g, "")
			.replace(/[<>:\x22/\\|?*]/g, "_")
			.trim();
		name =
			Array.from(name)
				.slice(0, 120)
				.join("")
				.replace(/[. ]+$/, "") || translate("sessionOps.newSession");
		if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) name = `_${name}`;
		const markdown = format === "markdown";
		const file = await window.plume.sessionsExportPath(
			translate(markdown ? "sessionMenu.exportMarkdown" : "sessionMenu.exportRecords"),
			`${name}.${markdown ? "md" : "db"}`,
			format,
		);
		if (!file) return;
		await agent.exportSession(sessionId, file, format);
		notify(translate(markdown ? "sessionMenu.markdownExported" : "sessionMenu.recordsExported"), "info", { reveal: file });
	},
	newWindow: openInNewWindow,
	revokeSteward: async (sessionId) => {
		await agent.revokeSteward(sessionId);
	},
};

function openInNewWindow(sessionId: string): void {
	void window.plume.sessionWindows.open(sessionId).catch((error: unknown) => notify(errorText(error), "error"));
}

/**
 * 插件往输入框里放字（`ui.draftInSession`）：`append` 时接在后面、图片作为附件挂上，不然换掉草稿。
 * `send` 时输入框原本是空的就直接发出去。面板窗口里没有输入框：交给主窗口，放进来源会话的。
 */
export function pluginDraft(draft: {
	text: string;
	append: boolean;
	images: { data: string; mimeType: string; name?: string; from?: string }[];
	send?: boolean;
}): void {
	if (panelWindow) {
		void window.plume.panelWindows.reveal({ draft }).catch((error: unknown) => notify(errorText(error), "error"));
		return;
	}
	const scope = draftScope(state.view);
	// 只在输入框原本是空的时候直接发：人写了一半的话不能被一起发出去，那时照草稿落进去，等人自己发。
	const send =
		draft.send &&
		draft.text.trim() &&
		!(state.drafts[scope] ?? "").trim() &&
		!state.appended[scope]?.length &&
		!state.restored[scope]?.length &&
		!state.quotes[scope]?.length &&
		!sessionReferences(scope).length &&
		!state.draftAttachments[scope]?.length;
	const files = draft.images.map((image): DraftAttachment => ({
		id: crypto.randomUUID(),
		name: image.name ?? translate("composer.regionShot"),
		mimeType: image.mimeType,
		kind: "image",
		data: image.data,
		isText: false,
		...(image.from ? { from: image.from } : {}),
	}));
	update((now) => {
		const current = now.drafts[scope] ?? "";
		const text = draft.append && current.trim() ? `${current.trimEnd()}\n\n${draft.text}` : draft.text;
		return {
			drafts: { ...now.drafts, [scope]: text },
			...(files.length > 0 ? { appended: { ...now.appended, [scope]: [...(now.appended[scope] ?? []), ...files] } } : {}),
		};
	});
	if (send) update({ autoSend: scope });
	focusComposer();
}

/**
 * 插件要把一个会话摆到人面前（`ui.draftInSession`、`ui.revealToolCall`）：换到对话屏、选中它，等它读完。打不开时抛错。
 * 面板窗口里没有转录和输入框，不接这件事。
 */
export async function openSessionFor(sessionId: string): Promise<void> {
	if (panelWindow) throw new Error(translate("plugin.mainWindowOnly"));
	if (!state.sessions.some((session) => session.id === sessionId)) throw new Error(translate("plugin.sessionGone"));
	await select(sessionId);
	if (state.currentId !== sessionId) throw new Error(translate("plugin.sessionGone"));
}

export function quoteInPanel(key: string, sessionId: string, quote: DraftQuote): void {
	if (panelWindow || sessionWindow) {
		void window.plume.panelWindows.reveal({ quote: { panel: key, sessionId, quote } }).catch((error: unknown) => notify(errorText(error), "error"));
		return;
	}
	if (!state.sessions.some((session) => session.id === sessionId)) return;
	const scope = panelScope(sessionId);
	const layout = tabsOf(state, scope);
	const current = state.screen === "chat" && state.panelOpen && scopeOf(state) === scope ? layout.tabs.find((tab) => tab.id === layout.active) : undefined;
	const reuse = current?.panel === key && !state.panelWindows.some((entry) => entry.tab === current.id);
	const tab = reuse ? current.id : crypto.randomUUID();
	seedChildQuote(tab, quote);
	showPanel(key, false, sessionId, { tab });
}

/** 「智能体」页里「还没有模型」那一行：去设置 › 模型。 */
export function openModelsSection(): void {
	update({ settingsSection: "models" });
}

/** 插件详情里「设置」一节的入口：去设置里那一节。 */
export function openSettingsSection(section: SettingsSection): void {
	update({ screen: "settings", settingsSection: section });
}

/** 市场的「新建插件」：开一个新对话，输入框里放好点名写插件技能的 `/plume-plugin `，人接着说想要什么插件。 */
export function createPlugin(): void {
	tryPrompt("/plume-plugin ");
}

/** 开一个新对话，输入框里放好这句话，由人来发。 */
export function tryPrompt(prompt: string): void {
	openNew();
	setDraft(draftScope(), prompt);
	focusComposer();
}
