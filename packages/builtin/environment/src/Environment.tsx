import type { ImageContent, Locale, SessionView } from "@plume/contract";
import type { ConversationCardProps, EnvironmentPlace, EnvironmentSectionEntry, LocalizedText, UiContext } from "@plume/contract/ui";
import { Caret, IconButton, MenuBody, MenuItem, MenuLabel, Popover, ScrollText, Text, useI18n, usePopover } from "@plume/ui";
import { File, Settings2, SquareMenu } from "@plume/ui/icons";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { MESSAGES } from "./messages.ts";

function labelOf(label: LocalizedText, locale: Locale): string {
	return typeof label === "function" ? label(locale) : label;
}

/**
 * 卡片自己有两项可藏的内容：页头的打开方式、消息里的引用。别的内容（项目脚本、版本控制、后台任务、定时任务、子智能体、计划、关联会话、拉取请求……）
 * 都经 `ui.environmentSection` 登记：`head` 紧跟页头，`vcs` 独立成块紧跟页头且不画组标题，`background` 与 `output` 的每一节按各自 `label` 独立成组，`foot` 放在卡片页脚。
 */
const PLACE_ORDER: readonly EnvironmentPlace[] = ["head", "vcs", "background", "output", "foot"];
const OWN: Record<"openIn" | "references", { place: EnvironmentPlace; order: number }> = {
	openIn: { place: "head", order: 0 },
	references: { place: "output", order: 90 },
};
type SectionName = keyof typeof OWN;
const SECTIONS = Object.keys(OWN) as SectionName[];
const LABEL_KEY = {
	openIn: "sectionOpenIn",
	references: "references",
} as const;
const KEY = "plume.environment.card";
const listeners = new Set<() => void>();
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
/**
 * `hidden` 里是自己几节的名字和别的插件那几节的 `key`（`插件名/id`）；`collapsed` 是收起的分组，记法相同。
 * 藏起来的一节整个撤下、也不再点亮开关；收起的只折起行，标题留着，提醒照旧。
 */
function read(): { open: boolean; hidden: string[]; collapsed: string[] } {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		const value: Record<string, unknown> = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		return { open: value.open === true, hidden: strings(value.hidden), collapsed: strings(value.collapsed) };
	} catch {
		return { open: false, hidden: [], collapsed: [] };
	}
}
let prefs = read();
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
function update(value: Partial<typeof prefs>) {
	prefs = { ...prefs, ...value };
	try {
		localStorage.setItem(KEY, JSON.stringify(prefs));
	} catch {
		/* 不能保存时保留本窗口的选择。 */
	}
	for (const listener of listeners) listener();
}
function usePrefs() {
	return useSyncExternalStore(subscribe, () => prefs);
}

/**
 * 标题栏上开关环境卡片的那颗，开着就亮。
 *
 * 卡片收着时，各节经 `attention` 报的事在按钮上挂一个圆点，那句话按节的 order 接在说明后面：会自己叫醒会话的监视、检查和定时任务。
 * 人把那一节关掉了就不再提醒。普通的长跑服务不提醒。
 */
export function EnvironmentToggle({ session, ui }: { session: SessionView; ui: UiContext }) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const { open, hidden } = usePrefs();
	const extra = ui.useEnvironmentSections();
	const [asks, setAsks] = useState<Record<string, string>>({});
	// 每一节一个固定的回调：probe 的 effect 按它判断要不要重报。
	const reporters = useMemo(() => new Map<string, (text: string | undefined) => void>(), []);
	const reporter = (key: string) => {
		let report = reporters.get(key);
		if (!report) {
			report = (text) =>
				setAsks((current) => {
					if (current[key] === text) return current;
					const next = { ...current };
					if (text === undefined) delete next[key];
					else next[key] = text;
					return next;
				});
			reporters.set(key, report);
		}
		return report;
	};
	const watched = open ? [] : extra.filter((entry) => entry.attention && !hidden.includes(entry.key));
	const noted = watched.flatMap((entry) => (asks[entry.key] ? [asks[entry.key]!] : []));
	const label = [words.environment, ...noted].join(" · ");
	return (
		<>
			{watched.map((entry) => {
				const Probe = entry.attention!;
				return <Probe key={entry.key} session={session} onChange={reporter(entry.key)} />;
			})}
			<IconButton
				size="md"
				label={label}
				active={open}
				expanded={open}
				data-environment-toggle
				icon={
					<span className="plume-environment-toggle">
						<SquareMenu size={15} strokeWidth={1.75} />
						{noted.length > 0 && <span aria-hidden data-environment-dot className="plume-environment-toggle-dot" />}
					</span>
				}
				onClick={() => update({ open: !open })}
			/>
		</>
	);
}

/**
 * 每个独立分区共用的外壳。行来自各异步插件，不能在 React 数据上先数；需要显示条数时观察标准行和引用签的 `data-environment-item`，
 * 标题右边的数字才跟实际画出来的一致。没有内容时整块由 CSS 撤下，不留标题和分隔线。
 *
 * 点标题收起、展开这一组，跨会话记着。收起时内容仍挂着：条数、「有没有内容」的 CSS 判断都靠画出来的行。
 * 收起后标题总是带条数（`count: false` 的组也带，不然看不出折了多少），有行在跑时再挂一个绿点。
 */
function Group({ name, label, showCount = true, children }: { name: string; label: string; showCount?: boolean; children: ReactNode }) {
	const ref = useRef<HTMLElement>(null);
	const { collapsed } = usePrefs();
	const open = !collapsed.includes(name);
	const [count, setCount] = useState(0);
	const [running, setRunning] = useState(false);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			setCount(element.querySelectorAll("[data-environment-item]").length);
			setRunning(element.querySelector(".plume-env-row-icon[data-running]") !== null);
		};
		measure();
		const observer = new MutationObserver(measure);
		observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-running"] });
		return () => observer.disconnect();
	}, []);
	return (
		<section ref={ref} className="plume-environment-group" data-environment-group={name}>
			<Text as="h3" size="caption" tone="faint" weight="medium" className="plume-environment-group-label">
				<button
					type="button"
					aria-expanded={open}
					data-environment-group-toggle
					onClick={() => update({ collapsed: open ? [...collapsed, name] : collapsed.filter((entry) => entry !== name) })}
				>
					{label}
					{(showCount || !open) && count > 0 && <span className="plume-environment-group-count">{count}</span>}
					{!open && running && <span aria-hidden data-environment-group-running className="plume-environment-group-running" />}
					<Caret open={open} from="right" size={11} />
				</button>
			</Text>
			{/* 不用 `Collapse`：它收着挂上时不画内容，整组会被当成空的撤掉。这里和 `Disclosure` 一样一直画着，只折起高度。 */}
			<div className="plume-reveal" data-open={open} aria-hidden={!open} inert={!open}>
				<div>
					<div className="plume-environment-group-content">{children}</div>
				</div>
			</div>
		</section>
	);
}

function ExtraSections({ entries, session }: { entries: readonly EnvironmentSectionEntry[]; session: SessionView }) {
	return entries.map((entry) => (
		<section key={entry.key} className="plume-environment-card-section" data-environment-section={entry.key}>
			<entry.component session={session} />
		</section>
	));
}

function EnvironmentBody({
	session,
	ui,
	extra,
	onChooseSections,
}: {
	session: SessionView;
	ui: UiContext;
	extra: readonly EnvironmentSectionEntry[];
	onChooseSections: (target: HTMLElement) => void;
}) {
	const { resolvedLocale } = useI18n();
	const words = MESSAGES[resolvedLocale];
	const { hidden } = usePrefs();
	const [allReferences, setAllReferences] = useState(false);
	const id = session.summary.id;
	const files = session.messages.flatMap((message) => (message.role === "user" ? (message.attachments?.filter((file) => file.path) ?? []) : []));
	const uniqueFiles = [...new Map(files.map((file) => [file.path!, file])).values()];
	const images = session.messages.flatMap((message) =>
		message.role === "user" || message.role === "toolResult"
			? message.content.filter((part): part is ImageContent => part.type === "image" && Boolean(part.media || part.data))
			: [],
	);
	const pictures = [...new Map(images.map((image) => [image.media || image.data, image])).values()];
	const entries = (place: EnvironmentPlace) => extra.filter((entry) => entry.place === place && !hidden.includes(entry.key)).sort((a, b) => a.order - b.order);
	return (
		<>
			<header className="plume-environment-card-head">
				{!hidden.includes("openIn") && (
					<section className="plume-environment-card-section" data-environment-section="openIn">
						<ui.ProjectOpener path={session.summary.cwd} />
					</section>
				)}
				<ExtraSections entries={entries("head")} session={session} />
			</header>
			<div className="plume-environment-card-vcs">
				<ExtraSections entries={entries("vcs")} session={session} />
			</div>
			<div className="plume-environment-card-body">
				{[...entries("background"), ...entries("output")].map((entry) => (
					<Group key={entry.key} name={entry.key} label={labelOf(entry.label, resolvedLocale)} showCount={entry.count}>
						<section className="plume-environment-card-section" data-environment-section={entry.key}>
							<entry.component session={session} />
						</section>
					</Group>
				))}
				{!hidden.includes("references") && (uniqueFiles.length > 0 || pictures.length > 0) && (
					<Group name="references" label={words.references}>
						<section className="plume-environment-card-section" data-environment-section="references">
							{(allReferences ? uniqueFiles : uniqueFiles.slice(0, 8)).map((file) => (
								<button
									type="button"
									key={file.path}
									className="plume-environment-reference"
									data-environment-item
									data-plume-tip={file.path}
									onClick={() => void ui.openFile(file.path!, id).catch((error: unknown) => ui.notify(String(error), "error"))}
								>
									<File size={12} />
									<Text size="caption" className="plume-environment-reference-name">
										<ScrollText text={file.name} />
									</Text>
								</button>
							))}
							{pictures.length > 0 && (
								<div className="plume-environment-pictures">
									{(allReferences ? pictures : pictures.slice(0, 8)).map((image, index) => {
										const src = image.media ? ui.mediaUrl(image.media) : `data:${image.mimeType};base64,${image.data}`;
										return (
											<button
												type="button"
												key={image.media || image.data || index}
												className="plume-environment-image"
												data-environment-item
												onClick={(event) =>
													ui.openImage(
														pictures.map((picture) => ({
															src: picture.media ? ui.mediaUrl(picture.media) : `data:${picture.mimeType};base64,${picture.data}`,
														})),
														index,
														{ from: event.currentTarget },
													)
												}
											>
												<img src={src} alt={`${words.references} ${index + 1}`} loading="lazy" />
											</button>
										);
									})}
								</div>
							)}
							{!allReferences && (uniqueFiles.length > 8 || pictures.length > 8) && (
								<button type="button" className="plume-environment-more" onClick={() => setAllReferences(true)}>
									<Text size="caption" tone="faint">
										{words.more(Math.max(0, uniqueFiles.length - 8) + Math.max(0, pictures.length - 8))}
									</Text>
								</button>
							)}
						</section>
					</Group>
				)}
			</div>
			<div className="plume-environment-card-empty">
				<button type="button" onClick={(event) => onChooseSections(event.currentTarget)}>
					<Settings2 size={14} />
					<Text size="caption" tone="faint">
						{words.chooseSections}
					</Text>
				</button>
			</div>
			<footer className="plume-environment-card-foot">
				<ExtraSections entries={entries("foot")} session={session} />
			</footer>
		</>
	);
}

/**
 * 浮在转录右上角的实底会话仪表卡。「显示哪些内容」有两个入口：在卡片上右键（链接、选中的字照旧用自己的菜单），
 * 和各节都藏起来、卡片空了时露出的恢复入口。菜单点一项后保持打开，便于连续勾选。
 *
 * 收起时先播完离开的动画再拆掉：开关从开变关的那次渲染里立起 `leaving`，卡片的动画播完放下。减少动态效果时全局规则把动画
 * 压到 0.01ms，结束事件照常来。
 */
export function EnvironmentCard({ session, placement, ui }: ConversationCardProps & { ui: UiContext }) {
	const { resolvedLocale } = useI18n();
	const words = MESSAGES[resolvedLocale];
	const { open, hidden } = usePrefs();
	const extra = ui.useEnvironmentSections();
	const menu = usePopover();
	const [wasOpen, setWasOpen] = useState(open);
	const [leaving, setLeaving] = useState(false);
	if (wasOpen !== open) {
		setWasOpen(open);
		setLeaving(!open);
	}
	if (!open && !leaving) return null;
	const items = [
		...SECTIONS.map((name) => ({ key: name, place: OWN[name].place, order: OWN[name].order, label: words[LABEL_KEY[name]] })),
		...extra.map((entry) => ({ key: entry.key, place: entry.place, order: entry.order, label: labelOf(entry.label, resolvedLocale) })),
	].sort((a, b) => PLACE_ORDER.indexOf(a.place) - PLACE_ORDER.indexOf(b.place) || a.order - b.order);
	return (
		<div
			data-environment
			className="plume-environment"
			data-placement={placement}
			data-leaving={leaving ? "" : undefined}
			onContextMenu={(event) => {
				const target = event.target as Element;
				const selection = window.getSelection();
				if (target.closest("input, textarea, [contenteditable], a[href]") || (selection && !selection.isCollapsed)) return;
				event.preventDefault();
				event.stopPropagation();
				menu.openAtPoint(event);
			}}
		>
			<div
				className="plume-environment-card"
				onAnimationEnd={(event) => {
					if (event.target === event.currentTarget && !open) setLeaving(false);
				}}
			>
				<EnvironmentBody key={session.summary.id} session={session} ui={ui} extra={extra} onChooseSections={menu.openAt} />
			</div>
			{open && menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="start" role="menu" label={words.sections}>
					<MenuBody>
						<MenuLabel>{words.sections}</MenuLabel>
						{items.map((item) => (
							<MenuItem
								key={item.key}
								checked={!hidden.includes(item.key)}
								onClick={() => update({ hidden: hidden.includes(item.key) ? hidden.filter((entry) => entry !== item.key) : [...hidden, item.key] })}
							>
								{item.label}
							</MenuItem>
						))}
					</MenuBody>
				</Popover>
			)}
		</div>
	);
}
