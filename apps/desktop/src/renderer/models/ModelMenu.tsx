/**
 * 输入框旁的模型菜单：常用的放最前，其余按供应商分组；模型多时有搜索框和左侧一列厂商标。
 * 选中写到这个会话上（下一轮生效），星标存在设置里。
 */

import { isImageModel } from "@plume/llm/image-models";
import { type Anchor, MenuBody, MenuItem, MenuSearch, MenuSeparator, Popover, ScrollText, useConfirmer, useI18n } from "@plume/ui";
import { Box, ChevronRight, Star } from "@plume/ui/icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ModelIcon } from "./ModelIcon.tsx";
import { ModelRail, type RailPick } from "./ModelRail.tsx";
import {
	ambiguousNames,
	favouriteRows,
	filterGroups,
	filterHouse,
	flattenGroups,
	groupModels,
	housesOf,
	type ModelRow,
	toggleFavourite,
} from "./model-grouping.ts";
import { effectiveModelId, type ComposerSession } from "./session.ts";
import { modelsAgent, modelsState, setFavoriteModels, useModels } from "./store.ts";

export function formatWindow(tokens: number): string {
	if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
	return String(tokens);
}

/** 数字键能选到前几行，按绘制顺序跨分组数。 */
const SHORTCUTS = 4;

/**
 * 这个菜单最高多高。单独一个数而不是共用的菜单上限：旁边有一列厂商标，340 放在搜索框下面，到第八个标就截断了，
 * 这里放得下十一个标、大约十一行。
 */
const MODEL_MENU_MAX_HEIGHT = 420;

/** 有了左侧 44px 那一列以后更宽：右边的列表保持原来 `wide` 的宽度，再补上长名字本来就缺的那点——`claude-sonnet-4-5-20250929` 和它旁边那个只差被渐隐掉的那段。 */
const MODEL_MENU_RAIL_WIDTH = 380;

/** 超过这么多，列表是拿来搜的而不是拿来读的，搜索框才值它占的 36px；少于它，六行上面放个搜索框只是摆设。 */
const SEARCH_FROM = 8;

/** 哪些供应商分组折起来了，跨启动记住。放 localStorage 而不是设置里：它管的是这个窗口怎么显示，和侧栏宽度一样，不是应用怎么运行。 */
const COLLAPSED_KEY = "plume.modelMenu.collapsed";

function storedCollapsed(): string[] {
	try {
		const raw = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
		return Array.isArray(raw) ? raw.filter((each): each is string => typeof each === "string") : [];
	} catch {
		return [];
	}
}

/** 画出来的一块：常用列表，或一个供应商。 */
interface Section {
	key: string;
	title: string;
	rows: ModelRow[];
	/** 常用列表不能折：它已经是短的那版了。 */
	foldable: boolean;
}

/**
 * 设置页里的「选一个模型」：不改哪个会话，选中的交给 `onChange`；最前面多一项「跟随」，选它给空串。
 */
export interface ModelSelection {
	value: string;
	onChange: (modelId: string) => void;
	inheritLabel: string;
	inheritDetail?: string;
	/** 列哪一类模型：默认是对话模型；`image` 只列生图模型（设置 › 智能体的「生图模型」）。 */
	kind?: "chat" | "image";
}

/** 给了 `session` 是输入框旁的那个菜单，选了就切这个会话的模型；给了 `selection` 是设置页的下拉。 */
export function ModelMenu({
	anchor,
	onClose,
	target,
	onError,
	onOpenSettings,
}: {
	anchor: Anchor;
	onClose: () => void;
	target: { session: ComposerSession } | { selection: ModelSelection };
	onError: (message: string) => void;
	onOpenSettings: () => void;
}) {
	const session = "session" in target ? target.session : undefined;
	const selection = "selection" in target ? target.selection : undefined;
	const { t } = useI18n();
	const settings = useModels();
	const confirmer = useConfirmer();
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const [collapsed, setCollapsed] = useState<string[]>(storedCollapsed);
	const [pick, setPick] = useState<RailPick>("all");
	/** 方向键移动、回车选中的那一行——和指针共用一个高亮。 */
	const [active, setActive] = useState(0);
	/** 方向键按下时置位：只有键盘才把高亮滚进视野，悬停不能拽动列表。 */
	const keyed = useRef(false);
	/**
	 * 指针上次真正移动到的位置。列表在静止的指针下滚动时（比如方向键把一行带进视野），Chromium 会发一个没有移动的
	 * `mousemove`，照单全收的话高亮就交给了刚滑到指针下的那一行。
	 */
	const pointer = useRef({ x: -1, y: -1 });
	const hover = (index: number, event: React.MouseEvent) => {
		if (event.clientX === pointer.current.x && event.clientY === pointer.current.y) return;
		pointer.current = { x: event.clientX, y: event.clientY };
		setActive(index);
	};

	const current = selection ? selection.value : effectiveModelId(settings, session?.model);
	const favourites = settings?.favoriteModelIds;
	const kind = selection?.kind ?? "chat";
	const groups = useMemo(() => groupModels(settings?.providers, kind), [settings?.providers, kind]);
	// 哪些名字要说出供应商：按全部分组算而不是按过滤后的，否则搜索恰好收窄到两个同名之一时，区分它们的那个标就没了。
	const clashes = useMemo(() => ambiguousNames(groups), [groups]);
	const total = useMemo(() => flattenGroups(groups).length, [groups]);
	/*
	 * 列表长到值得搜索，也就决定了数字键归谁。
	 *
	 * 两边不能都要：搜索框一打开就拿到焦点，而模型名多半是版本号——`claude-opus-4`、`gemini-3.7`——打一个数字是开始找
	 * 模型的正常方式。数字键同时还是快捷键的话，查询的第一个数字就选中了那一行、关掉了菜单，第二个字符永远打不出来。
	 * 所以有搜索框的地方搜索框赢，数字也不画在行上：按不了的快捷键比没有更糟。
	 */
	const searchable = total >= SEARCH_FROM;

	// 有厂商可选时才有左侧那一列：同一家的长列表靠搜索收窄，只有一个标的那一列只是重复旁边的标题。
	const houses = useMemo(() => housesOf(groups), [groups]);
	const hasStarred = useMemo(() => favouriteRows(groups, favourites).length > 0, [groups, favourites]);
	const railed = searchable && houses.length >= 2;
	// 选的那一项不在了（最后一颗星取消了、供应商停用了）就回到全部。
	const view: RailPick = !railed || (pick === "favourites" ? !hasStarred : pick !== "all" && !houses.includes(pick)) ? "all" : pick;
	const shown = useMemo(() => filterGroups(view === "all" || view === "favourites" ? groups : filterHouse(groups, view), query), [groups, view, query]);

	/*
	 * 先常用，再各供应商。星标的模型故意画两次——顶上一次、所属供应商下面一次。从分组里拿掉会让分组的计数不对，
	 * 星标时行还会挪位置，和常用列表的用意正相反。
	 */
	const sections = useMemo<Section[]>(() => {
		const shortlist = (rows: ModelRow[]): Section[] =>
			rows.length > 0 ? [{ key: "__favourites__", title: t("modelMenu.favourite"), rows, foldable: false }] : [];
		// 在自己那一栏里常用列表就是整个列表，搜索是收窄它而不是藏起它。
		if (view === "favourites") return shortlist(favouriteRows(shown, favourites));
		const starred = query || view !== "all" ? [] : favouriteRows(groups, favourites);
		return [
			...shortlist(starred),
			...shown.map((group) => ({
				key: group.provider.id,
				title: group.provider.name,
				rows: group.models.map((model) => ({ provider: group.provider, model })),
				foldable: true,
			})),
		];
	}, [groups, favourites, shown, query, view, t]);

	const opened = (section: Section) => !section.foldable || Boolean(query) || !collapsed.includes(section.key);

	/** 数字键和方向键够得着的行：屏幕上有的，按绘制顺序。 */
	const reachable = sections.filter(opened).flatMap((section) => section.rows);
	/** 每个展开的分组在 reachable 里从哪开始，画了两次的星标模型就是两个位置。 */
	const starts = new Map<string, number>();
	sections.filter(opened).reduce((offset, section) => (starts.set(section.key, offset), offset + section.rows.length), 0);

	const at = Math.min(active, reachable.length - 1);

	useLayoutEffect(() => {
		if (!keyed.current) return;
		keyed.current = false;
		document.querySelector('[data-model-id][data-active="true"]')?.scrollIntoView({ block: "nearest" });
	}, [at]);

	// 没切成要说出来：不然输入框还显示原来的模型，和没按过一样。
	const apply = (modelId: string) => {
		if (!session) return;
		if (session.id === null) {
			session.setModel(modelId);
			return;
		}
		modelsAgent()
			.setSessionModel(session.id, modelId)
			.catch((cause: unknown) => onError(t("modelMenu.switchFailed", { reason: cause instanceof Error ? cause.message : String(cause) })));
	};

	const choose = (modelId: string) => {
		if (selection) {
			selection.onChange(modelId);
			onClose();
			return;
		}
		if (session?.said && current !== modelId) {
			confirmer.ask({
				title: t("modelMenu.midConfirm"),
				detail: (
					<>
						{t("modelMenu.midDetail1")}
						<br />
						{t("modelMenu.midDetail2")}
						<br />
						{t("modelMenu.midDetail3")}
						<br />
						{t("modelMenu.midDetail4")}
					</>
				),
				confirmLabel: t("modelMenu.confirmSwitch"),
				cancelLabel: t("common.cancel"),
				tone: "danger",
				onConfirm: () => {
					apply(modelId);
					onClose();
				},
			});
			return;
		}
		apply(modelId);
		onClose();
	};

	const fold = useCallback((key: string) => {
		setCollapsed((current) => {
			const next = current.includes(key) ? current.filter((each) => each !== key) : [...current, key];
			try {
				window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
			} catch {
				// 存不下的偏好，这次运行里照样算数。
			}
			return next;
		});
	}, []);

	const star = useCallback((id: string) => {
		const latest = modelsState();
		if (!latest) return;
		setError("");
		setFavoriteModels(toggleFavourite(latest.favoriteModelIds, id)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, []);

	// 方向键和回车来自一直拿着焦点的搜索框：打几个字母、回车选最上面那个，在长列表里找模型大多只要这么点功夫。
	const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (reachable.length === 0) return;
			event.preventDefault();
			keyed.current = true;
			setActive((at + (event.key === "ArrowDown" ? 1 : reachable.length - 1)) % reachable.length);
			return;
		}
		// 输入法还在组字时的回车是上屏，不是选模型。
		const row = reachable[at];
		if (event.key === "Enter" && !event.nativeEvent.isComposing && row) {
			event.preventDefault();
			choose(row.model.id);
		}
	};

	// 数字键选前几行，和行上画的数字对应。
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			// 正在输入的地方拥有输入的内容：可搜索的列表已经把数字让给了搜索框（见 searchable），这条兜住以后菜单里长出的别的输入框。
			const target = event.target;
			if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
			const index = Number(event.key) - 1;
			const row = reachable[index];
			if (!Number.isInteger(index) || index < 0 || index >= SHORTCUTS || !row) return;
			event.preventDefault();
			choose(row.model.id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<>
			<Popover
				anchor={anchor}
				onClose={onClose}
				placement={selection ? "bottom" : "top"}
				align={selection ? "end" : "start"}
				width={railed ? MODEL_MENU_RAIL_WIDTH : "wide"}
				label={t("modelMenu.pick")}
				// 可搜索的长列表过滤时保持高度：向上打开的卡片钉在底边，列表随输入变矮会把正在输入的搜索框连同左侧那一列拽下去。
				className={searchable ? "h-[420px]" : ""}
				aside={
					railed ? (
						<ModelRail
							houses={houses}
							favourites={hasStarred}
							value={view}
							onChange={(next) => {
								setPick(next);
								setActive(0);
							}}
						/>
					) : undefined
				}
				// 封顶：三十个模型的中转不会画出一个从输入框顶到屏幕上沿的菜单。正文在里面滚，上面的搜索框不动。
				maxHeight={MODEL_MENU_MAX_HEIGHT}
				header={
					searchable ? (
						<MenuSearch
							value={query}
							onChange={(next) => {
								setQuery(next);
								setActive(0);
							}}
							onKeyDown={onSearchKey}
							placeholder={t("modelMenu.search")}
						/>
					) : undefined
				}
			>
				<MenuBody>
					{error && (
						<p role="alert" className="px-2 py-1 text-detail text-danger">
							{error}
						</p>
					)}
					{/* 和下面的模型行一样是填底而不是打勾：它是这份列表里的一个选择，一个列表用两种方式标选中，就得读两遍。 */}
					{selection && !query && view === "all" && (
						<>
							<MenuItem
								icon={<Box size={14} />}
								selected={!current}
								detail={selection.inheritDetail ? <ScrollText text={selection.inheritDetail} /> : undefined}
								onClick={() => choose("")}
							>
								{selection.inheritLabel}
							</MenuItem>
							<MenuSeparator />
						</>
					)}
					{total === 0 && (
						<MenuItem
							onClick={() => {
								onOpenSettings();
								onClose();
							}}
						>
							{t("modelMenu.noModels")}
						</MenuItem>
					)}

					{total > 0 && sections.length === 0 && <p className="px-2 py-6 text-center text-detail text-ink-faint">{t("modelMenu.noMatch")}</p>}

					{sections.map((section) => {
						const folded = !opened(section);
						return (
							<div key={section.key}>
								<SectionHead title={section.title} count={section.rows.length} folded={folded} foldable={section.foldable} onFold={() => fold(section.key)} />
								{/* 行与行之间留一丝空隙，填了底的那行读起来是一张自己的卡片，而不是刷在整块列表上的一条。 */}
								{!folded && (
									<div className="flex flex-col gap-0.5">
										{section.rows.map((row, i) => {
											const index = (starts.get(section.key) ?? 0) + i;
											return (
												<ModelItem
													key={`${section.key}:${row.model.id}`}
													row={row}
													selected={current === row.model.id}
													starred={Boolean(favourites?.includes(row.model.id))}
													// 两家提供同一个名字：两行都说出是谁的。
													showProvider={clashes.has(row.model.name.trim().toLowerCase())}
													// 只在数字键真能这么用的地方画；见 searchable。
													numbered={!searchable && !query}
													shortcut={index < SHORTCUTS ? index + 1 : null}
													// 只在按键能作用于它的地方；见 onSearchKey。
													active={searchable ? index === at : undefined}
													onHover={(event) => hover(index, event)}
													onChoose={() => choose(row.model.id)}
													onStar={() => star(row.model.id)}
												/>
											);
										})}
									</div>
								)}
							</div>
						);
					})}
				</MenuBody>
			</Popover>
			{confirmer.element}
		</>
	);
}

/** 分组的标题，也是它的折叠开关。折起来时数量仍然显示——那是折起的分组唯一能说的；只有箭头会动，开合时这一行读起来一样。 */
function SectionHead({ title, count, folded, foldable, onFold }: { title: string; count: number; folded: boolean; foldable: boolean; onFold: () => void }) {
	if (!foldable) {
		return (
			<div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-caption text-ink-faint">
				<Star size={10} strokeWidth={2} className="fill-current" />
				{title}
				<span className="text-ink-faint/70">{count}</span>
			</div>
		);
	}

	return (
		<button
			type="button"
			aria-expanded={!folded}
			onClick={onFold}
			className="plume-item flex w-full items-center gap-1.5 px-2 py-1 text-caption text-ink-faint hover:text-ink-muted"
		>
			<ChevronRight size={11} strokeWidth={2.4} className={`shrink-0 transition-transform duration-[var(--plume-t-quick)] ${folded ? "" : "rotate-90"}`} />
			<span className="min-w-0 flex-1 truncate text-left">{title}</span>
			<span className="shrink-0 tabular-nums">{count}</span>
		</button>
	);
}

/**
 * 一个模型。是一行而不是 MenuItem，因为里面有两个目标：选这个模型、给它加星。星放在行自己的按钮里就是按钮套按钮——
 * 标记不合法，一次点击触发两个处理。所以底色属于行，两个控件并排放在里面，和侧栏的会话行一样。
 */
function ModelItem({
	row,
	selected,
	starred,
	showProvider,
	numbered,
	shortcut,
	active,
	onHover,
	onChoose,
	onStar,
}: {
	row: ModelRow;
	selected: boolean;
	starred: boolean;
	showProvider: boolean;
	/**
	 * 这个菜单发不发数字键，是菜单的事不是这一行的事——所以那一列要么每行都留、要么都不留。按行决定的话第五个模型的
	 * 窗口比第四个往右 13px，只有前四行对齐的一列看着像错误。可搜索的长列表里哪都没有数字，这一列也不画。
	 */
	numbered: boolean;
	shortcut: number | null;
	/** 方向键和回车是不是落在这一行。没有搜索框的列表里不给：没有键作用于高亮，画出来就是许了个空诺。 */
	active: boolean | undefined;
	onHover: (event: React.MouseEvent) => void;
	onChoose: () => void;
	onStar: () => void;
}) {
	const { t } = useI18n();
	const { model, provider } = row;

	return (
		// `plume-scroll` 让过长的名字悬停时自己滚一遍（ScrollText 的动画挂在带这个类的祖先的 :hover 上）。
		<div
			data-model-id={model.id}
			data-selected={selected ? "true" : undefined}
			data-nav={active === undefined ? undefined : ""}
			data-active={active ? "true" : undefined}
			onMouseMove={active === undefined ? undefined : onHover}
			className="plume-scroll plume-item plume-model-row flex h-[var(--plume-menu-row)] items-center"
		>
			<button type="button" role="menuitem" onClick={onChoose} className="flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-2 text-left text-label">
				{/* 厂商的标而不是供应商的：一个中转提供五家的模型，用供应商图标会每行都是同一个标。 */}
				<span className="flex w-[18px] shrink-0 items-center justify-center">
					<ModelIcon model={model.modelId} name={model.name} size={14} />
				</span>
				<span className="min-w-0 flex-1">
					<ScrollText text={showProvider ? `${model.name} · ${provider.name}` : model.name} />
				</span>
			</button>

			{/* 数字，在有数字的地方；见 numbered。选中的那一行用底色说明，不再要勾。 */}
			{numbered && <span className="flex h-full w-[13px] shrink-0 items-center justify-center font-mono text-caption text-ink-faint">{shortcut}</span>}

			{/*
			 * 一格两用、轮流占：上下文多大，和收没收藏。选的时候看窗口，选好了才去够星，两件事不会同时要。所以平时窗口占着，
			 * 指针上来换成星。宽度由窗口那几个字决定——星是绝对定位叠在上面的，改不了宽度——这样「1M」和「200K」长短不同，
			 * 每行右边缘仍在一条线上。左边 `pl-2.5` 是名字和窗口之间的空隙，没有它「claude-opus-4-2025」和「200K」在渐隐处连成一个词。
			 */}
			<span className="relative flex h-full shrink-0 items-center justify-end pr-3 pl-2.5 text-caption">
				<span className="plume-model-window font-mono text-ink-faint">
					{/* 生图模型没有上下文窗口可说；这一列留着对齐。 */}
					{isImageModel(model) ? "" : formatWindow(model.contextWindow)}
				</span>
				<button
					type="button"
					aria-label={starred ? t("modelMenu.unfavouriteOne", { name: model.name }) : t("modelMenu.favouriteOne", { name: model.name })}
					aria-pressed={starred}
					data-plume-tip={starred ? t("modelMenu.unfavourite") : t("modelMenu.favourite")}
					onClick={onStar}
					className={`plume-model-star absolute inset-0 flex items-center justify-end pr-3 ${starred ? "text-accent" : "text-ink-faint hover:text-ink"}`}
				>
					<Star size={12.5} strokeWidth={1.9} className={starred ? "fill-current" : ""} />
				</button>
			</span>
		</div>
	);
}
