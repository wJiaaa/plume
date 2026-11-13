import { DURATION, ErrorBoundary, motionReduced, Scroller, useI18n } from "@plume/ui";
import { useEffect, useLayoutEffect, useRef } from "react";
import { layoutMode, sidebarWidthFor } from "../layout.ts";
import { notify } from "../toast/index.ts";
import { listSettingsSections, localized, usePluginUis } from "../plugins.tsx";
import { PageHeader } from "../settings/layout.tsx";
import { ModelSettings } from "../settings/models/ModelSettings.tsx";
import { ArchivedSettings } from "../settings/ArchivedSettings.tsx";
import { AboutSettings, AppearanceSettings, GeneralSettings } from "../settings/pages.tsx";
import { AgentsSettings } from "../settings/agents.tsx";
import { PersonalizationSettings } from "../settings/personalization.tsx";
import { StorageSettings } from "../settings/StorageSettings.tsx";
import { errorText, update, useChrome } from "./state.ts";
import { openModelsSection } from "./actions.ts";
import { select } from "./sessions.ts";

/**
 * 设置页的正文：900px 一列居中，章节内容见 settings/pages.tsx。整页滚动的滚动面铺满窗格、一列放在它里面，
 * 滑块贴着窗格右沿，而不是这一列的右沿。
 * 模型页是左右两个窗格各自滚动，整页不再套一层滚动（否则一屏两个滚动条，外层会把窗格的标题从内容上方推走），
 * 所以它占满高度、自己滚。
 */
export function SettingsScreen() {
	const { settingsSection, windowWidth, sidebarOpen, sidebarWidth, sessions, projects } = useChrome();
	const compact = layoutMode(windowWidth) === "compact";
	const selfScrolling = settingsSection === "models";
	/*
	 * 章节列表开合时，这一列一下子取最终的宽度，之后只跟着平移。列表是靠动画侧栏的宽度把正文推开的，正文每一帧都变宽一点；
	 * 页面里的行按容器查询排（`@md` 起说明和控件并排），窗口窄到这一列在滑动途中跨过断点时，页面在半路重排一次，
	 * 文字也一路跟着重新折行。最终宽度是现在的宽度加减侧栏的宽度；滑动期间这一列可能伸出卡片的边，由滚动面裁掉，
	 * 滑完放开，宽度回到 100%（那时正好相等）。窄窗口里侧栏是盖在正文上的抽屉，不推正文，没什么要定住的。
	 */
	const column = useRef<HTMLDivElement>(null);
	const heldFor = useRef(sidebarOpen);
	useLayoutEffect(() => {
		if (heldFor.current === sidebarOpen) return;
		heldFor.current = sidebarOpen;
		const element = column.current;
		const parent = element?.parentElement;
		if (!element || !parent || compact || motionReduced()) return;
		const style = getComputedStyle(parent);
		const inner = parent.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
		const sidebar = sidebarWidthFor(sidebarWidth, windowWidth);
		element.style.setProperty("--plume-settings-hold", `${inner + (sidebarOpen ? -sidebar : sidebar)}px`);
		const release = () => element.style.removeProperty("--plume-settings-hold");
		// 侧栏滑动用的是 `--plume-t-slow`（见 SLIDE_MOTION 的用处），多留一点余量再放开。
		const timer = window.setTimeout(release, DURATION.slow + 60);
		return () => {
			window.clearTimeout(timer);
			release();
		};
	}, [sidebarOpen, compact, sidebarWidth, windowWidth]);
	const page = (
		<div
			ref={column}
			data-screen="settings"
			data-section={settingsSection}
			className={`mx-auto w-[var(--plume-settings-hold,100%)] max-w-[900px] pt-2 ${selfScrolling ? "flex min-h-0 flex-1 flex-col pb-6" : "pb-16"} ${compact ? "px-4" : "px-9"}`}
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
						update({ screen: "chat" });
						void select(sessionId);
					}}
					onError={(error) => notify(errorText(error), "error")}
				/>
			)}
			{settingsSection.startsWith("plugin:") && <PluginSettingsSection id={settingsSection.slice("plugin:".length)} />}
		</div>
	);
	return selfScrolling ? page : <Scroller className="flex-1">{page}</Scroller>;
}

/** 插件加的设置分区：页头（标题和 `detail` 那段介绍）由产品画，下面是插件的组件。插件停用、卸下时回到「常规」。 */
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
