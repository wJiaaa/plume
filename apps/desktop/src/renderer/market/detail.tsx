/**
 * 一个插件的详情，以及对它能做的一切。
 *
 * 网格回答「哪一个」，这里回答「里面是什么、要不要、在不在好好工作」。只有这一处管理插件：开关、更新、卸载、
 * 它自己的设置；卡片故意一样都不做（见 card.tsx）。
 *
 * 从上到下按需要的先后：
 *   1. 它是什么——标记、名字、一句话、作者和版本，一排标签（货架、许可证）以主页收尾；
 *   2. 动作——安装，装了以后是开关、有新版时的更新、其余放进 ⋯；
 *   3. 设置——它经 `ui.settingsSection` 加的、只和它有关的那几节，和去它放在设置里别处的那几节的入口；
 *   4. 试试这样问——装上并开着时，它在 `plume.defaultPrompt` 里写的几句话，点一句开新对话；
 *   5. 介绍——它的 README，没有就是它的一句话说明。
 */

import {
	ActionSpinner,
	Button,
	ErrorBoundary,
	formatList,
	IconButton,
	MenuBody,
	MenuItem,
	MenuSeparator,
	Popover,
	Scroller,
	SkeletonBar,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import { ArrowUp, ArrowUpRight, CircleAlert, Clock, Download, ExternalLink, FolderOpen, Globe, MoreHorizontal, Settings2, Trash2 } from "@plume/ui/icons";
import { type ReactNode, useEffect, useState } from "react";
import { listPluginSettingsSections, localized, type SettingsSectionEntry, usePluginUis } from "../plugins.tsx";
import { Toggle } from "../settings/controls.tsx";
import type { SettingsSection } from "../settings/pages.tsx";
import type { PluginKind } from "@plume/contract";
import { type CatalogItem, isBuiltin, isEnabled, isInstalled, UNFILED } from "./catalog.ts";
import { PluginIcon } from "./plugin-icon.tsx";
import { Readme } from "./readme.tsx";
import { type MarketTab, setMarketTab, setPluginEnabled } from "./store.ts";
import { useInstall } from "./use-install.ts";

export function PluginDetail({
	item,
	onBack,
	onOpenSettings,
	onTry,
}: {
	item: CatalogItem;
	onBack: () => void;
	/** 去设置里的某一节：插件放在导航或产品页里的设置。 */ onOpenSettings: (section: SettingsSection) => void;
	/** 开一个新对话，输入框里放好这句话。 */ onTry: (prompt: string) => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-plugin-detail={item.key}>
			<Scroller className="flex-1">
				<div className="px-6 pt-5 pb-16">
					<div className="mx-auto w-full max-w-[760px]">
						<DetailBody
							item={item}
							onOpenSettings={onOpenSettings}
							onTry={onTry}
							onUninstalled={() => {
								// 目录里有的留在这一页上，变成「没装」；只在本机有过的没东西可看了。
								if (!item.entry) onBack();
							}}
						/>
					</div>
				</div>
			</Scroller>
		</div>
	);
}

function DetailBody({
	item,
	onOpenSettings,
	onTry,
	onUninstalled,
}: {
	item: CatalogItem;
	onOpenSettings: (section: SettingsSection) => void;
	onTry: (prompt: string) => void;
	onUninstalled: () => void;
}) {
	const { t } = useI18n();
	const confirm = useConfirmer();
	const more = usePopover();
	const act = useInstall(item);
	const installed = isInstalled(item);
	const enabled = isEnabled(item);
	const local = item.installed?.source === "local";
	const builtin = isBuiltin(item);
	const switchable = installed && !builtin && item.status !== undefined && item.status.state !== "loading";
	const readme = useReadme(item.key, item.installed?.hash ?? item.entry?.version ?? "");
	// 每一句都是开一个靠它的对话，所以只给装上并开着的。
	const prompts = enabled ? (item.prompts ?? []) : [];

	return (
		<>
			{/* 1. 它是什么。 */}
			<div className="flex items-start gap-4">
				<PluginIcon logo={item.logo} size={60} />
				<div className="min-w-0 flex-1 pt-0.5">
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<h1 className="text-heading font-semibold text-ink">{item.name}</h1>
						<span className="flex h-5 items-center rounded-md bg-card-hover px-1.5 text-caption text-ink-muted">
							{builtin ? t("common.builtin") : local ? t("common.local") : t("common.plugins")}
						</span>
					</div>
					<p className="pt-1 text-label text-ink-muted">{item.description || t("market.noTagline")}</p>
					<Facts author={item.author} version={item.version} />
					<Tags item={item} />
				</div>
			</div>

			{/* 2. 动作。 */}
			<div className="flex flex-wrap items-center gap-2 pt-5">
				{!installed ? (
					item.entry && (
						<Button
							variant="primary"
							loading={act.busy === "install"}
							icon={<Download size={14} strokeWidth={2} aria-hidden />}
							onClick={() => void act.install()}
						>
							{act.busy === "install" ? t("market.installing") : t("common.install")}
						</Button>
					)
				) : (
					<>
						{switchable && (
							<label className="flex h-[32px] items-center gap-2.5 rounded-lg bg-card-hover/70 pr-2 pl-3 text-label text-ink">
								{enabled ? t("market.enabled") : t("market.disabled")}
								<Toggle
									checked={enabled}
									onChange={(next) => item.status && void setPluginEnabled(item.status.name, item.name, next)}
									ariaLabel={t("market.enableNamed", { name: item.name })}
								/>
							</label>
						)}
						{/* 内置的没有开关，在开关的位置说一次为什么。 */}
						{builtin && <span className="flex h-[32px] items-center px-1 text-detail text-ink-faint">{t("plugins.builtinNote")}</span>}
						{item.outdated && item.entry && (
							<Button
								variant="subtle"
								loading={act.busy === "update"}
								icon={<ArrowUp size={14} strokeWidth={2.2} aria-hidden />}
								onClick={() => void act.update()}
								className="bg-accent/12 text-accent hover:bg-accent/20 hover:text-accent"
							>
								{item.entry.version ? t("catalogCard.updateTo", { version: `v${item.entry.version}` }) : t("catalogCard.updateToLatest")}
							</Button>
						)}
						<Button
							variant="subtle"
							label={t("common.more")}
							menu={more.open}
							icon={act.busy === "uninstall" ? <ActionSpinner size={14} /> : <MoreHorizontal size={16} strokeWidth={1.9} aria-hidden />}
							onClick={more.toggle}
						/>
					</>
				)}
			</div>

			{/* 加载失败时说清原因：开关开着却什么都不做，比一句错误更难懂。 */}
			{item.status?.state === "failed" && item.status.error && (
				<p role="alert" className="mt-4 flex items-start gap-2 rounded-panel bg-danger/6 px-4 py-2.5 text-detail text-danger">
					<CircleAlert size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
					<span className="min-w-0 break-words">{item.status.error}</span>
				</p>
			)}
			{/* 在等别的插件提供服务：不是错，补上了自己就加载，所以不用警示色。 */}
			{item.status?.state === "waiting" && item.status.waitingFor && (
				<p className="mt-4 flex items-start gap-2 rounded-panel bg-card-hover px-4 py-2.5 text-detail text-ink-muted">
					<Clock size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
					<span className="min-w-0 break-words">{t("plugins.waiting", { services: formatList(item.status.waitingFor) })}</span>
				</p>
			)}

			{/* 3. 设置。 */}
			<PluginSettings plugin={item.status?.name} kind={isInstalled(item) ? item.kind : undefined} onOpenSettings={onOpenSettings} />

			{/* 4. 试试这样问。 */}
			{prompts.length > 0 && (
				<section className="mt-7 flex flex-col gap-2 rounded-panel bg-card-hover/50 p-4" data-try-asking="">
					<h2 className="pb-1 text-detail font-medium text-ink-muted">{t("market.tryAsking")}</h2>
					{prompts.slice(0, 4).map((prompt) => (
						<button
							key={prompt}
							type="button"
							onClick={() => onTry(prompt)}
							className="group/prompt flex items-center gap-2.5 rounded-lg bg-shell/85 px-3.5 py-2.5 text-left text-label text-ink transition-colors hover:bg-shell"
						>
							<span className="min-w-0 flex-1">{prompt}</span>
							<ArrowUpRight size={14} strokeWidth={2} className="shrink-0 text-ink-faint transition-colors group-hover/prompt:text-ink" />
						</button>
					))}
				</section>
			)}

			{/* 5. 介绍。 */}
			<div className="pt-8" data-detail-tab="overview">
				<Overview id={item.key} readme={readme} fallback={item.description} />
			</div>

			{/* 只对还没装的说一次：装上就是把别人的代码放进 agent 进程里跑，目录是一张单子，不是审核。 */}
			{!installed && item.entry && <p className="pt-8 text-caption text-ink-faint">{t("pluginDetail.installPluginWarning")}</p>}

			{more.open && (
				<Popover anchor={more.anchor} onClose={more.close} placement="bottom" align="start" width="compact" role="menu" label={item.name}>
					<MenuBody>
						{prompts[0] && (
							<MenuItem
								icon={<ArrowUpRight size={13} strokeWidth={1.8} />}
								onClick={() => {
									more.close();
									onTry(prompts[0]!);
								}}
							>
								{t("catalogCard.tryNow")}
							</MenuItem>
						)}
						<MenuItem
							icon={<FolderOpen size={13} strokeWidth={1.8} />}
							onClick={() => {
								more.close();
								void window.plume.market.openFolder(item.key);
							}}
						>
							{t("common.openFolder")}
						</MenuItem>
						{item.homepage && (
							<MenuItem
								icon={<ExternalLink size={13} strokeWidth={1.8} />}
								onClick={() => {
									more.close();
									if (item.homepage) void window.plume.openExternal(item.homepage);
								}}
							>
								{t("pluginDetail.homepage")}
							</MenuItem>
						)}
						{/* 内置的永远卸不掉，不摆一颗永远灰着的按钮。 */}
						{!builtin && (
							<>
								<MenuSeparator />
								<MenuItem
									danger
									icon={<Trash2 size={13} strokeWidth={1.8} />}
									disabled={act.busy !== null || local}
									title={local ? t("market.localOwned") : undefined}
									onClick={() => {
										more.close();
										confirm.ask({
											title: t("plugins.uninstallConfirm", { name: item.name }),
											detail: t("market.uninstallDetail"),
											confirmLabel: t("mcp.uninstall"),
											onConfirm: () => void act.uninstall().then(onUninstalled),
										});
									}}
								>
									{t("mcp.uninstall")}
								</MenuItem>
							</>
						)}
					</MenuBody>
				</Popover>
			)}
			{confirm.element}
		</>
	);
}

/**
 * 插件自己的设置：没给 `page` 的分区画在这里，给了的（导航里一行、产品某一页、「扩展」的另一类）列成去那里的入口，同一处只列一次。
 * 插件没开着时它的界面入口没装上，分区一个都没有，这一节也就不画。装上的技能合集、连接器没有界面入口，它们的技能和服务
 * 在「扩展」的那一类里管（连接器在那里填变量），入口照样列出。
 */
function PluginSettings({
	plugin,
	kind,
	onOpenSettings,
}: {
	plugin: string | undefined;
	/** 装着的那份是哪一类；没装是 undefined。 */ kind: PluginKind | undefined;
	onOpenSettings: (section: SettingsSection) => void;
}) {
	const { t, resolvedLocale } = useI18n();
	usePluginUis();
	const sections = plugin ? listPluginSettingsSections(plugin) : [];
	const inline = sections.filter((entry) => entry.page === undefined);
	const links = new Map<SettingsSection, string>();
	for (const entry of sections) {
		const target = settingsTarget(entry);
		if (!target || links.has(target)) continue;
		links.set(
			target,
			entry.page === "nav"
				? localized(entry.title, resolvedLocale)
				: t(entry.page === "general" ? "settings.general" : entry.page === "personalization" ? "settings.personalization" : "settings.agents"),
		);
	}
	// 画进「扩展」另两类的，入口是换到那一类。
	const tabs = new Map<Exclude<MarketTab, "plugins">, string>();
	for (const entry of sections) {
		if (entry.page === "extensions-skills") tabs.set("skills", t("market.skills"));
		if (entry.page === "extensions-connectors") tabs.set("connectors", t("market.connectors"));
	}
	if (kind === "skill") tabs.set("skills", t("market.skills"));
	if (kind === "connector") tabs.set("connectors", t("market.connectors"));
	if (inline.length === 0 && links.size === 0 && tabs.size === 0) return null;
	return (
		<section className="pt-8" data-plugin-settings="">
			{/* 和下面 README 的一级标题同级，比插件自己的分组标题（SettingsSectionTitle）大一档。 */}
			<h2 className="pb-3 text-heading font-semibold text-ink">{t("pluginDetail.settings")}</h2>
			{inline.map((entry) => (
				<div key={entry.key} className="pb-4" data-plugin-settings-section={entry.key}>
					{/* 只有一节时小标题就是插件名，不再写一遍。 */}
					{inline.length > 1 && <h3 className="pb-1 text-label font-medium text-ink">{localized(entry.title, resolvedLocale)}</h3>}
					{/* 介绍和组件第一个分组标题之间留出一组的距离，不贴着。 */}
					{entry.detail && <p className="pb-6 text-label text-ink-muted">{localized(entry.detail, resolvedLocale)}</p>}
					<ErrorBoundary>
						<entry.component />
					</ErrorBoundary>
				</div>
			))}
			{links.size + tabs.size > 0 && (
				<div className="flex flex-wrap gap-2">
					{[...links].map(([target, place]) => (
						<Button key={target} variant="subtle" size="sm" icon={<Settings2 size={13} strokeWidth={1.8} aria-hidden />} onClick={() => onOpenSettings(target)}>
							{t("pluginDetail.settingsAt", { place })}
						</Button>
					))}
					{[...tabs].map(([tab, place]) => (
						<Button key={tab} variant="subtle" size="sm" icon={<Settings2 size={13} strokeWidth={1.8} aria-hidden />} onClick={() => setMarketTab(tab)}>
							{t("pluginDetail.extensionsAt", { place })}
						</Button>
					))}
				</div>
			)}
		</section>
	);
}

/** 放在设置别处的分区在哪一节：导航里自己那一行，或它画进去的那一页。 */
function settingsTarget(entry: SettingsSectionEntry): SettingsSection | undefined {
	if (entry.page === "nav") return `plugin:${entry.key}`;
	if (entry.page === "general") return "general";
	if (entry.page === "personalization") return "personalization";
	if (entry.page === "agents" || entry.page === "session-models") return "agents";
	return undefined;
}

/** 名字下面那一行：谁写的、哪个版本。 */
function Facts({ author, version }: { author?: string; version?: string }) {
	const parts: ReactNode[] = [];
	if (author) parts.push(<span key="by">{author}</span>);
	if (version)
		parts.push(
			<span key="v" className="tabular-nums">
				v{version}
			</span>,
		);
	if (parts.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pt-2 text-detail text-ink-faint">
			{parts.map((part, index) => (
				<span key={index} className="flex items-center gap-1.5">
					{index > 0 && (
						<span aria-hidden className="text-ink-faint/50">
							·
						</span>
					)}
					{part}
				</span>
			))}
		</div>
	);
}

/** 货架、许可证一排标签，末尾是主页。 */
function Tags({ item }: { item: CatalogItem }) {
	const { t } = useI18n();
	const tags = [item.category !== UNFILED ? item.category : undefined, item.license].filter((tag): tag is string => Boolean(tag));
	if (tags.length === 0 && !item.homepage) return null;
	return (
		<div className="flex flex-wrap items-center gap-1.5 pt-3" data-detail-tags="">
			{tags.map((tag) => (
				<span key={tag} className="flex h-[22px] items-center rounded-full bg-card-hover px-2.5 text-caption text-ink-muted">
					{tag}
				</span>
			))}
			{item.homepage && (
				<IconButton
					label={t("pluginDetail.website")}
					size="sm"
					icon={<Globe size={13} strokeWidth={1.9} />}
					onClick={() => {
						if (item.homepage) void window.plume.openExternal(item.homepage);
					}}
				/>
			)}
		</div>
	);
}

/** `undefined` 还在找，`null` 没有，字符串是 README 正文。 */
type ReadmeResult = string | null | undefined;

/** 这个窗口里已经读到的 README，按条目和装下那份的指纹（没装时按市场里的版本）：再打开同一页立即画出来，换了版本重新读。 */
const KNOWN = new Map<string, string | null>();

function useReadme(key: string, hash: string): ReadmeResult {
	const id = `${key}@${hash}`;
	const [result, setResult] = useState<{ id: string; value: ReadmeResult }>(() => ({ id, value: KNOWN.get(id) }));
	useEffect(() => {
		const known = KNOWN.get(id);
		if (known !== undefined) return setResult({ id, value: known });
		setResult({ id, value: undefined });
		let alive = true;
		window.plume.market.readme(key).then(
			(text) => {
				KNOWN.set(id, text);
				if (alive) setResult({ id, value: text });
			},
			() => alive && setResult({ id, value: null }),
		);
		return () => {
			alive = false;
		};
	}, [id, key]);
	return result.id === id ? result.value : KNOWN.get(id);
}

/** 介绍：有 README 画 README，没有画它的一句话说明。 */
function Overview({ id, readme, fallback }: { id: string; readme: ReadmeResult; fallback: string }) {
	if (readme === undefined) {
		return (
			<div className="flex flex-col gap-3 pt-1" aria-busy="true">
				<SkeletonBar width="62%" height={14} />
				<SkeletonBar width="96%" />
				<SkeletonBar width="88%" />
				<SkeletonBar width="92%" />
				<SkeletonBar width="54%" />
			</div>
		);
	}
	if (readme) return <Readme plugin={id} markdown={readme} />;
	return fallback ? <p className="text-label text-ink-muted">{fallback}</p> : null;
}
