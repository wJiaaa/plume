/** 侧栏的两个入口共用会话和插件的现成清单，不另存搜索目录或通知记录。 */
import type { ProjectEntry, SessionSummary } from "@plume/contract";
import { IconButton, useI18n, usePopover } from "@plume/ui";
import { Archive, AtSign, Bell, FolderOpen, FolderPlus, PanelLeft, Pin, PinOff, Search, Settings, SquarePen } from "@plume/ui/icons";
import { createElement, useState } from "react";
import { updateAppearance, useAppearance, useManagedSkin } from "../appearance-settings.ts";
import { listPages, listPanels, listSettingsSections, localized, pageBadge, usePluginUis } from "../plugins.tsx";
import { SETTINGS_GROUPS, type SettingsSection } from "../settings/pages.tsx";
import { notify } from "../toast/index.ts";
import type { SidebarActions } from "./actions.ts";
import { CommandPalette, type PaletteCommand, type PaletteGroup } from "./CommandPalette.tsx";
import { useActivityVersion, activityOf } from "./activity.ts";
import { NotificationsMenu, NoticeDot, type Notice } from "./NotificationsMenu.tsx";
import { ProjectDialog } from "./ProjectDialog.tsx";

export function SidebarTools({
	sessions,
	projects,
	currentId,
	cwd,
	actions,
	openPage,
	openSettings,
	openPanel,
	toggleSidebar,
}: {
	sessions: readonly SessionSummary[];
	projects: readonly ProjectEntry[];
	currentId?: string;
	cwd?: string;
	actions: SidebarActions;
	openPage: (key: string) => void;
	openSettings: (section: SettingsSection) => void;
	openPanel: (key: string) => void;
	toggleSidebar: () => void;
}) {
	const { t, resolvedLocale } = useI18n();
	const [searching, setSearching] = useState(false);
	const [creating, setCreating] = useState(false);
	const bell = usePopover();
	const appearance = useAppearance();
	const managed = useManagedSkin();
	usePluginUis();
	useActivityVersion();
	const projectName = (session: SessionSummary) => projects.find((project) => project.id === session.project)?.name ?? "";
	const icon = (Icon: typeof Settings) => createElement(Icon, { size: 15, strokeWidth: 1.8 });
	const sessionCommands = sessions
		.filter((s) => s.title && !s.parentId && !s.owner && !s.archived)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((s): PaletteCommand => ({
			id: `session:${s.id}`,
			label: s.title,
			meta: projectName(s),
			keywords: [projectName(s)],
			run: () => actions.open(s.id),
		}));
	const current = sessions.find((s) => s.id === currentId && !s.archived);
	const groups: PaletteGroup[] = [
		{
			key: "chat",
			label: t("palette.chat"),
			commands: [
				{
					id: "new-chat",
					label: t("sidebar.newChat"),
					icon: icon(SquarePen),
					run: () => actions.newSession(current?.project ? { project: current.project } : {}),
				},
				...(current
					? [
							{
								id: "pin-current",
								label: t(current.pinned ? "palette.unpinCurrent" : "palette.pinCurrent"),
								icon: icon(current.pinned ? PinOff : Pin),
								run: () => {
									void actions.pin(current.id, !current.pinned).catch((error: unknown) => notify(String(error), "error"));
								},
							},
							{ id: "archive-current", label: t("palette.archiveCurrent"), icon: icon(Archive), run: () => actions.archive(current.id) },
						]
					: []),
			],
		},
		{
			key: "go",
			label: t("palette.goTo"),
			commands: [
				...listPages().map((page) => ({
					id: `page:${page.key}`,
					label: localized(page.title, resolvedLocale),
					...(page.icon ? { icon: createElement(page.icon, { size: 15 }) } : {}),
					run: () => openPage(page.key),
				})),
				{ id: "go-plugins", icon: icon(AtSign), label: t("market.title"), run: () => openPage("market") },
				{ id: "go-settings", label: t("sidebar.settings"), icon: icon(Settings), run: () => openSettings("general") },
				{ id: "toggle-sidebar", label: t("palette.toggleSidebar"), icon: icon(PanelLeft), shortcut: "CmdOrCtrl+B", run: toggleSidebar },
			],
		},
		{
			key: "panels",
			label: t("toolbar.panels"),
			commands: listPanels(cwd, currentId !== undefined)
				.filter((panel) => panel.listed)
				.map((panel) => ({
					id: `panel:${panel.key}`,
					label: localized(panel.title, resolvedLocale),
					keywords: [panel.key, t("toolbar.panels")],
					...(panel.icon ? { icon: createElement(panel.icon, { size: 15 }) } : {}),
					run: () => openPanel(panel.key),
				})),
		},
		{
			key: "theme",
			label: t("appearance.theme"),
			commands: managed
				? []
				: (["light", "dark", "system"] as const).map((theme) => ({
						id: `theme-${theme}`,
						label: t(theme === "system" ? "common.system" : theme === "light" ? "appearance.light" : "appearance.dark"),
						keywords: [t("appearance.theme"), theme],
						checked: (appearance.theme ?? "system") === theme,
						run: () => updateAppearance({ theme }),
					})),
		},
		{
			key: "projects",
			label: t("common.project"),
			onQuery: true,
			commands: [
				...projects.map((project) => ({
					id: `project:${project.id}`,
					label: project.name,
					meta: t("projectHead.newSession"),
					icon: icon(FolderOpen),
					run: () => actions.newSession({ project: project.id }),
				})),
				{ id: "new-project", label: t("project.new"), icon: icon(FolderPlus), run: () => setCreating(true) },
			],
		},
		{
			key: "settings",
			label: t("sidebar.settings"),
			onQuery: true,
			commands: [
				...SETTINGS_GROUPS.flatMap((group) =>
					group.items.map((item) => ({
						id: `settings:${item.id}`,
						label: t(item.label),
						keywords: [t("sidebar.settings"), t(group.label)],
						meta: t("sidebar.settings"),
						icon: createElement(item.icon, { size: 15 }),
						run: () => openSettings(item.id),
					})),
				),
				...listSettingsSections().map((item) => ({
					id: `settings:plugin:${item.key}`,
					label: localized(item.title, resolvedLocale),
					keywords: [t("sidebar.settings")],
					run: () => openSettings(`plugin:${item.key}`),
				})),
			],
		},
	];
	const order = ["waiting", "failed", "done"];
	const notices: Notice[] = sessions
		.filter((s) => !s.parentId && !s.owner && !s.archived && s.id !== currentId)
		.flatMap((s) => {
			const state = activityOf(s.id);
			return state
				? [{ id: s.id, state, title: s.title || t("sessionOps.newSession"), project: projectName(s), updatedAt: s.updatedAt, run: () => actions.open(s.id) }]
				: [];
		})
		.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || b.updatedAt - a.updatedAt);
	const pageNotices = listPages().flatMap((page): Notice[] => {
		const badge = pageBadge(page.key);
		return badge?.attention ? [{ id: page.key, state: "failed", title: localized(badge.label, resolvedLocale), run: () => openPage(page.key) }] : [];
	});
	const top = notices[0]?.state ?? (pageNotices.length ? "failed" : undefined);
	return (
		<>
			<IconButton
				size="composer"
				label={t("sidebar.search")}
				expanded={searching}
				onClick={() => setSearching(true)}
				icon={<Search size={15} strokeWidth={1.9} />}
			/>
			<span className="relative">
				<IconButton size="composer" label={t("sidebar.notifications")} expanded={bell.open} onClick={bell.toggle} icon={<Bell size={15} strokeWidth={1.9} />} />
				<NoticeDot top={top} />
			</span>
			{bell.open && <NotificationsMenu anchor={bell.anchor} notices={[...notices, ...pageNotices]} onClose={bell.close} />}
			{searching && (
				<CommandPalette
					sessions={{ key: "sessions", label: t("palette.sessions"), commands: sessionCommands }}
					groups={groups}
					onClose={() => setSearching(false)}
				/>
			)}
			{creating && <ProjectDialog actions={actions} onClose={() => setCreating(false)} />}
		</>
	);
}
