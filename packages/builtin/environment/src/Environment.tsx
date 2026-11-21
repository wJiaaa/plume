import type { ImageContent, SessionView } from "@plume/contract";
import type { ConversationCardProps, EnvironmentPlace, EnvironmentSectionEntry, UiContext } from "@plume/contract/ui";
import { EnvironmentRow, IconButton, MenuBody, MenuItem, MenuLabel, Popover, ScrollText, Text, useI18n, useNow, usePopover } from "@plume/ui";
import { Bot, File, Layers, Settings2 } from "@plume/ui/icons";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { MESSAGES } from "./messages.ts";
import type { EnvironmentState } from "./state.ts";

/** 界面入口给卡片和开关的：宿主的 `ui` 和本插件的状态。 */
export interface Runtime {
	ui: UiContext;
	state: EnvironmentState;
}

/**
 * 卡片自己有三项可藏的内容：页头的打开方式、宿主知道的子会话、消息里的引用。别的内容经 `ui.environmentSection` 登记，
 * `place` 决定它属于摘要、后台、产出还是页脚，插件身份不再成为卡片里的层级。
 */
const OWN = { openIn: 0, children: 20, references: 90 } as const;
type SectionName = keyof typeof OWN;
const SECTIONS = Object.keys(OWN) as SectionName[];
const LABEL_KEY = {
	openIn: "sectionOpenIn",
	children: "childSessions",
	references: "references",
} as const;
const KEY = "plume.environment.card";
const listeners = new Set<() => void>();
/** `hidden` 里是自己几节的名字和别的插件那几节的 `key`（`插件名/id`）。 */
function read(): { open: boolean; hidden: string[] } {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		const value: Record<string, unknown> = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		return {
			open: value.open === true,
			hidden: Array.isArray(value.hidden) ? value.hidden.filter((entry): entry is string => typeof entry === "string") : [],
		};
	} catch {
		return { open: false, hidden: [] };
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
export function EnvironmentToggle({ session, runtime }: { session: SessionView; runtime: Runtime }) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const { open, hidden } = usePrefs();
	const extra = runtime.ui.useEnvironmentSections();
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
				size="sm"
				label={label}
				active={open}
				expanded={open}
				data-environment-toggle
				icon={
					<span className="plume-environment-toggle">
						<Layers size={13} />
						{noted.length > 0 && <span aria-hidden data-environment-dot className="plume-environment-toggle-dot" />}
					</span>
				}
				onClick={() => update({ open: !open })}
			/>
		</>
	);
}

/**
 * 后台、产出、引用三块共用的外壳。行来自几个异步插件，不能在 React 数据上先数；观察标准行和引用签的 `data-environment-item`，
 * 标题右边的数字才跟实际画出来的一致。没有内容时整块由 CSS 撤下，不留标题和分隔线。
 */
function Group({ name, label, children }: { name: string; label: string; children: ReactNode }) {
	const ref = useRef<HTMLElement>(null);
	const [count, setCount] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => setCount(element.querySelectorAll("[data-environment-item]").length);
		measure();
		const observer = new MutationObserver(measure);
		observer.observe(element, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, []);
	return (
		<section ref={ref} className="plume-environment-group" data-environment-group={name}>
			<Text as="h3" size="caption" tone="faint" className="plume-environment-group-label">
				{label}
				{count > 0 && <span>{count}</span>}
			</Text>
			<div className="plume-environment-group-content">{children}</div>
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

function elapsed(at: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function EnvironmentBody({
	session,
	runtime,
	extra,
	onChooseSections,
}: {
	session: SessionView;
	runtime: Runtime;
	extra: readonly EnvironmentSectionEntry[];
	onChooseSections: (target: HTMLElement) => void;
}) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const { hidden } = usePrefs();
	const data = runtime.state.useChildren(session.summary.id, true);
	const [allReferences, setAllReferences] = useState(false);
	const now = useNow(true, 1000);
	const id = session.summary.id;
	const children = data.children
		.filter((child) => child.title.trim() !== "")
		.sort((a, b) => Number(b.running) - Number(a.running) || a.createdAt - b.createdAt);
	const files = session.messages.flatMap((message) => (message.role === "user" ? (message.attachments?.filter((file) => file.path) ?? []) : []));
	const uniqueFiles = [...new Map(files.map((file) => [file.path!, file])).values()];
	const images = session.messages.flatMap((message) =>
		message.role === "user" || message.role === "toolResult"
			? message.content.filter((part): part is ImageContent => part.type === "image" && Boolean(part.media || part.data))
			: [],
	);
	const pictures = [...new Map(images.map((image) => [image.media || image.data, image])).values()];
	const entries = (place: EnvironmentPlace) => extra.filter((entry) => entry.place === place && !hidden.includes(entry.key)).sort((a, b) => a.order - b.order);
	const project = session.summary.cwd.match(/[^\\/]+(?=[\\/]*$)/)?.[0] ?? session.summary.cwd;
	return (
		<>
			<header className="plume-environment-card-head">
				<div className="plume-environment-place">
					<Text size="label" weight="semibold" className="plume-environment-project" data-plume-tip={session.summary.cwd}>
						{project}
					</Text>
					{!hidden.includes("openIn") && <runtime.ui.ProjectOpener path={session.summary.cwd} compact />}
				</div>
				<ExtraSections entries={entries("head")} session={session} />
			</header>
			<div className="plume-environment-card-body">
				<Group name="background" label={words.backgroundGroup}>
					<ExtraSections entries={entries("background")} session={session} />
				</Group>
				<Group name="output" label={words.output}>
					{!hidden.includes("children") && children.length > 0 && (
						<section className="plume-environment-card-section" data-environment-section="children">
							{children.map((child) => (
								<EnvironmentRow
									key={child.id}
									icon={<Bot size={14} />}
									title={child.title}
									fact={child.running ? elapsed(child.createdAt, now) : child.stop?.reason === "aborted" ? words.paused : words.done}
									running={child.running}
									onClick={() => runtime.state.openChild(id, child.id)}
									data-environment-child={child.id}
								/>
							))}
						</section>
					)}
					<ExtraSections entries={entries("output")} session={session} />
				</Group>
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
									onClick={() => void runtime.ui.openFile(file.path!, id).catch((error: unknown) => runtime.ui.notify(String(error), "error"))}
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
										const src = image.media ? runtime.ui.mediaUrl(image.media) : `data:${image.mimeType};base64,${image.data}`;
										return (
											<button
												type="button"
												key={image.media || image.data || index}
												className="plume-environment-image"
												data-environment-item
												onClick={(event) =>
													runtime.ui.openImage(
														pictures.map((picture) => ({
															src: picture.media ? runtime.ui.mediaUrl(picture.media) : `data:${picture.mimeType};base64,${picture.data}`,
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
				{data.error && (
					<Text as="p" size="caption" tone="danger" className="plume-environment-error" role="alert">
						{data.error}
					</Text>
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
export function EnvironmentCard({ session, placement, runtime }: ConversationCardProps & { runtime: Runtime }) {
	const { resolvedLocale } = useI18n();
	const words = MESSAGES[resolvedLocale];
	const { open, hidden } = usePrefs();
	const extra = runtime.ui.useEnvironmentSections();
	const menu = usePopover();
	const [wasOpen, setWasOpen] = useState(open);
	const [leaving, setLeaving] = useState(false);
	if (wasOpen !== open) {
		setWasOpen(open);
		setLeaving(!open);
	}
	if (!open && !leaving) return null;
	const items = [
		...SECTIONS.map((name) => ({ key: name, order: OWN[name], label: words[LABEL_KEY[name]] })),
		...extra.map((entry) => ({ key: entry.key, order: entry.order, label: typeof entry.label === "function" ? entry.label(resolvedLocale) : entry.label })),
	].sort((a, b) => a.order - b.order);
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
				<EnvironmentBody key={session.summary.id} session={session} runtime={runtime} extra={extra} onChooseSections={menu.openAt} />
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
