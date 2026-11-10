/**
 * plume.skills 的界面入口，跑在渲染进程：「扩展」页里「技能」那一类，`skill` 工具在转录里的说法。技能目录和 `skill` 工具在逻辑入口，
 * 这里按目录分组列出，开关、打开 SKILL.md、删除（整个目录移到废纸篓）。
 *
 * 上方的项目选择决定列哪个项目的技能（`.plume/skills`、`.claude/skills`、`.agents/skills`），不选只列个人的
 * （`~/.plume/skills`、`~/.agents/skills`）和插件带来的。
 */

import type { FileDiffProps, ProjectInfo, Remote, UiPlugin } from "@plume/contract/ui";
import {
	Button,
	IconButton,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	Popover,
	SearchField,
	SettingsCard,
	Text,
	Toggle,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import {
	ArrowLeftRight,
	Check,
	ChevronDown,
	ExternalLink,
	Eye,
	EyeOff,
	Folder,
	FolderOpen,
	Layers,
	Monitor,
	RefreshCw,
	Sparkles,
	Trash2,
	WandSparkles,
} from "@plume/ui/icons";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
		case "allowedTools": {
			const tools = diagnostic.tools;
			if (!tools) return "";
			if (tools.kind === "notList") return text.toolsNotList(tools.items[0] ?? "");
			if (tools.kind === "strays") return text.toolsStrays(tools.items);
			if (tools.kind === "scoped") return text.toolsScoped(tools.widened ?? [], tools.items);
			if (tools.kind === "unmatched") return text.toolsUnmatched(tools.items);
			return text.toolsServerWide(tools.items);
		}
	}
}

/**
 * 看的是哪个项目的技能，null 是只看个人的。放在组件外面：活在这次运行里，切到别的类、离开「扩展」再回来还停在上次看的那个。
 */
let shownProject: string | null = null;

/** 同一个目录登记成几个项目时只算一项：技能按目录读，名字连在一起。 */
function folders(projects: readonly ProjectInfo[]): { path: string; name: string }[] {
	const byPath = new Map<string, string[]>();
	for (const project of projects) byPath.set(project.path, [...(byPath.get(project.path) ?? []), project.name]);
	return [...byPath].map(([path, names]) => ({ path, name: names.join(" / ") }));
}

/** 按读来的目录分组，保持逻辑入口给的顺序（项目的在前，再是 `~/.plume/skills`）。 */
function groupByRoot(skills: SkillRow[]): { root: string; skills: SkillRow[] }[] {
	const groups = new Map<string, SkillRow[]>();
	for (const skill of skills) groups.set(skill.root, [...(groups.get(skill.root) ?? []), skill]);
	return [...groups].map(([root, rows]) => ({ root, skills: rows }));
}

function SkillsSettings({
	api,
	notify,
	FileDiff,
	projects,
}: {
	api: Remote<SkillsApi>;
	notify: Notify;
	FileDiff: ComponentType<FileDiffProps>;
	projects: readonly ProjectInfo[];
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const choices = useMemo(() => folders(projects), [projects]);
	const [projectPath, setProjectPath] = useState(shownProject);
	// 项目被移除后回到个人的，而不是继续读一个已经不在列表里的目录。
	const project = choices.find((entry) => entry.path === projectPath) ?? null;
	const cwd = project?.path ?? null;
	const [view, setView] = useState<SkillsView | null>(null);
	const [query, setQuery] = useState("");
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	const confirmer = useConfirmer();

	const choose = (path: string | null) => {
		shownProject = path;
		setProjectPath(path);
	};

	// 换了项目以后，上一个项目晚到的列表不能落在这一个下面。
	const currentCwd = useRef(cwd);
	currentCwd.current = cwd;
	const refresh = useCallback(() => {
		void (async () => {
			const next = await api.list(cwd);
			if (currentCwd.current === cwd) setView(next);
		})().catch((error: unknown) => notify(text.readFailed(reasonOf(error)), "error"));
	}, [api, cwd, notify, text]);
	useEffect(refresh, [refresh]);
	// 技能在外面的编辑器里改，回到窗口时重读一遍，列表上才是刚写下的描述。
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	const skills = view?.skills ?? [];
	const needle = query.trim().toLowerCase();
	const visible = skills.filter((skill) => !needle || `${skill.name} ${skill.description}`.toLowerCase().includes(needle));
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

	return (
		<div data-skills-settings="">
			<div className="skl-toolbar">
				<ProjectScope value={project} choices={choices} onChange={choose} text={text} />
				<div className="skl-toolbar-actions">
					{skills.length > 0 && <SearchField value={query} onChange={setQuery} placeholder={text.searchPlaceholder} className="skl-search" />}
					<IconButton
						label={text.openPersonalDir}
						icon={<FolderOpen size={15} strokeWidth={1.8} aria-hidden />}
						onClick={() => void (async () => api.reveal())().catch((error: unknown) => notify(reasonOf(error), "error"))}
					/>
					<IconButton label={text.refresh} icon={<RefreshCw size={14} strokeWidth={1.8} aria-hidden />} onClick={refresh} />
				</div>
			</div>
			<Problems title={text.failedToLoad(new Set(failed.map((item) => item.path)).size)} items={failed} text={text} />
			<Problems title={text.warnings(new Set(warned.map((item) => item.path)).size)} items={warned} text={text} />
			<ShadowedList entries={shadowed} api={api} cwd={cwd} notify={notify} onChanged={refresh} text={text} FileDiff={FileDiff} />

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
			) : view && visible.length === 0 ? (
				<div className="skl-empty">
					<Text size="label" tone="faint">
						{text.searchEmpty}
					</Text>
				</div>
			) : (
				groupByRoot(visible).map((group) => {
					const anyOn = group.skills.some((skill) => skill.enabled);
					return (
						<section key={group.root} className="skl-group" data-skill-group={group.root}>
							<div className="skl-group-head">
								<span className="skl-group-title">
									<Text size="body" weight="medium">
										{group.skills[0]?.plugin
											? text.pluginGroup(group.skills[0].plugin)
											: `${group.skills[0]?.project ? text.project : text.personal} · ${group.root}`}
									</Text>
									<Text size="detail" tone="faint" numeric>
										{group.skills.length}
									</Text>
								</span>
								<Button variant="ghost" size="sm" onClick={() => setEnabled(group.skills, !anyOn)}>
									{anyOn ? text.disableAll : text.enableAll}
								</Button>
							</div>
							<div className="skl-grid">
								{group.skills.map((skill) => (
									<div key={skill.path} className="skl-card" data-skill-row={skill.name} data-off={!skill.enabled || undefined}>
										<span className="skl-card-mark" aria-hidden>
											<WandSparkles size={18} strokeWidth={1.7} />
										</span>
										<span className="skl-card-body">
											<span className="skl-card-title">
												<Text size="label" weight="medium" className="skl-card-name">
													{skill.name}
												</Text>
												<span className="skl-card-actions">
													<IconButton size="sm" label={text.openNamed(skill.name)} icon={<ExternalLink size={13} />} onClick={() => open(skill.path)} />
													{!skill.plugin && (
														<IconButton
															size="sm"
															label={text.deleteNamed(skill.name)}
															disabled={pending.has(skill.path)}
															icon={<Trash2 size={13} />}
															onClick={() => remove(skill)}
														/>
													)}
												</span>
												<Toggle checked={skill.enabled} onChange={(enabled) => setEnabled([skill], enabled)} ariaLabel={text.enableNamed(skill.name)} />
											</span>
											<Text size="detail" tone="muted" className="skl-card-detail">
												{skill.description}
											</Text>
											{skill.manualOnly && (
												<span className="skl-card-foot">
													<Text size="caption" tone="accent" className="skl-badge">
														{text.manualOnly}
													</Text>
												</span>
											)}
										</span>
									</div>
								))}
							</div>
						</section>
					);
				})
			)}
			{confirmer.element}
		</div>
	);
}

function Problems({ title, items, text }: { title: string; items: SkillDiagnostic[]; text: Messages }) {
	if (items.length === 0) return null;
	const warning = items.every((item) => item.warning);
	return (
		<div className="skl-problems" role="status">
			<Text size="label" weight="medium" tone={warning ? "accent" : "danger"}>
				{title}
			</Text>
			{items.map((item) => (
				<Text key={`${item.path}:${item.problem}`} as="p" size="detail" tone="muted">
					<Text size="detail" mono>
						{item.path}
					</Text>
					{` — ${problemText(item, text)}`}
				</Text>
			))}
		</div>
	);
}

/** 看哪个项目的技能：个人的，或某一个项目的（连个人的、插件带来的一起列）。 */
function ProjectScope({
	value,
	choices,
	onChange,
	text,
}: {
	value: { path: string; name: string } | null;
	choices: { path: string; name: string }[];
	onChange: (path: string | null) => void;
	text: Messages;
}) {
	const menu = usePopover();
	const option = (choice: { path: string; name: string } | null) => {
		const chosen = (choice?.path ?? null) === (value?.path ?? null);
		return (
			<MenuItem
				key={choice?.path ?? ""}
				selected={chosen}
				icon={choice ? <Folder size={14} strokeWidth={1.8} /> : <Monitor size={14} strokeWidth={1.8} />}
				trailing={chosen ? <Check size={13} strokeWidth={2.2} /> : undefined}
				onClick={() => {
					onChange(choice?.path ?? null);
					menu.close();
				}}
			>
				{choice?.name ?? text.personal}
			</MenuItem>
		);
	};
	return (
		<>
			<button
				type="button"
				onClick={menu.toggle}
				aria-label={text.projectScope}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				data-project-scope=""
				className="skl-scope"
			>
				{value ? <Folder size={14} strokeWidth={1.8} /> : <Monitor size={14} strokeWidth={1.8} />}
				<Text size="label" className="skl-scope-name">
					{value?.name ?? text.personal}
				</Text>
				<ChevronDown size={13} strokeWidth={1.9} className="skl-scope-caret" data-open={menu.open || undefined} />
			</button>
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="start" width="default" maxHeight={MENU_MAX_HEIGHT}>
					<MenuBody insetIcons>
						{option(null)}
						{choices.length > 0 && (
							<>
								<MenuSeparator />
								<MenuLabel>{text.project}</MenuLabel>
								{choices.map(option)}
							</>
						)}
					</MenuBody>
				</Popover>
			)}
		</>
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
	if (entries.length === 0) return null;
	const prefer = async (name: string, path: string) => {
		const result = await api.prefer(name, path, cwd);
		setWrote((was) => ({ ...was, [name]: { chosen: path, wroteTo: result.wroteTo } }));
		onChanged();
	};
	return (
		<div className="skl-shadowed-card">
			<SettingsCard>
				{/* 不画成警告：覆盖就是这么用的，项目里的同名技能比你的更具体。 */}
				<div className="skl-shadowed">
					<span className="skl-shadowed-head">
						<Layers size={13} strokeWidth={1.9} aria-hidden />
						<Text size="label" tone="muted">
							{text.shadowedHeader(entries.length)}
						</Text>
					</span>
					{entries.map((entry) => (
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
			</SettingsCard>
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
		ui.settingsSection("skills", () => <SkillsSettings api={api} notify={notify} FileDiff={ui.FileDiff} projects={ui.useProjects()} />, {
			title: (locale) => MESSAGES[locale].settingsTitle,
			icon: WandSparkles,
			page: "extensions-skills",
		});
	},
} satisfies UiPlugin;
