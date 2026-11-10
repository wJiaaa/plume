import type { ImageContent, SessionView, SessionWakeup } from "@plume/contract";
import type { ConversationCardProps, EnvironmentSectionEntry } from "@plume/contract/ui";
import { IconButton, MenuBody, MenuItem, MenuLabel, Popover, ScrollText, Text, useI18n, usePopover } from "@plume/ui";
import { AlarmClock, Bot, File, History, Layers, MessageCircle, Settings2, Square, X } from "@plume/ui/icons";
import { Fragment, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { object } from "./entries.ts";
import { MESSAGES } from "./messages.ts";
import type { Runtime } from "./state.tsx";

/**
 * 卡片自己的几节和它们在卡片里的位置。别的插件经 `ui.environmentSection` 加的节（批准过的计划、建议的新会话、当前分支的拉取请求、
 * 会话摘要）按 order 排进这几节之间，所以这里的 order 留着空档：30 是计划、40 是建议的新会话、60 是拉取请求、80 是会话摘要的位置。
 */
const OWN = { openIn: 0, jobs: 10, children: 20, wakeups: 50, sideChats: 70, compactions: 85, references: 90 } as const;
type SectionName = keyof typeof OWN;
const SECTIONS = Object.keys(OWN) as SectionName[];
const LABEL_KEY = {
	openIn: "sectionOpenIn",
	jobs: "jobs",
	children: "children",
	wakeups: "wakeups",
	sideChats: "sideChats",
	compactions: "compactions",
	references: "references",
} as const;
const KEY = "plume.diagnostics.environment";
const listeners = new Set<() => void>();
/** `hidden` 里是自己几节的名字和别的插件那几节的 `key`（`插件名/id`）。 */
function read(): { open: boolean; hidden: string[] } {
	try {
		const value = object(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
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
 * 卡片收着时，会自己叫醒会话的东西在按钮上挂一个圆点：待触发的定时唤醒（过一会儿自己开一轮），在跑的 `monitor`（有输出就开一轮）。
 * 普通后台命令不算——开着一个开发服务器是常态，算进去圆点就一直亮着。别的插件那几节有事等人决定时也挂（`attention`：
 * 建议的新会话还没人点开始），那句话接在说明后面。人把那一节关掉了就不再提醒。
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
	const data = runtime.state.useSnapshot(session.summary.id, !open);
	const monitors = !open && !hidden.includes("jobs") ? data.jobs.filter((job) => job.kind === "monitor" && job.finishedAt === undefined).length : 0;
	const scheduled = !open && !hidden.includes("wakeups") ? data.wakeups.length : 0;
	const label = [
		words.environment,
		...(scheduled ? [words.pendingWakeups(scheduled)] : []),
		...(monitors ? [words.runningMonitors(monitors)] : []),
		...noted,
	].join(" · ");
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
					<span className="plume-diagnostics-toggle">
						<Layers size={13} />
						{scheduled + monitors + noted.length > 0 && <span aria-hidden data-environment-dot className="plume-diagnostics-toggle-dot" />}
					</span>
				}
				onClick={() => update({ open: !open })}
			/>
		</>
	);
}
function Section({ name, label, children }: { name: string; label?: string; children: ReactNode }) {
	return (
		<section data-environment-section={name} className="plume-diagnostics-environment-section">
			{label && (
				<div className="plume-diagnostics-section-label">
					<Text size="caption" tone="faint">
						{label}
					</Text>
				</div>
			)}
			{children}
		</section>
	);
}

/** 今天的只写时刻，别的日子带上日期。 */
function when(at: number, locale: string): string {
	const sameDay = new Date(at).toDateString() === new Date().toDateString();
	return new Intl.DateTimeFormat(
		locale,
		sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
	).format(at);
}

/** 和对话里送达那一行同一句：唤醒写了理由用理由，否则是 prompt 的第一行。 */
function wakeupLabel(wakeup: SessionWakeup): string {
	return wakeup.reason?.trim() || (wakeup.prompt.split("\n").find((line) => line.trim()) ?? "").trim();
}

/**
 * 模型给这个对话安排的定时唤醒，还没触发的那些。对话里那次工具调用很快就被顶上去了，而它说的事要几分钟、几小时后才发生——
 * 这一节回答「它还会不会自己动起来、什么时候」，每一项都能当场取消。节底那一句说清楚它们只活在这次运行里。
 */
function Wakeups({ id, wakeups, runtime }: { id: string; wakeups: SessionWakeup[]; runtime: Runtime }) {
	const { resolvedLocale } = useI18n();
	const words = MESSAGES[resolvedLocale];
	const cancel = (wakeupId: string) =>
		void runtime.api
			.cancelWakeup(id, wakeupId)
			.then(() => runtime.state.refresh(id))
			.catch((error: unknown) => runtime.ui.notify(String(error), "error"));
	return (
		<>
			{wakeups.map((wakeup) => {
				const meta = [
					when(wakeup.nextAt, resolvedLocale),
					wakeup.recurring ? words.wakeupRecurring : words.wakeupOnce,
					...(wakeup.expiresAt !== undefined ? [words.wakeupExpires(when(wakeup.expiresAt, resolvedLocale))] : []),
				].join(" · ");
				return (
					<div key={wakeup.id} className="plume-diagnostics-wakeup" data-environment-wakeup={wakeup.id}>
						<AlarmClock size={14} />
						{/* 悬停读到完整的 prompt 和 cron 表达式：行里只放得下一句。 */}
						<div className="plume-diagnostics-grow" data-plume-tip={wakeup.cron ? `${wakeup.cron}\n${wakeup.prompt}` : wakeup.prompt}>
							<Text as="p" size="label" className="plume-diagnostics-truncate">
								{wakeupLabel(wakeup)}
							</Text>
							<Text as="p" size="caption" tone="muted" numeric className="plume-diagnostics-truncate">
								{meta}
							</Text>
						</div>
						<IconButton size="xs" label={words.wakeupCancel} icon={<X size={12} />} onClick={() => cancel(wakeup.id)} data-wakeup-cancel />
					</div>
				);
			})}
			<Text as="p" size="caption" tone="faint" className="plume-diagnostics-note">
				{words.wakeupMemoryOnly}
			</Text>
		</>
	);
}

function EnvironmentBody({ session, runtime, extra }: { session: SessionView; runtime: Runtime; extra: readonly EnvironmentSectionEntry[] }) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const { hidden } = usePrefs();
	const data = runtime.state.useSnapshot(session.summary.id, true, true);
	const [busy, setBusy] = useState<string>();
	const [allReferences, setAllReferences] = useState(false);
	const id = session.summary.id;
	const jobs = data.jobs.filter((job) => job.finishedAt === undefined);
	const children = data.children
		.filter((child) => child.title.trim() !== "")
		.sort((a, b) => Number(b.running) - Number(a.running) || a.createdAt - b.createdAt);
	const subagents = children.filter((child) => child.owner !== "plume.side-chat");
	const sides = children.filter((child) => child.owner === "plume.side-chat");
	const files = session.messages.flatMap((message) => (message.role === "user" ? (message.attachments?.filter((file) => file.path) ?? []) : []));
	const uniqueFiles = [...new Map(files.map((file) => [file.path!, file])).values()];
	const images = session.messages.flatMap((message) =>
		message.role === "user" || message.role === "toolResult"
			? message.content.filter((part): part is ImageContent => part.type === "image" && Boolean(part.media || part.data))
			: [],
	);
	const pictures = [...new Map(images.map((image) => [image.media || image.data, image])).values()];
	const openChild = (childId: string) => {
		runtime.state.select(id, { child: childId });
		runtime.ui.openPanel("child", id);
	};
	const stop = async (jobId: string) => {
		setBusy(jobId);
		try {
			await runtime.api.stop(id, jobId, false);
			await runtime.state.refresh(id);
		} catch (error) {
			runtime.ui.notify(String(error), "error");
		} finally {
			setBusy(undefined);
		}
	};
	const childRows = (rows: typeof children, side: boolean) =>
		rows.slice(0, 5).map((child) => (
			<button type="button" key={child.id} className="plume-diagnostics-row" onClick={() => openChild(child.id)}>
				{side ? <MessageCircle size={14} /> : <Bot size={14} />}
				<Text size="detail" className="plume-diagnostics-grow">
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
		jobs: jobs.length > 0 && (
			<Section name="jobs" label={words.jobs}>
				{jobs.map((job) => {
					const port = job.endpoints[0]?.port;
					return (
						<div key={job.id} className="plume-diagnostics-heading" data-environment-job={job.id}>
							<button
								type="button"
								className="plume-diagnostics-row plume-diagnostics-grow"
								data-plume-tip={job.kind === "monitor" ? `${words.monitorTip}\n${job.command}` : job.command}
								onClick={() => runtime.openJob(id, job.id)}
							>
								<span className="plume-diagnostics-dot" data-status="running" />
								<Text size="detail" mono className="plume-diagnostics-grow">
									<ScrollText text={job.description || job.command} />
								</Text>
								{/* 和普通后台命令分开：它每送一批输出就是一轮，人得认得出哪一行在持续花钱。 */}
								{job.kind === "monitor" && (
									<Text size="caption" tone="muted" data-environment-monitor>
										{words.monitor}
									</Text>
								)}
								{port !== undefined && (
									<Text size="caption" tone="faint" numeric data-environment-port>
										:{port}
									</Text>
								)}
							</button>
							<IconButton
								size="sm"
								label={words.stop}
								disabled={busy === job.id || job.status === "stopping"}
								icon={<Square size={11} />}
								onClick={() => void stop(job.id)}
							/>
						</div>
					);
				})}
			</Section>
		),
		children: subagents.length > 0 && (
			<Section name="children" label={words.children}>
				{childRows(subagents, false)}
				{subagents.length > 5 && (
					<button type="button" className="plume-diagnostics-row" onClick={() => runtime.ui.openPanel("children", id)}>
						<Text size="caption" tone="faint">
							{words.more(subagents.length - 5)}
						</Text>
					</button>
				)}
			</Section>
		),
		wakeups: data.wakeups.length > 0 && (
			<Section name="wakeups" label={words.wakeups}>
				<Wakeups id={id} wakeups={data.wakeups} runtime={runtime} />
			</Section>
		),
		sideChats: sides.length > 0 && (
			<Section name="sideChats" label={words.sideChats}>
				{childRows(sides, true)}
				{sides.length > 5 && (
					<button type="button" className="plume-diagnostics-row" onClick={() => runtime.ui.openPanel("children", id)}>
						<Text size="caption" tone="faint">
							{words.more(sides.length - 5)}
						</Text>
					</button>
				)}
			</Section>
		),
		compactions: session.compactionRuns.length > 0 && (
			<Section name="compactions" label={words.compactions}>
				<button type="button" className="plume-diagnostics-row" onClick={() => runtime.openTrace(id)}>
					<History size={14} />
					<Text size="detail" className="plume-diagnostics-grow">
						{words.summary}
					</Text>
					<Text size="caption" tone="faint" numeric>
						{session.compactionRuns.length}
					</Text>
				</button>
			</Section>
		),
		references: (uniqueFiles.length > 0 || pictures.length > 0) && (
			<Section name="references" label={words.references}>
				{pictures.length > 0 && (
					<div className="plume-diagnostics-pictures">
						{(allReferences ? pictures : pictures.slice(0, 8)).map((image, index) => {
							const src = image.media ? runtime.ui.mediaUrl(image.media) : `data:${image.mimeType};base64,${image.data}`;
							return (
								<button
									type="button"
									key={index}
									className="plume-diagnostics-image"
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
						className="plume-diagnostics-row"
						data-plume-tip={file.path}
						onClick={() => void runtime.ui.openFile(file.path!, id).catch((error: unknown) => runtime.ui.notify(String(error), "error"))}
					>
						<File size={14} />
						<Text size="detail" className="plume-diagnostics-grow">
							<ScrollText text={file.name} />
						</Text>
					</button>
				))}
				{!allReferences && (uniqueFiles.length > 8 || pictures.length > 8) && (
					<button type="button" className="plume-diagnostics-row" onClick={() => setAllReferences(true)}>
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
				<section className="plume-diagnostics-environment-section" data-environment-section={entry.key}>
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
		<div data-environment className="plume-diagnostics-environment" data-placement={placement}>
			<div className="plume-diagnostics-environment-head">
				<Text size="label" tone="muted" className="plume-diagnostics-grow">
					{words.environment}
				</Text>
				<IconButton size="sm" label={words.sections} active={menu.open} icon={<Settings2 size={13} />} onClick={menu.toggle} />
			</div>
			<div className="plume-diagnostics-environment-body">
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
