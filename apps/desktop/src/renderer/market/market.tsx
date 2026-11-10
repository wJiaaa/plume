/**
 * 扩展：还能给 Plume 加什么，以及已经有了什么。分三类——插件、技能、连接器，页头就是这三类的切换（`KindTabs`）。
 *
 * 技能和连接器（MCP）由管它们的内置插件画（`page: "extensions-skills"`、`"extensions-connectors"`）：装了哪些、开着
 * 没有、配好没有，人到这里找，设置里不另设一页。市场里这两类的条目（`plume.kind` 是 skill、connector 的插件）按货架
 * 接在那一节下面，装法、详情页和插件一样。下面说的都是「插件」那一类，由这里画。
 *
 * 按货架排开的标记和一句话，为了扫着看而排，每张一个动作；开关、更新、卸载、插件自己的设置都在它的详情页
 * （detail.tsx）。「我装了什么」也在这里回答：筛选条最前面是「已安装」，筛出装着的那几张卡片——设置里不另设一页。
 *
 *   - 一张网格，按货架分组，上面一排筛选：已安装、全部、各个货架。
 *   - 随应用发的内置插件不列，它们是产品本身、动不了；只有没加载起来的出现在「已安装」里，人要看得到原因。
 *   - 「来自目录」和「只在本机」是插件的一个事实，不是两页：只在本机的那几个在最后单独一架。
 *   - 有新版时一行一颗按钮；自动更新开着时它们自己就换上了（见主进程的 market.ts）。
 *   - 开着的时候每 10 分钟、回到窗口时再读一次目录。
 *
 * 页头的按钮放在窗口顶行里（见 `MarketToolbar`），和侧栏的控件在一条线上。
 */

import {
	formatList,
	Button,
	ErrorBoundary,
	IconButton,
	MenuBody,
	MenuItem,
	Popover,
	Scroller,
	SkeletonGrid,
	useI18n,
	usePopover,
	useSlowLoad,
} from "@plume/ui";
import {
	ArrowUp,
	Blocks,
	Briefcase,
	Cable,
	ChevronRight,
	CircleAlert,
	Cloud,
	CodeXml,
	Database,
	FileText,
	FlaskConical,
	FolderUp,
	Gamepad2,
	Globe,
	Image,
	Info,
	LayoutGrid,
	Lightbulb,
	Monitor,
	MoreHorizontal,
	Paintbrush,
	Palette,
	Plus,
	RefreshCw,
	Search,
	Shapes,
	Shield,
	Sparkles,
	Store,
	Users,
	Workflow,
	Wrench,
	X,
} from "@plume/ui/icons";
import { ActionSpinner } from "@plume/ui";
import { type ComponentType, type ReactNode, useEffect, useMemo, useState } from "react";
import { NavItem } from "../nav-item.tsx";
import { listPageSettingsSections, usePluginUis } from "../plugins.tsx";
import type { SettingsSection } from "../settings/pages.tsx";
import { CatalogCard } from "./card.tsx";
import { byName, type CatalogItem, isBuiltin, isInstalled, shelves, UNFILED } from "./catalog.ts";
import { PluginDetail } from "./detail.tsx";
import {
	focusPlugin,
	installFromFolder,
	type MarketNotice,
	type MarketTab,
	reloadMarket,
	setAutoUpdate,
	setMarketNotice,
	setMarketTab,
	updatePlugins,
	useCatalog,
	useMarketStore,
} from "./store.ts";

/** 开着的市场多久自己重读一次目录。 */
const REVALIDATE_MS = 10 * 60 * 1000;

/** 筛选条上「已安装」那一颗。和 UNFILED 一样前面带空格，不会撞上哪个货架的名字。 */
const INSTALLED = " installed";

export function MarketScreen({
	onOpenSettings,
	onTry,
}: {
	/** 去设置里的某一节：插件详情里「设置」一节的入口。 */ onOpenSettings: (section: SettingsSection) => void;
	/** 详情里「试试这样问」：开新对话，输入框里放好这句话。 */ onTry: (prompt: string) => void;
}) {
	const { t } = useI18n();
	const items = useCatalog();
	const { market, loading, tab, focus, updates, notice, plugins } = useMarketStore();
	const [category, setCategory] = useState<string | null>(null);
	const [updatingAll, setUpdatingAll] = useState(false);

	// 打开时读一次，开着时隔一阵、回到窗口时再读。
	useEffect(() => {
		void reloadMarket();
		const timer = setInterval(() => void reloadMarket(), REVALIDATE_MS);
		const onFocus = () => void reloadMarket();
		window.addEventListener("focus", onFocus);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", onFocus);
		};
	}, []);

	// 市场回答「还能装什么」：随应用发的插件不在这里；技能合集、连接器在另两类里。
	const listed = items.filter((item) => item.kind === "plugin" && !isBuiltin(item));
	// 已安装：市场装的、本机添加的，加上没加载起来的内置插件。
	const installed = items.filter((item) => item.kind === "plugin" && isInstalled(item) && (!isBuiltin(item) || item.status?.state === "failed"));
	const published = listed.filter((item) => item.entry !== null);
	const localOnly = listed.filter((item) => item.entry === null);
	const categories = useMemo(() => shelves(published).map((shelf) => ({ name: shelf.category, count: shelf.items.length })), [published]);
	const narrowed = category !== null;
	const flat = useMemo(
		() => (narrowed ? (category === INSTALLED ? installed : listed.filter((item) => item.category === category)).sort(byName) : []),
		[narrowed, listed, installed, category],
	);
	const outdated = items.filter((item) => item.outdated && item.entry);
	const slow = useSlowLoad(loading && !market);
	// 没加载起来的插件：「已安装」里那张卡片写着，详情页里有原因。
	const problems = plugins.filter((plugin) => plugin.state === "failed");

	const updateAll = async () => {
		setUpdatingAll(true);
		try {
			await updatePlugins(outdated.map((item) => item.key));
		} finally {
			setUpdatingAll(false);
		}
	};

	const open = focus ? (items.find((item) => item.key === focus) ?? null) : null;
	if (open) return <PluginDetail item={open} onBack={() => focusPlugin(null)} onOpenSettings={onOpenSettings} onTry={onTry} />;

	// 每张卡片在到达顺序里排第几，跨货架连着数；每次画都从零开始。
	let arrival = 0;
	const card = (item: CatalogItem) => <CatalogCard key={item.key} index={arrival++} item={item} onOpen={() => focusPlugin(item.key)} />;

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-screen="market">
			<Scroller className="flex-1">
				<div className="px-6 pb-16">
					{/* @container：网格跟着这一列的宽度走，不跟窗口。 */}
					<div className="@container mx-auto w-full max-w-[1040px]">
						<KindTabs value={tab} onChange={setMarketTab} />

						{tab !== "plugins" ? (
							<ExtensionSections tab={tab} items={items} />
						) : (
							<>
								<div className="flex flex-wrap gap-1" role="group" aria-label={t("pluginDetail.category")}>
									<Chip active={category === INSTALLED} icon={Blocks} onClick={() => setCategory(category === INSTALLED ? null : INSTALLED)}>
										{t("common.installed")}
									</Chip>
									<Chip active={category === null} icon={LayoutGrid} onClick={() => setCategory(null)}>
										{t("market.allCategories")}
									</Chip>
									{categories.length > 1 &&
										categories.map((entry) => (
											<Chip
												key={entry.name}
												active={category === entry.name}
												icon={SHELF_ICONS[entry.name] ?? Shapes}
												onClick={() => setCategory(category === entry.name ? null : entry.name)}
											>
												{entry.name === UNFILED ? t("common.other") : entry.name}
											</Chip>
										))}
								</div>

								{notice && <NoticeLine notice={notice} onDismiss={() => setMarketNotice(undefined)} />}

								{outdated.length > 0 && (
									<div className="market-swap-in mt-4 flex items-center gap-3 rounded-panel bg-accent/8 px-4 py-2.5" data-market-updates="">
										<ArrowUp size={14} strokeWidth={2.2} className="shrink-0 text-accent" />
										<p className="min-w-0 flex-1 text-label text-ink">
											{updates?.updating.length ? t("market.updatingN", { n: updates.updating.length }) : t("market.updatesN", { n: outdated.length })}
											<span className="pl-2 text-detail text-ink-muted">
												{formatList(outdated.map((item) => item.name).slice(0, 3))}
												{outdated.length > 3 ? "…" : ""}
											</span>
										</p>
										<Button
											variant="subtle"
											size="sm"
											loading={updatingAll}
											onClick={() => void updateAll()}
											className="bg-accent/12 text-accent hover:bg-accent/20 hover:text-accent"
										>
											{t("market.updateAll")}
										</Button>
									</div>
								)}

								{/* 按正在看的货架取 key：换货架会重放一次到达——内容淡入、卡片依次升起。 */}
								<div key={category ?? ""} className="market-swap-in">
									{!market ? (
										slow ? (
											<div className="pt-8">
												<SkeletonGrid count={6} label={t("market.readingPlugins")} />
											</div>
										) : null
									) : narrowed ? (
										flat.length === 0 ? (
											<Empty
												text={category === INSTALLED ? t("market.noneInstalled") : t("market.emptyCategory")}
												action={category === INSTALLED ? { label: t("market.browseAll"), onClick: () => setCategory(null) } : undefined}
											/>
										) : (
											<Shelf
												id={category === INSTALLED ? "installed" : undefined}
												title={category === INSTALLED ? t("common.installed") : category === UNFILED ? t("common.other") : (category ?? "")}
												count={flat.length}
											>
												{flat.map(card)}
											</Shelf>
										)
									) : published.length === 0 && localOnly.length === 0 ? (
										<Empty text={t("market.empty")} />
									) : (
										<>
											{shelves(published).map((shelf) => (
												<Shelf
													key={shelf.category}
													id={shelf.category}
													title={shelf.category === UNFILED ? t("common.other") : shelf.category}
													count={shelf.items.length}
												>
													{shelf.items.map(card)}
												</Shelf>
											))}
											{localOnly.length > 0 && (
												<Shelf id="local" title={t("market.localOnly")} note={t("market.localOnlyNote")} count={localOnly.length}>
													{localOnly.sort(byName).map(card)}
												</Shelf>
											)}
										</>
									)}
								</div>

								{problems.length > 0 && (
									<Button variant="subtle" size="sm" onClick={() => setCategory(INSTALLED)} icon={<CircleAlert size={12} strokeWidth={2} />} className="mt-6">
										{t("market.unreadable", { n: problems.length })}
									</Button>
								)}
							</>
						)}
					</div>
				</div>
			</Scroller>
		</div>
	);
}

/**
 * 三类的切换，就是页头：三个大字，选中的是正文色，别的淡下去，像几个并排的标题而不是一条控件。
 * 页上不再另写「扩展」两个字——侧栏那一行和顶行已经说了这是哪儿。
 */
function KindTabs({ value, onChange }: { value: MarketTab; onChange: (tab: MarketTab) => void }) {
	const { t } = useI18n();
	const tabs: { id: MarketTab; label: string }[] = [
		{ id: "plugins", label: t("common.plugins") },
		{ id: "skills", label: t("market.skills") },
		{ id: "connectors", label: t("market.connectors") },
	];
	return (
		<div className="flex items-baseline gap-8 pt-2 pb-5" role="tablist" aria-label={t("market.title")}>
			{tabs.map((entry) => (
				<button
					key={entry.id}
					type="button"
					role="tab"
					aria-selected={entry.id === value}
					data-market-kind={entry.id}
					onClick={() => onChange(entry.id)}
					className={`text-display font-semibold transition-colors duration-[var(--plume-t-quick)] ${
						entry.id === value ? "text-ink" : "text-ink-faint hover:text-ink-muted"
					}`}
				>
					{entry.label}
				</button>
			))}
		</div>
	);
}

/**
 * 技能、连接器两类的内容：管它们的插件画的那一节（一般各只有一个插件），和插件那一类同宽，卡片网格由它们自己画；
 * 下面接着市场里这一类的条目，按货架排，卡片和详情页同插件那一类。装上的技能、连接器也出现在上面那一节里。
 */
function ExtensionSections({ tab, items }: { tab: Exclude<MarketTab, "plugins">; items: CatalogItem[] }) {
	const { t } = useI18n();
	usePluginUis();
	const sections = listPageSettingsSections(tab === "skills" ? "extensions-skills" : "extensions-connectors");
	const kind = tab === "skills" ? "skill" : "connector";
	const offered = items.filter((item) => item.kind === kind && !isBuiltin(item));
	let arrival = 0;
	return (
		<div key={tab} className="market-swap-in" data-market-tab={tab}>
			{sections.map((entry) => (
				<ErrorBoundary key={entry.key}>
					<entry.component />
				</ErrorBoundary>
			))}
			{offered.length > 0 && (
				<section className="pt-10" data-market-offered={kind}>
					<h2 className="text-heading font-semibold text-ink">{t("market.fromMarket")}</h2>
					{shelves(offered).map((shelf) => (
						<Shelf key={shelf.category} id={shelf.category} title={shelf.category === UNFILED ? t("common.other") : shelf.category} count={shelf.items.length}>
							{shelf.items.map((item) => (
								<CatalogCard key={item.key} index={arrival++} item={item} onOpen={() => focusPlugin(item.key)} />
							))}
						</Shelf>
					))}
				</section>
			)}
		</div>
	);
}

/**
 * 市场在窗口顶行里的那一截：详情页是「扩展 › 名字」的面包屑，插件的网格页是右端的「创建插件」、重读和 ⋯。
 * 顶行本身可以拖窗口，只有能点的那一组标 no-drag，空着的地方照样能拖。
 *
 * 「创建插件」两条路：新建是开一个新对话、输入框里放好写插件的技能，让 agent 照人说的写；从文件夹安装是把本机
 * 一个构建好的插件装上，和市场装的放在一处。
 */
export function MarketToolbar({ onCreate }: { /** 新建插件：开新对话，草稿是点名 plume-plugin 技能的命令。 */ onCreate: () => void }) {
	const { t } = useI18n();
	const items = useCatalog();
	const { tab, focus, loading, updates } = useMarketStore();
	const more = usePopover();
	const create = usePopover();
	const open = focus ? items.find((item) => item.key === focus) : undefined;

	if (open) {
		return (
			<nav className="flex min-w-0 items-center gap-1 text-label [app-region:no-drag]" aria-label={t("market.title")}>
				<Button variant="subtle" size="sm" onClick={() => focusPlugin(null)}>
					{t("market.title")}
				</Button>
				<ChevronRight size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
				<span className="max-w-[320px] truncate px-1 text-ink">{open.name}</span>
			</nav>
		);
	}

	// 创建、重读目录、自动更新说的都是插件；技能、连接器那两类的按钮在它们自己的那一节里。
	if (tab !== "plugins") return null;

	const createNew = () => {
		create.close();
		onCreate();
	};

	return (
		<div className="ml-auto flex items-center gap-0.5 [app-region:no-drag]">
			<Button
				variant="soft"
				size="sm"
				menu={create.open}
				onClick={create.toggle}
				icon={<Plus size={14} strokeWidth={1.9} />}
				data-market-create=""
				className="mr-1.5"
			>
				{t("market.create")}
			</Button>
			{create.open && (
				<Popover anchor={create.anchor} onClose={create.close} placement="bottom" align="end" width="default" role="menu" label={t("market.create")}>
					<MenuBody>
						<MenuItem icon={<Sparkles size={14} strokeWidth={1.8} />} detail={t("market.createNewDetail")} onClick={createNew}>
							{t("market.createNew")}
						</MenuItem>
						<MenuItem
							icon={<FolderUp size={14} strokeWidth={1.8} />}
							detail={t("market.installFolderDetail")}
							onClick={() => {
								create.close();
								void installFromFolder();
							}}
						>
							{t("market.installFolder")}
						</MenuItem>
					</MenuBody>
				</Popover>
			)}
			<IconButton
				label={t("market.reload")}
				onClick={() => void reloadMarket()}
				icon={loading ? <ActionSpinner size={13.5} /> : <RefreshCw size={13.5} strokeWidth={1.8} />}
			/>
			<IconButton label={t("common.more")} onClick={more.toggle} menu={more.open} icon={<MoreHorizontal size={15} strokeWidth={1.9} />} />
			{more.open && (
				<Popover anchor={more.anchor} onClose={more.close} placement="bottom" align="end" width="default" role="menu" label={t("common.more")}>
					<MenuBody>
						<MenuItem
							icon={<ArrowUp size={14} strokeWidth={1.9} />}
							checked={updates?.auto !== false}
							onClick={() => void setAutoUpdate(updates?.auto === false)}
						>
							{t("market.autoUpdate")}
						</MenuItem>
					</MenuBody>
				</Popover>
			)}
		</div>
	);
}

/** 标题、下面有几个、网格。页上每一组都是它，所以离上面的东西一样远。 */
function Shelf({ id, title, note, count, children }: { id?: string; title: string; note?: string; count: number; children: ReactNode }) {
	return (
		<section className="pt-8" data-shelf={id}>
			<div className="flex items-baseline gap-2 pb-3">
				<h2 className="text-body font-medium text-ink">{title}</h2>
				<span className="text-detail text-ink-faint tabular-nums">{count}</span>
				{note && <span className="text-detail text-ink-faint">· {note}</span>}
			</div>
			<div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">{children}</div>
		</section>
	);
}

/**
 * 筛选条上的一颗：图标加字。没选的只是一行灰字、没有底，选中的垫一层浅灰、字变成正文色——一排里只有它是个
 * 「东西」，一眼就是它，又不至于像一颗实心胶囊那样成为页上最响的。
 */
function Chip({
	active,
	icon: Icon,
	onClick,
	children,
}: {
	active: boolean;
	icon: ComponentType<{ size?: number; strokeWidth?: number }>;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={`flex h-[32px] items-center gap-1.5 rounded-full px-3.5 text-label whitespace-nowrap transition-colors active:bg-elevated ${
				active ? "bg-card-hover font-medium text-ink" : "text-ink-muted hover:bg-card-hover/60 hover:text-ink"
			}`}
		>
			<Icon size={15} strokeWidth={1.8} />
			{children}
		</button>
	);
}

/**
 * 货架的图标。货架名是条目数据里的值（package.json 的 `plume.category`），不在表里的用一个通用的形状。
 * i18n-exempt：键是数据，不是界面文案。
 */
const SHELF_ICONS: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
	开发: CodeXml,
	工作流: Workflow,
	工具: Wrench,
	连接: Cable,
	外观: Paintbrush,
	游戏: Gamepad2,
	浏览器: Globe,
	搜索: Search,
	文档: FileText,
	数据: Database,
	设计: Palette,
	办公: Briefcase,
	协作: Users,
	思考: Lightbulb,
	科研: FlaskConical,
	云与运维: Cloud,
	安全: Shield,
	媒体: Image,
	本机: Monitor,
};

function Empty({ text, action }: { text: string; action?: { label: string; onClick: () => void } }) {
	return (
		<div className="py-16 text-center">
			<p className="text-label text-ink-faint">{text}</p>
			{action && (
				<div className="mt-4 flex justify-center">
					<Button variant="subtle" onClick={action.onClick}>
						{action.label}
					</Button>
				</div>
			)}
		</div>
	);
}

/** 最近发生的一件事：失败用红色，别的用页面自己的字色。留到关掉或被替换：读下面卡片时失败的安装，抬头时还该在说。 */
function NoticeLine({ notice, onDismiss }: { notice: MarketNotice; onDismiss: () => void }) {
	const { t } = useI18n();
	const error = notice.tone === "error";
	return (
		<div
			role={error ? "alert" : "status"}
			className={`mt-4 flex items-start gap-2.5 rounded-panel px-4 py-2.5 text-detail ${error ? "bg-danger/6 text-danger" : "bg-card/70 text-ink-muted"}`}
		>
			{error ? <CircleAlert size={13} strokeWidth={2} className="mt-0.5 shrink-0" /> : <Info size={13} strokeWidth={2} className="mt-0.5 shrink-0" />}
			<p className="min-w-0 flex-1 whitespace-pre-line">{notice.text}</p>
			<IconButton label={t("common.close")} size="sm" onClick={onDismiss} className="shrink-0" icon={<X size={13} strokeWidth={2} />} />
		</div>
	);
}

/**
 * 侧栏里去市场的那一行，以及你在不在那里。自动更新关着时，有新版的数目挂在行尾——人不打开市场也知道；
 * 开着的话它们一会儿就自己换上了，挂一个转眼就消失的数字只是晃一下眼。
 */
export function MarketNavItem({ active, compact, onClick }: { active: boolean; compact: boolean; onClick: () => void }) {
	const { t } = useI18n();
	const { updates } = useMarketStore();
	const waiting = updates && !updates.auto ? updates.outdated.length : 0;
	return (
		<NavItem
			active={active}
			compact={compact}
			nav="market"
			icon={<Store size={16} />}
			label={t("market.title")}
			onClick={onClick}
			badge={waiting}
			badgeLabel={t("sidebar.pluginUpdates", { n: waiting })}
		/>
	);
}
