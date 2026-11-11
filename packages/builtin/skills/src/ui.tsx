/**
 * plume.skills 的界面入口，跑在渲染进程：「插件市场」页里「技能 › 已安装」，`skill` 工具在转录里的说法。技能目录和 `skill` 工具在逻辑入口，
 * 这里按来源分组列出，开关、打开 SKILL.md、删除（整个目录移到废纸篓）。
 *
 * 市场在筛选条右端选的项目决定列哪个项目的技能（`.plume/skills`、`.claude/skills`、`.agents/skills`），不选只列个人的
 * （`~/.plume/skills`、`~/.agents/skills`）和插件带来的。
 */

import type { ExtensionsSectionProps, FileDiffProps, Remote, UiPlugin } from "@plume/contract/ui";
import { Button, IconButton, Text, Toggle, useConfirmer, useI18n } from "@plume/ui";
import {
	ArrowLeftRight,
	ChevronRight,
	CircleAlert,
	ExternalLink,
	Eye,
	EyeOff,
	FolderOpen,
	Sparkles,
	Trash2,
	TriangleAlert,
	WandSparkles,
} from "@plume/ui/icons";
import { type ComponentType, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { SkillRow, SkillsApi, SkillsView } from "./api.ts";
import type { SkillDiagnostic } from "./loader.ts";
import { type Messages, MESSAGES } from "./messages.ts";
import skillsCss from "./skills.css";

type Notify = (message: string, level?: "info" | "warn" | "error") => void;
type Diff = Awaited<ReturnType<SkillsApi["diff"]>>;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function mountStyles(): void {
	const id = "plume.skills";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = skillsCss;
}

function problemText(diagnostic: SkillDiagnostic, text: Messages): string {
	switch (diagnostic.problem) {
		case "unclosed":
			return text.unclosed;
		case "invalidYaml":
			return text.invalidYaml(diagnostic.detail ?? "");
		case "noDescription":
			return text.noDescription;
		case "longDescription":
			return text.longDescription;
		case "shortDescription":
			return text.shortDescription(diagnostic.detail ?? "");
		case "badName":
			return text.badName(diagnostic.detail ?? "");
		case "shadowed":
			return text.shadowed(diagnostic.detail ?? "");
	}
}

/** 按读来的目录分组，保持逻辑入口给的顺序（项目的在前，再是 `~/.plume/skills`）。 */
function groupByRoot(skills: SkillRow[]): { root: string; skills: SkillRow[] }[] {
	const groups = new Map<string, SkillRow[]>();
	for (const skill of skills) groups.set(skill.root, [...(groups.get(skill.root) ?? []), skill]);
	return [...groups].map(([root, rows]) => ({ root, skills: rows }));
}

/** 按带来它的插件分组，一个插件一张合集卡片。 */
function groupByPlugin(skills: SkillRow[]): { name: string; skills: SkillRow[] }[] {
	const groups = new Map<string, SkillRow[]>();
	for (const skill of skills) if (skill.plugin) groups.set(skill.plugin, [...(groups.get(skill.plugin) ?? []), skill]);
	return [...groups].map(([name, rows]) => ({ name, skills: rows }));
}

/** 字母标记的底色有几种（skills.css 的 `data-tint`）：按名字挑一种，同一个名字每次一样，一排卡片不至于一个颜色。 */
const TINTS = 6;
const tintOf = (name: string) => [...name].reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), 0) % TINTS;

function Mark({ name }: { name: string }) {
	return (
		<span className="skl-mark" data-tint={tintOf(name)} aria-hidden>
			<Text size="title" weight="semibold" className="skl-mark-letter">
				{(/[\p{L}\p{N}]/u.exec(name)?.[0] ?? "?").toUpperCase()}
			</Text>
		</span>
	);
}

/**
 * 插件根目录的 icon.png，和市场卡片、详情页是同一张（宿主的 `plume-plugin://<目录名>/` 发插件目录里的文件）；
 * 没提供或读不出来时用字母标记。
 */
function PluginMark({ name, pluginKey }: { name: string; pluginKey: string | undefined }) {
	const [failed, setFailed] = useState(false);
	if (!pluginKey || failed) return <Mark name={name} />;
	return (
		<img
			className="skl-plugin-icon"
			src={`plume-plugin://${pluginKey}/icon.png`}
			alt=""
			width={40}
			height={40}
			draggable={false}
			onError={() => setFailed(true)}
		/>
	);
}

/**
 * 「插件市场 › 技能 › 已安装」。看哪个项目、刷新由市场画在页头，经 `project`、`refreshKey` 交过来；这里按来源分组：
 * 项目的、个人的、插件带来的（一个插件一张合集卡片，点了打开那个插件的详情）、别的目录的。哪里有问题先在上面说一句，细节点开看，
 * 有问题的那张卡片上也标着。同名被遮住的收在最下面。
 */
function SkillsSettings({
	api,
	notify,
	FileDiff,
	project = null,
	refreshKey = 0,
	openPlugin,
}: { api: Remote<SkillsApi>; notify: Notify; FileDiff: ComponentType<FileDiffProps> } & ExtensionsSectionProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const cwd = project;
	const [view, setView] = useState<SkillsView | null>(null);
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	const confirmer = useConfirmer();

	// 换了项目以后，上一个项目晚到的列表不能落在这一个下面。
	const currentCwd = useRef(cwd);
	currentCwd.current = cwd;
	const refresh = useCallback(() => {
		void (async () => {
			const next = await api.list(cwd);
			if (currentCwd.current === cwd) setView(next);
		})().catch((error: unknown) => notify(text.readFailed(reasonOf(error)), "error"));
	}, [api, cwd, notify, text]);
	// 人在市场上点了刷新（refreshKey 变了）也重读。
	useEffect(refresh, [refresh, refreshKey]);
	// 技能在外面的编辑器里改，回到窗口时重读一遍，列表上才是刚写下的描述。
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	const skills = view?.skills ?? [];
	// 没加载的和加载了、值得看一眼的分开数，都按文件数：一个技能可能同时有两条。同名被盖住的另列，那是该有的样子，不算出错。
	const shadowed = (view?.diagnostics ?? []).filter((item) => item.problem === "shadowed");
	const failed = (view?.diagnostics ?? []).filter((item) => !item.warning && item.problem !== "shadowed");
	const warned = (view?.diagnostics ?? []).filter((item) => item.warning);

	const setEnabled = (targets: SkillRow[], enabled: boolean) => {
		const paths = targets.map((skill) => skill.path);
		// 先在界面上拨过去，存不下再读回真实状态。
		setView((current) => current && { ...current, skills: current.skills.map((skill) => (paths.includes(skill.path) ? { ...skill, enabled } : skill)) });
		void (async () => api.setEnabled(paths, enabled, cwd))().catch((error: unknown) => {
			notify(text.toggleFailed(reasonOf(error)), "error");
			refresh();
		});
	};

	const remove = (skill: SkillRow) =>
		confirmer.ask({
			title: text.deleteConfirm(skill.name),
			detail: text.deleteDetail,
			confirmLabel: text.delete,
			cancelLabel: text.cancel,
			onConfirm: () => {
				setPending((current) => new Set(current).add(skill.path));
				void (async () => api.remove(skill.path, cwd))()
					.catch((error: unknown) => notify(text.deleteFailed(reasonOf(error)), "error"))
					.finally(() => {
						setPending((current) => {
							const next = new Set(current);
							next.delete(skill.path);
							return next;
						});
						refresh();
					});
			},
		});

	const open = (path: string) => void (async () => api.open(path, cwd))().catch((error: unknown) => notify(reasonOf(error), "error"));
	const reveal = (path: string) => void (async () => api.reveal(path, cwd))().catch((error: unknown) => notify(reasonOf(error), "error"));

	const card = (skill: SkillRow) => (
		<SkillCard
			key={skill.path}
			skill={skill}
			problems={warned.filter((item) => item.path === skill.path)}
			busy={pending.has(skill.path)}
			onToggle={(enabled) => setEnabled([skill], enabled)}
			onOpen={() => open(skill.path)}
			onRemove={() => remove(skill)}
			text={text}
		/>
	);

	// 分组的顺序：项目的、个人的、插件带来的、别的目录的。
	const roots = groupByRoot(skills.filter((skill) => !skill.plugin));
	const projectGroups = roots.filter((group) => group.skills[0]?.project);
	const personal = roots.filter((group) => !group.skills[0]?.project && group.root === view?.dir);
	const others = roots.filter((group) => !group.skills[0]?.project && group.root !== view?.dir);
	const plugins = groupByPlugin(skills);

	const dirGroup = (title: string) => (group: { root: string; skills: SkillRow[] }) => {
		const anyOn = group.skills.some((skill) => skill.enabled);
		const first = group.skills[0];
		return (
			<section key={group.root} className="skl-group" data-skill-group={group.root}>
				<GroupHead title={title} count={group.skills.length} path={group.root}>
					<Button variant="ghost" size="sm" onClick={() => setEnabled(group.skills, !anyOn)}>
						{anyOn ? text.disableAll : text.enableAll}
					</Button>
					{first && (
						<Button variant="ghost" size="sm" onClick={() => reveal(first.path)}>
							{text.openDir}
						</Button>
					)}
				</GroupHead>
				<div className="skl-grid">{group.skills.map(card)}</div>
			</section>
		);
	};

	return (
		<div data-skills-settings="">
			<Notice tone="danger" title={text.failedToLoad(new Set(failed.map((item) => item.path)).size)} items={failed} text={text} />
			<Notice tone="warning" title={text.warnings(new Set(warned.map((item) => item.path)).size)} items={warned} text={text} />

			{view && skills.length === 0 ? (
				<div className="skl-empty">
					<Text size="label" weight="medium">
						{text.emptyTitle}
					</Text>
					<Text as="p" size="detail" tone="muted">
						{text.intro}
					</Text>
					<Text as="p" size="detail" tone="faint">
						{text.whatIsIt}
					</Text>
					<Text as="p" size="detail" tone="faint" mono>
						{view.dir}
					</Text>
				</div>
			) : (
				<>
					{projectGroups.map(dirGroup(text.project))}
					{personal.map(dirGroup(text.personal))}
					{plugins.length > 0 && (
						<section className="skl-group" data-skill-group="plugins">
							<GroupHead title={text.fromPlugins} count={plugins.length} />
							<div className="skl-grid">
								{plugins.map((bundle) => {
									const info = view?.bundles.find((entry) => entry.name === bundle.name);
									return (
										<BundleCard
											key={bundle.name}
											name={bundle.name}
											description={info?.description ?? ""}
											pluginKey={info?.key}
											skills={bundle.skills}
											{...(info && openPlugin ? { onOpen: () => openPlugin(info.key) } : {})}
											onToggle={(enabled) => setEnabled(bundle.skills, enabled)}
											text={text}
										/>
									);
								})}
							</div>
						</section>
					)}
					{others.map(dirGroup(text.otherDirs))}
				</>
			)}

			<ShadowedList entries={shadowed} api={api} cwd={cwd} notify={notify} onChanged={refresh} text={text} FileDiff={FileDiff} />
			{confirmer.element}
		</div>
	);
}

function GroupHead({ title, count, path, children }: { title: string; count: number; path?: string; children?: ReactNode }) {
	return (
		<div className="skl-group-head">
			<span className="skl-group-title">
				<Text size="body" weight="semibold">
					{title}
				</Text>
				<Text size="detail" tone="faint" numeric>
					{count}
				</Text>
				{path && (
					<Text size="caption" tone="faint" mono className="skl-group-path">
						{path}
					</Text>
				)}
			</span>
			{children && <span className="skl-group-actions">{children}</span>}
		</div>
	);
}

function SkillCard({
	skill,
	problems,
	busy,
	onToggle,
	onOpen,
	onRemove,
	text,
}: {
	skill: SkillRow;
	problems: SkillDiagnostic[];
	busy: boolean;
	onToggle: (enabled: boolean) => void;
	onOpen: () => void;
	onRemove: () => void;
	text: Messages;
}) {
	return (
		<div className="skl-card" data-skill-row={skill.name} data-off={!skill.enabled || undefined}>
			<Mark name={skill.name} />
			<span className="skl-card-body">
				<span className="skl-card-title">
					<Text size="label" weight="medium" className="skl-card-name">
						{skill.name}
					</Text>
					<span className="skl-card-actions">
						<IconButton size="sm" label={text.openNamed(skill.name)} icon={<ExternalLink size={13} />} onClick={onOpen} />
						{!skill.plugin && <IconButton size="sm" label={text.deleteNamed(skill.name)} disabled={busy} icon={<Trash2 size={13} />} onClick={onRemove} />}
					</span>
					<Toggle checked={skill.enabled} onChange={onToggle} ariaLabel={text.enableNamed(skill.name)} />
				</span>
				<Text size="detail" tone="muted" className="skl-card-detail">
					{skill.description}
				</Text>
				{(problems.length > 0 || skill.manualOnly) && (
					<span className="skl-card-foot">
						{problems.map((item) => (
							<span key={item.problem} className="skl-card-problem" data-plume-tip={problemText(item, text)}>
								<TriangleAlert size={12} strokeWidth={2} aria-hidden />
								<Text size="caption" className="skl-warning">
									{text.problemLabel[item.problem]}
								</Text>
							</span>
						))}
						{skill.manualOnly && (
							<Text size="caption" tone="accent" className="skl-badge">
								{text.manualOnly}
							</Text>
						)}
					</span>
				)}
			</span>
		</div>
	);
}

/** 一个插件带来的技能，合成一张卡片：开关一次拨它带的全部；点卡片打开那个插件的详情，它带了哪些技能那里的介绍里写着。 */
function BundleCard({
	name,
	description,
	pluginKey,
	skills,
	onOpen,
	onToggle,
	text,
}: {
	name: string;
	description: string;
	/** 插件目录名：取它的图标、打开它的详情。 */
	pluginKey: string | undefined;
	skills: SkillRow[];
	onOpen?: () => void;
	onToggle: (enabled: boolean) => void;
	text: Messages;
}) {
	const anyOn = skills.some((skill) => skill.enabled);
	return (
		<div className="skl-card skl-bundle" data-skill-pack={name} data-off={!anyOn || undefined}>
			{/* 点击区在下面：开关是按钮，按钮里不能再放按钮。 */}
			{onOpen && <button type="button" className="skl-bundle-hit" onClick={onOpen} aria-label={text.openPluginDetail(name)} />}
			<PluginMark key={pluginKey} name={name} pluginKey={pluginKey} />
			<span className="skl-card-body">
				<span className="skl-card-title">
					<Text size="label" weight="medium" className="skl-card-name">
						{name}
					</Text>
					<Text size="caption" className="skl-pack-tag">
						{text.bundleTag(skills.length)}
					</Text>
					<span className="skl-bundle-toggle">
						<Toggle checked={anyOn} onChange={onToggle} ariaLabel={text.enableBundle(name)} />
					</span>
				</span>
				<Text size="detail" tone="muted" className="skl-card-detail">
					{description || skills.map((skill) => skill.name).join(", ")}
				</Text>
			</span>
		</div>
	);
}

/** 上面一句话说哪里有问题，细节点「查看」展开：一长串路径和原因常驻在页顶，比下面的技能还占地方。 */
function Notice({ tone, title, items, text }: { tone: "danger" | "warning"; title: string; items: SkillDiagnostic[]; text: Messages }) {
	const [open, setOpen] = useState(false);
	if (items.length === 0) return null;
	return (
		<div className="skl-notice" data-tone={tone} role="status">
			<span className="skl-notice-line">
				{tone === "danger" ? <CircleAlert size={14} strokeWidth={2} aria-hidden /> : <TriangleAlert size={14} strokeWidth={2} aria-hidden />}
				<Text size="detail" tone="muted" className="skl-notice-title">
					{title}
				</Text>
				<Button variant="ghost" size="sm" expanded={open} onClick={() => setOpen(!open)}>
					{open ? text.collapse : text.show}
				</Button>
			</span>
			{open &&
				items.map((item) => (
					<Text key={`${item.path}:${item.problem}`} as="p" size="detail" tone="muted" className="skl-notice-item">
						<Text size="detail" mono>
							{item.path}
						</Text>
						{` — ${problemText(item, text)}`}
					</Text>
				))}
		</div>
	);
}

/**
 * 同名的技能谁盖了谁。光列出来回答的是「我写的那个怎么没生效」；接下来要问的是「留哪个」，得看得到差在哪、
 * 不打开文件就能改：每行能展开成 diff（赢的在前，「+」是改用之后会多出来的），「改用那个」写下偏好，再说写在了哪里。
 */
function ShadowedList({
	entries,
	api,
	cwd,
	notify,
	onChanged,
	text,
	FileDiff,
}: {
	entries: SkillDiagnostic[];
	api: Remote<SkillsApi>;
	cwd: string | null;
	notify: Notify;
	onChanged: () => void;
	text: Messages;
	FileDiff: ComponentType<FileDiffProps>;
}) {
	// 改用之后两行互换：输的那个成了赢家、离开这张表，换上来的是另一个文件的新行，所以写到哪了记在表上、按名字记。
	const [wrote, setWrote] = useState<Record<string, { chosen: string; wroteTo: string }>>({});
	const [open, setOpen] = useState(false);
	if (entries.length === 0) return null;
	const prefer = async (name: string, path: string) => {
		const result = await api.prefer(name, path, cwd);
		setWrote((was) => ({ ...was, [name]: { chosen: path, wroteTo: result.wroteTo } }));
		onChanged();
	};
	return (
		// 不画成警告，收在最下面：覆盖就是这么用的，项目里的同名技能比你的更具体。
		<div className="skl-shadowed" data-open={open || undefined}>
			<button type="button" className="skl-shadowed-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<ChevronRight size={14} strokeWidth={1.9} aria-hidden className="skl-shadowed-caret" />
				<Text size="label" tone="muted">
					{text.shadowedHeader}
				</Text>
				<Text size="detail" tone="faint" numeric>
					{entries.length}
				</Text>
			</button>
			{open &&
				entries.map((entry) => (
					<ShadowedRow
						key={entry.path}
						entry={entry}
						api={api}
						cwd={cwd}
						notify={notify}
						prefer={prefer}
						wrote={entry.name ? wrote[entry.name] : undefined}
						text={text}
						FileDiff={FileDiff}
					/>
				))}
		</div>
	);
}

function ShadowedRow({
	entry,
	api,
	cwd,
	notify,
	prefer,
	wrote,
	text,
	FileDiff,
}: {
	entry: SkillDiagnostic;
	api: Remote<SkillsApi>;
	cwd: string | null;
	notify: Notify;
	prefer: (name: string, path: string) => Promise<void>;
	wrote?: { chosen: string; wroteTo: string };
	text: Messages;
	FileDiff: ComponentType<FileDiffProps>;
}) {
	const [open, setOpen] = useState(false);
	const [shown, setShown] = useState<Diff | null>(null);
	const [busy, setBusy] = useState(false);
	const winner = entry.detail ?? "";
	const toggle = () => {
		const next = !open;
		setOpen(next);
		if (next && !shown)
			void (async () => setShown(await api.diff(winner, entry.path, cwd)))().catch((error: unknown) => notify(text.diffFailed(reasonOf(error)), "error"));
	};
	const switchTo = () => {
		if (!entry.name) return;
		setBusy(true);
		void prefer(entry.name, entry.path)
			.catch((error: unknown) => notify(text.preferFailed(reasonOf(error)), "error"))
			.finally(() => setBusy(false));
	};
	return (
		<div className="skl-shadowed-row" data-shadowed={entry.name}>
			<span className="skl-shadowed-line">
				<Text size="detail" tone="faint">
					<Text size="detail" mono>
						{entry.path}
					</Text>
					{` ${text.shadowedBy} `}
					<Text size="detail" mono>
						{winner}
					</Text>
					{text.shadowedBySuffix && ` ${text.shadowedBySuffix}`}
				</Text>
				<IconButton
					size="xs"
					label={open ? text.hideDiff : text.showDiff}
					onClick={toggle}
					icon={open ? <EyeOff size={12} strokeWidth={1.9} aria-hidden /> : <Eye size={12} strokeWidth={1.9} aria-hidden />}
				/>
				{/* 改用之后还在：那时这一行是另一个文件，这就是改回去的路。 */}
				<IconButton size="xs" label={text.useThat} disabled={busy} onClick={switchTo} icon={<ArrowLeftRight size={12} strokeWidth={1.9} aria-hidden />} />
			</span>
			{wrote && (
				<Text as="p" size="caption" tone="muted">
					{`${text.nowUsing} `}
					<Text size="caption" mono>
						{wrote.chosen}
					</Text>
					{`${text.preferenceIn} `}
					<Text size="caption" mono>
						{wrote.wroteTo}
					</Text>
				</Text>
			)}
			{open && (
				<div className="skl-shadowed-diff">
					{shown === null ? (
						<Text as="p" size="caption" tone="faint" className="skl-shadowed-note">
							{text.readingBoth}
						</Text>
					) : shown.hunks.length === 0 ? (
						<Text as="p" size="caption" tone="faint" className="skl-shadowed-note">
							{text.identical}
						</Text>
					) : (
						<>
							<Text as="p" size="caption" tone="faint" className="skl-shadowed-note">
								{text.diffLegend(shown.added, shown.removed)}
							</Text>
							<FileDiff hunks={shown.hunks} path={entry.path} />
						</>
					)}
				</div>
			)}
		</div>
	);
}

export default {
	name: "plume.skills",
	apply(ui) {
		mountStyles();
		const api = ui.remote<SkillsApi>();
		const notify = ui.notify.bind(ui);
		// 加载技能是动手前翻一下说明，和读文件、跑命令接成一段；那一行点名加载的是哪一份。
		ui.toolLine("skill", {
			verb: (locale) => MESSAGES[locale].toolVerb,
			subject: (args) => (typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined),
			group: "skill",
			icon: Sparkles,
		});
		ui.settingsSection("skills", (props) => <SkillsSettings api={api} notify={notify} FileDiff={ui.FileDiff} {...props} />, {
			title: (locale) => MESSAGES[locale].settingsTitle,
			icon: WandSparkles,
			page: "extensions-skills",
			actions: [
				{
					label: (locale) => MESSAGES[locale].openPersonalDir,
					detail: (locale) => MESSAGES[locale].openPersonalDirDetail,
					icon: FolderOpen,
					run: () => void (async () => api.reveal(null, null))().catch((error: unknown) => notify(reasonOf(error), "error")),
				},
			],
		});
	},
} satisfies UiPlugin;
