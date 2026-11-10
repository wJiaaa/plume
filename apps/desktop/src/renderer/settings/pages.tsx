/**
 * 设置页：章节表、章节导航和各页内容。
 *
 * 常规页只放 Plume 已接通的项。
 */

import { type ReactNode, useState, useSyncExternalStore } from "react";
import type { ProjectEntry } from "@plume/contract";
import { ProjectLayerCards } from "./ProjectOverrideNotice.tsx";
import { readFontSmoothing, setFontSmoothing } from "../appearance.ts";
import { Blocks, type Icon, Info, Layers, Palette, Settings2 } from "../icons.tsx";
import { resetAppearancePatch } from "../../shared/appearance.ts";
import { CodeAppearanceSettings } from "./code-appearance-settings.tsx";
import { ActionSpinner, Button, ErrorBoundary, InlineSelect, Input, LOCALE_OPTIONS, type MessageKey, Scroller, type UiLocale, useI18n } from "@plume/ui";
import { Archive, Bot, CircleCheck, CloudDownload, FolderOpen, HardDrive, Languages, RefreshCw, Sparkles, Tag, WifiOff } from "@plume/ui/icons";
import { setLocaleSetting, useLocaleSetting } from "../locale.ts";
import { tokenValue, updateAppearance, useAppearance, useDark, useManagedSkin } from "../appearance-settings.ts";
import { ColorRow, PixelField, PRESETS, Slider, ThemePreview } from "./appearance-controls.tsx";
import { RetrySettings } from "./RetrySettings.tsx";
import { Card, PageHeader, Row, Segmented, SectionTitle, Toggle } from "./controls.tsx";
import { listPageSettingsSections, listSettingsSections, localized, type SettingsSectionEntry, usePluginUis } from "../plugins.tsx";
import { modelsAgent, refreshModels, settingsView, subscribeModels } from "../models/store.ts";
import { setTranscriptPrefs, useTranscriptPrefs } from "../conversation/prefs.ts";
import { setHideEmptiedProjects, useHideEmptiedProjects } from "../sidebar/prefs.ts";
import { setOpenTarget, targetLabel, useOpenTarget, useOpenTargets } from "../files/open-targets.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import appIcon from "../../assets/app-icon.png";
import { notesForLocale } from "../update/notes-locale.ts";
import { check as checkUpdates, setCheckInterval, useCheckInterval, useUpdate } from "../update/store.ts";
import { UpdateDialog } from "../update/UpdateDialog.tsx";
import { labelFor, publishedOn } from "../update/view.ts";

/** `plugin:<插件名>/<id>` 是插件经 `ui.settingsSection` 加的那几节。 */
export type SettingsSection = "general" | "appearance" | "personalization" | "models" | "agents" | "storage" | "about" | "archived" | `plugin:${string}`;

export const SETTINGS_GROUPS: { label: MessageKey; items: { id: SettingsSection; label: MessageKey; icon: Icon }[] }[] = [
	{
		label: "settings.group.basic",
		items: [
			{ id: "general", label: "settings.general", icon: Settings2 },
			{ id: "appearance", label: "settings.appearance", icon: Palette },
			{ id: "personalization", label: "settings.personalization", icon: Sparkles },
			{ id: "models", label: "settings.models", icon: Layers },
		],
	},
	{
		label: "settings.group.agent",
		items: [
			// 只在有插件往这一页里画东西时列出来，见 SettingsNav。
			{ id: "agents", label: "settings.agents", icon: Bot },
		],
	},
	{
		label: "settings.group.data",
		items: [{ id: "storage", label: "settings.storage", icon: HardDrive }],
	},
	{
		// 只有插件的分区（工作树），见 SettingsNav。
		label: "settings.group.vcs",
		items: [],
	},
	{
		label: "settings.group.about",
		items: [
			{ id: "about", label: "settings.about", icon: Info },
			{ id: "archived", label: "settings.archived", icon: Archive },
		],
	},
];

/** 章节列表：分组标题 12px 最浅色，条目一律正文色，选中和悬停同一层底。 */
export function SettingsNav({ section, compact, onPick }: { section: SettingsSection; compact: boolean; onPick: (section: SettingsSection) => void }) {
	const { t, resolvedLocale } = useI18n();
	usePluginUis();
	// 插件的分区按 `group` 进组：不给的排在「基本」组最后，`agent` 排在「智能体」后面，`data` 排在「存储」前面，`vcs` 自成一组。
	const pluginItems = (group: SettingsSectionEntry["group"]) =>
		listSettingsSections()
			.filter((entry) => entry.group === group)
			.map((entry) => ({ id: `plugin:${entry.key}` as SettingsSection, text: localized(entry.title, resolvedLocale), icon: entry.icon ?? Blocks }));
	const groups = SETTINGS_GROUPS.map((group, index) => {
		const own = group.items.map((item) => ({ ...item, text: t(item.label) }));
		if (index === 0) return { ...group, items: [...own, ...pluginItems(undefined)] };
		if (group.label === "settings.group.agent") return { ...group, items: [...own, ...pluginItems("agent")] };
		if (group.label === "settings.group.data") return { ...group, items: [...pluginItems("data"), ...own] };
		if (group.label === "settings.group.vcs") return { ...group, items: pluginItems("vcs") };
		return { ...group, items: own };
	}).filter((group) => group.items.length > 0);
	return (
		<nav aria-label={t("settings.sections")} className="flex min-h-0 flex-1 flex-col">
			<Scroller className="flex-1" contentClassName={`pb-3 ${compact ? "px-3" : "px-2"}`}>
				{groups.map((group, index) => (
					<div key={group.label} className={`flex flex-col gap-1 ${index > 0 ? "mt-4" : ""}`}>
						<div className="px-2.5 pb-1 text-caption font-medium text-ink-faint">{t(group.label)}</div>
						{group.items.map((item) => (
							<button
								key={item.id}
								type="button"
								aria-current={section === item.id ? "page" : undefined}
								onClick={() => onPick(item.id)}
								className={`flex w-full items-center gap-2 rounded-field px-2.5 text-left text-label text-ink transition ${compact ? "h-10" : "h-8"} ${
									section === item.id ? "bg-card-hover" : "hover:bg-card-hover"
								}`}
							>
								<item.icon size={16} />
								{item.text}
							</button>
						))}
					</div>
				))}
			</Scroller>
		</nav>
	);
}

function Page({ title, intro, children, className = "gap-9" }: { title: string; intro?: string; children: ReactNode; className?: string }) {
	return (
		<>
			<PageHeader title={title} intro={intro} />
			<div className={`flex flex-col ${className}`}>{children}</div>
		</>
	);
}

export function GeneralSettings({ projects }: { projects: readonly ProjectEntry[] }) {
	const { resolvedLocale, t } = useI18n();
	const locale = useLocaleSetting();
	const resolvedName = LOCALE_OPTIONS.find((option) => option.value === resolvedLocale);
	const settings = useSyncExternalStore(subscribeModels, settingsView);
	const mode = settings?.permissionMode ?? "auto";
	const transcript = useTranscriptPrefs();
	const hideEmptied = useHideEmptiedProjects();
	const [keepAwake, setKeepAwake] = useState(window.plume.keepAwake.get);
	const opener = useOpenTarget();
	const targets = useOpenTargets();
	const openers = targets.some((target) => target.id === opener.id) ? targets : [...targets, opener];
	usePluginUis();
	const pluginRows = listPageSettingsSections("general");
	return (
		<Page title={t("settings.general")}>
			<ProjectLayerCards projects={projects} />
			<Card>
				<Row
					title={
						<span className="flex items-center gap-2">
							<Languages size={15} strokeWidth={1.8} className="text-ink-muted" />
							{t("language.title")}
						</span>
					}
					detail={t("language.detail")}
					control={
						<InlineSelect
							value={locale}
							onChange={(value: UiLocale) => setLocaleSetting(value)}
							ariaLabel={t("language.title")}
							options={LOCALE_OPTIONS.map((option) => ({
								value: option.value,
								label: t(option.label),
								detail: option.value === "system" && resolvedName ? `${t("language.systemDetected")} · ${t(resolvedName.label)}` : undefined,
								icon: <LocaleMark value={option.value} mark={option.mark} />,
							}))}
						/>
					}
				/>
			</Card>
			<section>
				<SectionTitle>{t("general.permissions")}</SectionTitle>
				<Card>
					{/* 一句陈述而不是开关：读当前工作区是 agent 的底线，一个拨不动的开关只会招来一次证明它没用的点击。 */}
					<Row
						title={t("general.defaultPermission")}
						detail={t("general.defaultPermissionDetail")}
						control={<span className="text-label text-ink-faint">{t("general.alwaysEnabled")}</span>}
					/>
					<Row
						title={t("general.autoReview")}
						detail={t("general.autoReviewDetail")}
						control={
							<Toggle
								checked={mode !== "ask"}
								onChange={(on) =>
									void modelsAgent()
										.setPermissionMode(on ? "auto" : "ask")
										.then(refreshModels)
								}
								ariaLabel={t("general.autoReview")}
							/>
						}
					/>
					<Row
						title={t("general.fullAccess")}
						detail={t("general.fullAccessDetail")}
						control={
							<Toggle
								checked={mode === "full"}
								onChange={(on) =>
									void modelsAgent()
										.setPermissionMode(on ? "full" : "auto")
										.then(refreshModels)
								}
								ariaLabel={t("general.fullAccess")}
							/>
						}
					/>
				</Card>
			</section>
			{/* 智能标题总结是内置插件经 `page: "general"` 画进来的一行，下一步建议是市场插件，开关就是它的启用、停用。 */}
			<section>
				<SectionTitle>{t("general.section")}</SectionTitle>
				<Card>
					<Row
						title={t("general.fileTarget")}
						detail={t("general.fileTargetDetail")}
						control={
							<InlineSelect
								// 存的值可能是这台机器没有的应用（在别处选的）：照样显示选的那个，不跳。
								value={opener.id}
								onChange={setOpenTarget}
								ariaLabel={t("general.fileTarget")}
								options={openers.map((target) => ({
									value: target.id,
									label: targetLabel(target),
									icon: target.icon ? (
										<img src={target.icon} alt="" className="size-4.5 shrink-0 rounded-sm" />
									) : target.id === "reveal" ? (
										// 不是应用，没有图标可借；一列应用里唯独它没图标，读起来像缺了图标而不是另一种东西。
										<FolderOpen size={16} strokeWidth={1.8} className="mx-px shrink-0 text-ink-muted" />
									) : undefined,
								}))}
							/>
						}
					/>
					{settings && (
						<Row
							title={t("general.thinking")}
							detail={t("general.thinkingDetail")}
							control={
								<Segmented
									value={settings.thinking}
									onChange={(thinking) => void modelsAgent().setDefaultThinking(thinking).then(refreshModels)}
									options={[
										{ value: "off", label: t("thinking.off") },
										{ value: "low", label: t("thinking.low") },
										{ value: "medium", label: t("thinking.medium") },
										{ value: "high", label: t("thinking.high") },
									]}
								/>
							}
						/>
					)}
					<Row
						title={t("general.showThinking")}
						detail={t("general.showThinkingDetail")}
						control={
							<Toggle checked={transcript.showThinking} onChange={(on) => setTranscriptPrefs({ showThinking: on })} ariaLabel={t("general.showThinking")} />
						}
					/>
					{pluginRows.map((entry) => (
						<Row
							key={entry.key}
							title={localized(entry.title, resolvedLocale)}
							{...(entry.detail ? { detail: localized(entry.detail, resolvedLocale) } : {})}
							control={
								<ErrorBoundary>
									<entry.component />
								</ErrorBoundary>
							}
						/>
					))}
					<Row
						title={t("general.hideEmptiedProjects")}
						detail={t("general.hideEmptiedProjectsDetail")}
						control={<Toggle checked={hideEmptied} onChange={setHideEmptiedProjects} ariaLabel={t("general.hideEmptiedProjects")} />}
					/>
					<Row
						title={t("general.keepAwake")}
						// 说明里写明合盖不算：合盖动作归系统电源策略管，见 main/keep-awake.ts。
						detail={t("general.keepAwakeDetail")}
						control={
							<Toggle
								checked={keepAwake}
								onChange={(on) => {
									setKeepAwake(on);
									void window.plume.keepAwake.set(on);
								}}
								ariaLabel={t("general.keepAwake")}
							/>
						}
					/>
					<Row
						title={t("general.platform")}
						detail={t("general.platformDetail")}
						control={<span className="text-label text-ink-faint">{window.plume.platform}</span>}
					/>
				</Card>
			</section>
			{settings && <RetrySettings policy={settings.retryPolicy} />}
		</Page>
	);
}

export function AppearanceSettings() {
	const { t } = useI18n();
	const appearance = useAppearance();
	const managedSkin = useManagedSkin();
	const dark = useDark();
	const [fontSmoothing, setSmoothing] = useState(readFontSmoothing);
	const mac = window.plume.platform === "darwin";

	const theme = managedSkin?.mode ?? appearance.theme ?? "system";
	// 数据皮肤管理时只读当前 token；未管理时用户覆盖优先，切深浅或皮肤更新都会重读。
	const accent = (!managedSkin && appearance.accent) || tokenValue("accent");
	const background = (!managedSkin && (dark ? appearance.darkBackground : appearance.lightBackground)) || tokenValue("bg");
	const foreground = (!managedSkin && (dark ? appearance.darkForeground : appearance.lightForeground)) || tokenValue("fg");
	const contrast = (managedSkin ? undefined : appearance.contrast) ?? Math.round(Number(tokenValue("contrast")) * 100);
	// 字体栈当草稿编辑：清空的那一刻不能把默认值塞回框里，否则没法从头打一个。
	const [uiFont, setUiFont] = useState<string | null>(null);

	return (
		<Page title={t("settings.appearance")}>
			{managedSkin && (
				<Card data-managed-skin="">
					<Row
						title={t("appearance.currentSkin")}
						detail={<span className="text-caption">{t("appearance.skinManaged")}</span>}
						control={<span className="text-label text-ink">{managedSkin.name}</span>}
					/>
				</Card>
			)}
			<section data-appearance-theme="" data-readonly={managedSkin !== undefined}>
				<SectionTitle>{t("appearance.theme")}</SectionTitle>
				<div className="grid grid-cols-3 gap-3">
					{(["system", "light", "dark"] as const).map((value) => (
						<button
							key={value}
							type="button"
							// 三张卡片是一排单选：选中的只靠一圈描边表示，读屏要靠 aria-pressed 才听得出是哪张。
							aria-pressed={theme === value}
							disabled={managedSkin !== undefined}
							onClick={() => updateAppearance({ theme: value })}
							className={`rounded-lg border p-1.5 text-center transition-all duration-[var(--plume-t-base)] ${
								theme === value ? "border-ink ring-1 ring-ink" : "border-line hover:border-ink-faint"
							}`}
						>
							<ThemePreview variant={value} accent={accent} />
							<span className="mt-2 mb-1 block text-label text-ink">
								{t(({ system: "common.system", light: "appearance.light", dark: "appearance.dark" } as const)[value])}
							</span>
						</button>
					))}
				</div>
			</section>
			<section>
				<SectionTitle>{dark ? t("appearance.darkTheme") : t("appearance.lightTheme")}</SectionTitle>
				<Card>
					<div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
						<span className="text-label text-ink-muted">{t(managedSkin ? "appearance.currentSkin" : "appearance.preset")}</span>
						<div className="flex gap-1.5">
							{managedSkin ? (
								<span className="text-label text-ink">{managedSkin.name}</span>
							) : (
								PRESETS.map((preset) => (
									<button
										key={preset.id}
										type="button"
										title={preset.label}
										aria-label={preset.label}
										onClick={() => updateAppearance(preset.patch)}
										className="size-6 rounded-full border border-line transition-transform hover:scale-110"
										style={{ background: preset.patch.accent ?? undefined }}
									/>
								))
							)}
						</div>
					</div>
					<ColorRow
						readOnly={managedSkin !== undefined}
						label={t("appearance.accent")}
						value={accent}
						onChange={(value) => updateAppearance({ accent: value })}
					/>
					<ColorRow
						readOnly={managedSkin !== undefined}
						label={t("appearance.background")}
						value={background}
						onChange={(value) => updateAppearance(dark ? { darkBackground: value } : { lightBackground: value })}
					/>
					<ColorRow
						readOnly={managedSkin !== undefined}
						label={t("appearance.foreground")}
						value={foreground}
						onChange={(value) => updateAppearance(dark ? { darkForeground: value } : { lightForeground: value })}
					/>
					<Row
						title={t("appearance.uiFont")}
						control={
							<Input
								className="plume-field w-[220px]"
								value={uiFont ?? appearance.uiFont ?? tokenValue("font-sans")}
								onBlur={() => setUiFont(null)}
								aria-label={t("appearance.uiFont")}
								onChange={(event) => {
									setUiFont(event.target.value);
									updateAppearance({ uiFont: event.target.value.trim() || null });
								}}
							/>
						}
					/>
					<Row
						title={t("appearance.contrast")}
						control={
							<div data-appearance-contrast="" data-readonly={managedSkin !== undefined} className="flex items-center gap-3">
								{!managedSkin && (
									<Slider value={contrast} onChange={(value) => updateAppearance({ contrast: value })} min={0} max={100} label={t("appearance.contrast")} />
								)}
								<span className="min-w-[2.2em] shrink-0 text-right font-mono text-label whitespace-nowrap text-ink tabular-nums">{contrast}</span>
							</div>
						}
					/>
				</Card>
			</section>
			<CodeAppearanceSettings appearance={appearance} patch={updateAppearance} />
			<section>
				<SectionTitle>{t("appearance.preferences")}</SectionTitle>
				<Card data-appearance-preferences="" className="[&_[data-settings-row]>div:first-child>.text-ink-muted]:text-caption">
					<Row
						title={t("appearance.pointerCursor")}
						detail={t("appearance.pointerCursorDetail")}
						control={
							<Toggle
								checked={appearance.pointerCursor ?? false}
								onChange={(pointerCursor) => updateAppearance({ pointerCursor })}
								ariaLabel={t("appearance.pointerCursor")}
							/>
						}
					/>
					<Row
						title={t("appearance.reduceMotion")}
						detail={t("appearance.reduceMotionDetail")}
						control={
							<Segmented
								value={appearance.reduceMotion ?? "system"}
								onChange={(reduceMotion) => updateAppearance({ reduceMotion })}
								options={[
									{ value: "system", label: t("common.system") },
									{ value: "on", label: t("common.on") },
									{ value: "off", label: t("common.off") },
								]}
							/>
						}
					/>
					<Row
						title={t("appearance.uiScale")}
						detail={t("appearance.uiScaleDetail")}
						control={
							<PixelField
								value={appearance.uiFontSize ?? Number.parseFloat(tokenValue("ui-size"))}
								min={11}
								max={20}
								onChange={(uiFontSize) => updateAppearance({ uiFontSize })}
								label={t("appearance.uiScale")}
								name="uiFontSize"
							/>
						}
					/>
					<Row
						title={t("appearance.diffMarks")}
						detail={t("appearance.diffMarksDetail")}
						control={
							<Segmented
								value={appearance.diffMarkers ?? "color"}
								onChange={(diffMarkers) => updateAppearance({ diffMarkers })}
								options={[
									{ value: "color", label: t("appearance.colour") },
									{ value: "symbols", label: "+/-" },
								]}
							/>
						}
					/>
					{/* 只有 macOS 的文字渲染认 -webkit-font-smoothing，其他平台切了也看不出变化。 */}
					{mac && (
						<Row
							title={t("appearance.fontSmoothing")}
							detail={t("appearance.fontSmoothingDetail")}
							control={
								<Toggle
									checked={fontSmoothing}
									onChange={(on) => {
										setSmoothing(on);
										setFontSmoothing(on);
									}}
									ariaLabel={t("appearance.fontSmoothing")}
								/>
							}
						/>
					)}
					{window.plume.vibrancy && (
						<Row
							title={t("appearance.vibrancy")}
							detail={t("appearance.vibrancyDetail")}
							control={
								<Toggle checked={appearance.vibrancy ?? true} onChange={(vibrancy) => updateAppearance({ vibrancy })} ariaLabel={t("appearance.vibrancy")} />
							}
						/>
					)}
					<Row
						title={t("appearance.resetDefaults")}
						detail={t("appearance.resetDefaultsDetail")}
						control={
							<Button
								size="sm"
								data-appearance-reset=""
								onClick={() => {
									updateAppearance(resetAppearancePatch(appearance));
									setFontSmoothing(false);
									setSmoothing(false);
									setUiFont(null);
								}}
							>
								{t("common.restore")}
							</Button>
						}
					/>
				</Card>
			</section>
		</Page>
	);
}

/**
 * 关于 Plume：哪个版本、是不是最新的、改了什么：头图里是图标、名字、版本和状态，旁边是检查更新和「立即更新」，
 * 下面是发布页；再往下是自动检查的间隔和运行环境，最后是更新内容（按界面语言挑那一段，见 update/notes-locale.ts）。
 */
export function AboutSettings() {
	const { t, resolvedLocale } = useI18n();
	const { info, phase, checking } = useUpdate();
	const interval = useCheckInterval();
	const [dialog, setDialog] = useState(false);
	const available = Boolean(info?.available);
	const notes = info?.notes ? notesForLocale(info.notes, resolvedLocale) : "";
	const status = !info
		? { tone: "text-ink-faint", icon: <ActionSpinner size={12} />, text: t("update.reading") }
		: available
			? { tone: "text-accent", icon: <CloudDownload size={13} strokeWidth={2} aria-hidden />, text: labelFor(phase, info.latest, t) }
			: info.checked
				? { tone: "text-ok", icon: <CircleCheck size={13} strokeWidth={2} aria-hidden />, text: t("about.latest") }
				: { tone: "text-ink-faint", icon: <WifiOff size={13} strokeWidth={2} aria-hidden />, text: t("about.offline") };
	return (
		<Page title={t("about.title")} intro={t("about.intro")} className="gap-6">
			{/* 头图：应用图标、名字、版本和是不是最新，检查更新在右边，发布页在下面。 */}
			<section data-plume-about="" className="about-hero relative overflow-hidden rounded-lg px-6 pt-6 pb-5">
				<div className="flex flex-wrap items-center gap-5">
					<img src={appIcon} alt="" width={68} height={68} draggable={false} className="about-hero-icon shrink-0 rounded-2xl" />
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
							<h2 className="text-display leading-tight font-semibold tracking-tight text-ink">Plume</h2>
							<span className="font-mono text-label text-ink-muted tabular-nums">v{window.plume.version}</span>
						</div>
						<p className="mt-1 text-label text-ink-muted">{t("about.tagline")}</p>
						<p data-plume-version-status="" className={`mt-2 flex flex-wrap items-center gap-1.5 text-detail ${status.tone}`}>
							{status.icon}
							{status.text}
							{info?.publishedAt ? (
								<span className="text-ink-faint">· {t("about.publishedOn", { date: publishedOn(info.publishedAt, resolvedLocale) })}</span>
							) : null}
						</p>
					</div>
					<div className="flex shrink-0 flex-wrap items-center gap-2">
						<Button variant="subtle" onClick={() => void checkUpdates(true)} loading={checking} icon={<RefreshCw size={13} strokeWidth={2} aria-hidden />}>
							{checking ? t("about.checking") : t("about.checkUpdate")}
						</Button>
						{available ? (
							<Button variant="primary" onClick={() => setDialog(true)} icon={<CloudDownload size={13} strokeWidth={2} aria-hidden />}>
								{t("about.updateNow", { version: info?.latest ?? "" })}
							</Button>
						) : null}
					</div>
				</div>
				{info?.url ? (
					<div className="mt-5">
						<Button
							variant="subtle"
							size="sm"
							data-plume-open-releases=""
							className="bg-card/80"
							onClick={() => void window.plume.updates.open(info.url)}
							icon={<Tag size={13} strokeWidth={2} aria-hidden />}
						>
							{t("about.releases")}
						</Button>
					</div>
				) : null}
			</section>
			<Card>
				<Row
					title={t("about.checkInterval")}
					control={
						<InlineSelect
							value={String(interval)}
							onChange={(value) => setCheckInterval(Number(value))}
							options={[
								{ value: "1", label: t("about.every1h") },
								{ value: "4", label: t("about.every4h") },
								{ value: "6", label: t("about.every6h") },
								{ value: "8", label: t("about.every8h") },
								{ value: "12", label: t("about.every12h") },
								{ value: "24", label: t("about.every24h") },
							]}
						/>
					}
				/>
				<Row title={t("about.environment")} control={<span className="font-mono text-label text-ink-muted">{window.plume.platform}</span>} />
			</Card>
			{notes ? (
				<section>
					<SectionTitle>
						{available ? t("about.updateDetails", { version: info?.latest ?? "" }) : t("about.releaseNotes", { version: info?.current ?? "" })}
					</SectionTitle>
					<Card>
						<div className="px-5 py-4">
							<Markdown key={resolvedLocale} text={notes} className="text-label" />
						</div>
					</Card>
				</section>
			) : info?.checked === false ? (
				<p className="text-center text-detail text-ink-faint">{t("about.checkPrompt")}</p>
			) : null}
			{dialog && info ? <UpdateDialog info={info} phase={phase} onClose={() => setDialog(false)} /> : null}
		</Page>
	);
}

/** 语言选项前的小标记：跟随系统画一个图标，指定的语言写它自己的字。 */
function LocaleMark({ value, mark }: { value: UiLocale; mark: string }) {
	if (value === "system") {
		return (
			<span className="flex h-5.5 w-6 shrink-0 items-center justify-center rounded-md bg-elevated text-ink-muted">
				<Languages size={13} strokeWidth={1.9} />
			</span>
		);
	}
	return (
		<span className="flex h-5.5 min-w-6 shrink-0 items-center justify-center rounded-md bg-elevated px-1 text-mark font-semibold tracking-tight text-ink-muted">
			{mark}
		</span>
	);
}
