import type { ImageContent, SessionView } from "@plume/contract";
import type { ConversationCardProps, EnvironmentSectionEntry, UiContext } from "@plume/contract/ui";
import { IconButton, MenuBody, MenuItem, MenuLabel, Popover, ScrollText, Text, useI18n, usePopover } from "@plume/ui";
import { Bot, File, Layers, Settings2 } from "@plume/ui/icons";
import { Fragment, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { MESSAGES } from "./messages.ts";
import type { EnvironmentState } from "./state.ts";

/** 界面入口给卡片和开关的：宿主的 `ui` 和本插件的状态。 */
export interface Runtime {
	ui: UiContext;
	state: EnvironmentState;
}

/**
 * 卡片自己的几节和它们在卡片里的位置：只是和会话本身有关、不用别的插件的数据的这几样。别的节都经 `ui.environmentSection` 登记、
 * 按 order 排进这几节之间（现在有后台任务 10、计划 30、建议的新会话 40、定时唤醒 50、拉取请求 60、会话摘要 80、压缩记录 85），
 * 所以这里的 order 留着空档。卡片不认是哪个插件登记的，那个插件没装或停用了，只是少一节。
 * `children` 是插件建的子会话，按建它的插件（`owner`）分成几节，一个插件一节，在菜单里作为一项一起开关。
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
 * 卡片收着时，各节经 `attention` 报的事在按钮上挂一个圆点，那句话按节的 order 接在说明后面：等人决定的（建议的新会话还没人点开始），
 * 或会自己叫醒会话的（在跑的监视、待触发的定时唤醒）。人把那一节关掉了就不再提醒。
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
function Section({ name, label, children }: { name: string; label?: string; children: ReactNode }) {
	return (
		<section data-environment-section={name} className="plume-environment-card-section">
			{label && (
				<div className="plume-environment-section-label">
					<Text size="caption" tone="faint">
						{label}
					</Text>
				</div>
			)}
			{children}
		</section>
	);
}

function EnvironmentBody({ session, runtime, extra }: { session: SessionView; runtime: Runtime; extra: readonly EnvironmentSectionEntry[] }) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const { hidden } = usePrefs();
	const data = runtime.state.useChildren(session.summary.id, true);
	const displayName = runtime.ui.usePluginDisplayName();
	const [allReferences, setAllReferences] = useState(false);
	const id = session.summary.id;
	const children = data.children
		.filter((child) => child.title.trim() !== "")
		.sort((a, b) => Number(b.running) - Number(a.running) || a.createdAt - b.createdAt);
	/*
	 * 按建它的插件分节，节名是那个插件的显示名（`ui.usePluginDisplayName`），查不到时是通用的「子会话」：插件名不给人看，
	 * 这里也不认哪个插件是做什么的。
	 * 先出现的插件在前（各节内部的顺序同上：在跑的在前，再按建的先后）。
	 */
	const owners = new Map<string, typeof children>();
	for (const child of children) owners.set(child.owner ?? "", [...(owners.get(child.owner ?? "") ?? []), child]);
	const files = session.messages.flatMap((message) => (message.role === "user" ? (message.attachments?.filter((file) => file.path) ?? []) : []));
	const uniqueFiles = [...new Map(files.map((file) => [file.path!, file])).values()];
	const images = session.messages.flatMap((message) =>
		message.role === "user" || message.role === "toolResult"
			? message.content.filter((part): part is ImageContent => part.type === "image" && Boolean(part.media || part.data))
			: [],
	);
	const pictures = [...new Map(images.map((image) => [image.media || image.data, image])).values()];
	const openChild = (childId: string) => runtime.state.openChild(id, childId);
	const childRows = (rows: typeof children) =>
		rows.slice(0, 5).map((child) => (
			<button type="button" key={child.id} className="plume-environment-row" onClick={() => openChild(child.id)}>
				<Bot size={14} />
				<Text size="detail" className="plume-environment-grow">
					<ScrollText text={child.title} />
				</Text>
				<Text size="caption" tone="faint">
					{child.running ? words.active : child.stop?.reason === "aborted" ? words.paused : words.done}
				</Text>
			</button>
		));
	const own: Record<SectionName, ReactNode> = {
		openIn: (
			<Section name="openIn">
				<runtime.ui.ProjectOpener path={session.summary.cwd} />
			</Section>
		),
		children: owners.size > 0 && (
			<>
				{[...owners].map(([owner, rows]) => (
					<Section key={owner} name={`children:${owner}`} label={(owner && displayName(owner)) || words.childSessions}>
						{childRows(rows)}
						{rows.length > 5 && (
							<button type="button" className="plume-environment-row" onClick={() => runtime.ui.openPanel("children", id)}>
								<Text size="caption" tone="faint">
									{words.more(rows.length - 5)}
								</Text>
							</button>
						)}
					</Section>
				))}
			</>
		),
		references: (uniqueFiles.length > 0 || pictures.length > 0) && (
			<Section name="references" label={words.references}>
				{pictures.length > 0 && (
					<div className="plume-environment-pictures">
						{(allReferences ? pictures : pictures.slice(0, 8)).map((image, index) => {
							const src = image.media ? runtime.ui.mediaUrl(image.media) : `data:${image.mimeType};base64,${image.data}`;
							return (
								<button
									type="button"
									key={index}
									className="plume-environment-image"
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
				{(allReferences ? uniqueFiles : uniqueFiles.slice(0, 8)).map((file) => (
					<button
						type="button"
						key={file.path}
						className="plume-environment-row"
						data-plume-tip={file.path}
						onClick={() => void runtime.ui.openFile(file.path!, id).catch((error: unknown) => runtime.ui.notify(String(error), "error"))}
					>
						<File size={14} />
						<Text size="detail" className="plume-environment-grow">
							<ScrollText text={file.name} />
						</Text>
					</button>
				))}
				{!allReferences && (uniqueFiles.length > 8 || pictures.length > 8) && (
					<button type="button" className="plume-environment-row" onClick={() => setAllReferences(true)}>
						<Text size="caption" tone="faint">
							{words.more(Math.max(0, uniqueFiles.length - 8) + Math.max(0, pictures.length - 8))}
						</Text>
					</button>
				)}
			</Section>
		),
	};
	// 自己的几节和别的插件加的按 order 排在一起；别的插件那一节没东西时返回 null，`:empty` 让它不占位、不画分隔线。
	const order = [
		...SECTIONS.map((name) => ({ key: name, order: OWN[name], node: own[name] })),
		...extra.map((entry) => ({
			key: entry.key,
			order: entry.order,
			node: (
				<section className="plume-environment-card-section" data-environment-section={entry.key}>
					<entry.component session={session} />
				</section>
			),
		})),
	]
		.filter((entry) => !hidden.includes(entry.key))
		.sort((a, b) => a.order - b.order);
	return (
		<>
			{data.error && (
				<Text as="p" size="caption" tone="danger" role="alert">
					{data.error}
				</Text>
			)}
			{order.map((entry) => (
				<Fragment key={entry.key}>{entry.node}</Fragment>
			))}
		</>
	);
}

export function EnvironmentCard({ session, placement, runtime }: ConversationCardProps & { runtime: Runtime }) {
	const { resolvedLocale } = useI18n();
	const words = MESSAGES[resolvedLocale];
	const { open, hidden } = usePrefs();
	const extra = runtime.ui.useEnvironmentSections();
	const menu = usePopover();
	if (!open) return null;
	const items = [
		...SECTIONS.map((name) => ({ key: name, order: OWN[name], label: words[LABEL_KEY[name]] })),
		...extra.map((entry) => ({ key: entry.key, order: entry.order, label: typeof entry.label === "function" ? entry.label(resolvedLocale) : entry.label })),
	].sort((a, b) => a.order - b.order);
	return (
		<div data-environment className="plume-environment-card" data-placement={placement}>
			<div className="plume-environment-card-head">
				<Text size="label" tone="muted" className="plume-environment-grow">
					{words.environment}
				</Text>
				<IconButton size="sm" label={words.sections} active={menu.open} icon={<Settings2 size={13} />} onClick={menu.toggle} />
			</div>
			<div className="plume-environment-card-body">
				<EnvironmentBody key={session.summary.id} session={session} runtime={runtime} extra={extra} />
			</div>
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end">
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
