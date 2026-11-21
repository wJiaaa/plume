import { ErrorBoundary, IconButton, Overlay, Scroller, useI18n } from "@plume/ui";
import { ChevronRight, X } from "@plume/ui/icons";
import { useEffect } from "react";
import { layoutMode } from "../layout.ts";
import { notify } from "../toast/index.ts";
import { listSettingsSections, localized, usePluginUis } from "../plugins.tsx";
import { PageHeader } from "../settings/layout.tsx";
import { ModelSettings } from "../settings/models/ModelSettings.tsx";
import { ArchivedSettings } from "../settings/ArchivedSettings.tsx";
import { AboutSettings, AppearanceSettings, GeneralSettings, SettingsNav, useSettingsSectionName } from "../settings/pages.tsx";
import { AgentsSettings } from "../settings/agents.tsx";
import { PersonalizationSettings } from "../settings/personalization.tsx";
import { StorageSettings } from "../settings/StorageSettings.tsx";
import { errorText, update, useChrome } from "./state.ts";
import { openModelsSection } from "./actions.ts";
import { select } from "./sessions.ts";
import { CARD_DRAG, NO_DRAG } from "./shell-classes.ts";

/**
 * 设置浮层：盖在当前界面（对话、市场、插件的页面）上的一张大卡片，底下的界面原样留着，关掉就回到它。
 * 左边章节列表，右边顶上一行面包屑和关闭，下面是这一章：900px 一列居中，章节内容见 settings/pages.tsx。
 *
 * 遮罩、Escape、焦点圈在卡片里、进出场都是 `Overlay` 的；遮罩用磨砂（`frosted`），底下的界面退成背景。
 * 设置里再弹的对话框叠在它上面一层，仍是普通的压暗。
 * 卡片铺满窗口的八成五高、最宽 1280px，换章节时大小不变，不跟着内容一跳一跳。
 *
 * 整章滚动的滚动面铺满右边、一列放在它里面，滑块贴着卡片右沿，而不是这一列的右沿。模型页是左右两个窗格各自滚动，
 * 整章不再套一层滚动（否则一屏两个滚动条，外层会把窗格的标题从内容上方推走），所以它占满高度、自己滚。
 */
export function SettingsDialog() {
	const { t } = useI18n();
	const { settingsSection, windowWidth, sessions, projects } = useChrome();
	const compact = layoutMode(windowWidth) === "compact";
	const selfScrolling = settingsSection === "models";
	const name = useSettingsSectionName(settingsSection);
	const close = () => update({ settingsOpen: false });
	const page = (
		<div
			data-screen="settings"
			data-section={settingsSection}
			className={`mx-auto w-full max-w-[900px] pt-6 ${selfScrolling ? "flex min-h-0 flex-1 flex-col pb-6" : "pb-12"} ${compact ? "px-4" : "px-8"}`}
		>
			{settingsSection === "general" && <GeneralSettings projects={projects} />}
			{settingsSection === "appearance" && <AppearanceSettings />}
			{settingsSection === "personalization" && <PersonalizationSettings />}
			{settingsSection === "models" && <ModelSettings />}
			{settingsSection === "agents" && <AgentsSettings onOpenModelSettings={openModelsSection} />}
			{settingsSection === "storage" && <StorageSettings />}
			{settingsSection === "about" && <AboutSettings />}
			{settingsSection === "archived" && (
				<ArchivedSettings
					sessions={sessions}
					projects={projects}
					onOpen={(sessionId) => {
						// 换上会话（写了 `screen`）时浮层自己收起，见 state.ts 的 `update`。
						update({ screen: "chat" });
						void select(sessionId);
					}}
					onError={(error) => notify(errorText(error), "error")}
				/>
			)}
			{settingsSection.startsWith("plugin:") && <PluginSettingsSection id={settingsSection.slice("plugin:".length)} />}
		</div>
	);
	return (
		<Overlay onClose={close} width={1280} label={t("sidebar.settings")} frosted>
			{(dismiss) => (
				<div data-settings-dialog="" className="flex h-[85dvh] max-h-[960px] min-h-0 bg-shell">
					<aside className={`flex shrink-0 flex-col border-r border-line bg-sidebar ${compact ? "w-14" : "w-52"}`}>
						<SettingsNav section={settingsSection} compact={compact} onPick={(section) => update({ settingsSection: section })} />
					</aside>
					<div className="flex min-w-0 flex-1 flex-col">
						{/* macOS 上这一行能拖窗口：遮罩盖住了窗口顶上那一条，设置开着时也得有地方拖。Windows、Linux 上那一条带子被遮罩盖住，不另给。 */}
						<header className={`flex h-12 shrink-0 items-center gap-3 border-b border-line pr-2 pl-5 ${CARD_DRAG}`}>
							<div className="flex min-w-0 items-center gap-1.5 text-label select-none">
								<span className="shrink-0 text-ink-muted">{t("sidebar.settings")}</span>
								{name && (
									<>
										<ChevronRight size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" aria-hidden />
										<span className="truncate font-medium text-ink">{name}</span>
									</>
								)}
							</div>
							<div className={`ml-auto flex shrink-0 items-center ${NO_DRAG}`}>
								<IconButton label={t("settings.close")} icon={<X size={15} strokeWidth={1.8} />} onClick={() => dismiss()} data-settings-close="" />
							</div>
						</header>
						{selfScrolling ? page : <Scroller className="flex-1">{page}</Scroller>}
					</div>
				</div>
			)}
		</Overlay>
	);
}

/** 插件加的设置分区：页头（`detail` 那段介绍）由产品画，下面是插件的组件。插件停用、卸下时回到「常规」。 */
function PluginSettingsSection({ id }: { id: string }) {
	const { resolvedLocale } = useI18n();
	usePluginUis();
	const entry = listSettingsSections().find((section) => section.key === id);
	useEffect(() => {
		if (!entry) update({ settingsSection: "general" });
	}, [entry]);
	if (!entry) return null;
	return (
		<>
			<PageHeader title={localized(entry.title, resolvedLocale)} intro={entry.detail === undefined ? undefined : localized(entry.detail, resolvedLocale)} />
			<ErrorBoundary key={entry.key}>
				<entry.component />
			</ErrorBoundary>
		</>
	);
}
