/**
 * plume.commands 的界面入口，跑在渲染进程：设置页里「命令」那一节。`/` 菜单本身是产品的，命令经逻辑入口的
 * `ctx.commands` 供过去，这里不用画。
 *
 * 设置页顶上选看哪一层：个人的（`~/.plume/commands`、`~/.claude/commands`），或某一个项目的（`<项目>/.plume/commands`、
 * `<项目>/.claude/commands`）。项目来自 `ui.useProjects()`。
 */

import type { ListedCommand, ProjectInfo, Remote, UiPlugin } from "@plume/contract/ui";
import {
	Button,
	Dialog,
	IconButton,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	Popover,
	Segmented,
	SettingsCard,
	Text,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import { Check, ChevronDown, Folder, FolderOpen, Monitor, Plus, RefreshCw, SquareTerminal, Trash2 } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandRow, CommandsApi, CommandsView } from "./api.ts";
import commandsCss from "./commands.css";
import type { CommandDiagnostic, CommandScope } from "./loader.ts";
import { type Messages, MESSAGES } from "./messages.ts";

type Notify = (message: string, level?: "info" | "warn" | "error") => void;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function mountStyles(): void {
	const id = "plume.commands";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = commandsCss;
}

function problemText(diagnostic: CommandDiagnostic, text: Messages): string {
	switch (diagnostic.problem) {
		case "unclosed":
			return text.unclosed;
		case "badName":
			return text.badName(diagnostic.detail ?? "");
		case "shadowed":
			return text.shadowed(diagnostic.detail ?? "");
		case "badDeliver":
			return text.badDeliver(diagnostic.detail ?? "");
		default:
			return text.unreadable;
	}
}

/**
 * 看的是哪个项目的命令，null 是个人的。放在组件外面：活在这次运行里，离开设置页再回来还停在上次看的那个。
 */
let shownProject: string | null = null;

/** 一个文件夹一个选择：几个项目登记在同一个文件夹上时，命令按目录读，名字连在一起。 */
function folders(projects: readonly ProjectInfo[]): { path: string; name: string }[] {
	const byPath = new Map<string, string[]>();
	for (const project of projects) byPath.set(project.path, [...(byPath.get(project.path) ?? []), project.name]);
	return [...byPath].map(([path, names]) => ({ path, name: names.join(" / ") }));
}

function originText(command: CommandRow, text: Messages): string {
	if (command.origin === "claude") return command.scope === "workspace" ? text.claudeProject : text.claudePersonal;
	return command.scope === "workspace" ? text.project : text.personal;
}

/** 列 `/` 菜单里全部命令的那个口子（`ui.listCommands`）。 */
type ListAll = (context: { cwd?: string }) => Promise<ListedCommand[]>;

function CommandsSettings({
	api,
	listAll,
	notify,
	projects,
}: {
	api: Remote<CommandsApi>;
	listAll: ListAll;
	notify: Notify;
	projects: readonly ProjectInfo[];
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const choices = useMemo(() => folders(projects), [projects]);
	const [projectPath, setProjectPath] = useState(shownProject);
	// 项目被移除后回到个人的，而不是继续读一个已经不在列表里的目录。
	const project = choices.find((entry) => entry.path === projectPath) ?? null;
	const cwd = project?.path ?? null;
	const scope: CommandScope = project ? "workspace" : "user";
	const [view, setView] = useState<CommandsView | null>(null);
	const [builtins, setBuiltins] = useState<ListedCommand[]>([]);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
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
			const [next, all] = await Promise.all([api.list(cwd), listAll(cwd ? { cwd } : {})]);
			if (currentCwd.current !== cwd) return;
			setView(next);
			/*
			 * 内置的是产品和插件自己带的命令（`/clear`、`/compact`、`/btw`……），不是谁写的文件：命令文件、技能、MCP 的 prompt
			 * 都标了来源，没有来源的就是这些。
			 */
			setBuiltins(all.filter((command) => !command.source));
		})().catch((error: unknown) => notify(text.readFailed(reasonOf(error)), "error"));
	}, [api, cwd, listAll, notify, text]);
	useEffect(refresh, [refresh]);
	// 新建、编辑都在外面的编辑器里做，回到窗口时重读一遍，列表上才是刚写下的说明。
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	// 列表只列这一层的；读的时候四个目录一起读，同名谁盖了谁才说得清。
	const commands = (view?.commands ?? []).filter((command) => command.scope === scope);
	const needle = query.trim().toLowerCase();
	const matches = (command: { name: string; description: string; argumentHint?: string }) =>
		!needle || [command.name, command.description, command.argumentHint].some((value) => value?.toLowerCase().includes(needle));
	const visible = commands.filter(matches);
	const visibleBuiltins = builtins.filter(matches);
	// 文件读到了、只是有问题的算「需要留意」；没读成命令的算「没能加载」。都按文件数。
	const loaded = new Set((view?.commands ?? []).map((command) => command.path));
	const failed = (view?.diagnostics ?? []).filter((item) => !loaded.has(item.path));
	const warned = (view?.diagnostics ?? []).filter((item) => loaded.has(item.path));

	const remove = (command: CommandRow) =>
		confirmer.ask({
			title: text.deleteConfirm(command.name),
			detail: text.deleteDetail,
			confirmLabel: text.delete,
			cancelLabel: text.cancel,
			onConfirm: () => {
				setPending((current) => new Set(current).add(command.path));
				void (async () => api.remove(command.path, cwd))()
					.catch((error: unknown) => notify(text.deleteFailed(reasonOf(error)), "error"))
					.finally(() => {
						setPending((current) => {
							const next = new Set(current);
							next.delete(command.path);
							return next;
						});
						refresh();
					});
			},
		});

	return (
		<div data-commands-settings="">
			<Text as="p" size="detail" tone="muted" className="cmd-intro">
				{text.intro}
			</Text>
			<ProjectScope value={project} choices={choices} onChange={choose} text={text} />
			<Problems title={text.failedToLoad(new Set(failed.map((item) => item.path)).size)} items={failed} text={text} />
			<Problems title={text.warnings(new Set(warned.map((item) => item.path)).size)} items={warned} text={text} />

			<div className="cmd-head">
				<div className="cmd-head-title">
					<Text size="label" weight="medium">
						{text.installed}
					</Text>
					<Text size="detail" tone="faint" numeric>
						{commands.length}
					</Text>
				</div>
				<div className="cmd-head-actions">
					<Button
						variant="subtle"
						size="sm"
						icon={<FolderOpen size={13} aria-hidden />}
						label={scope === "workspace" ? text.openProjectDir : text.openPersonalDir}
						onClick={() => void (async () => api.reveal(scope, cwd))().catch((error: unknown) => notify(reasonOf(error), "error"))}
					/>
					<Button variant="subtle" size="sm" icon={<RefreshCw size={13} aria-hidden />} label={text.refresh} onClick={refresh} />
					<Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => setCreating(true)}>
						{text.newCommand}
					</Button>
				</div>
			</div>

			{(commands.length > 0 || builtins.length > 0) && (
				<Text size="label">
					<input
						className="cmd-search"
						type="search"
						value={query}
						placeholder={text.searchPlaceholder}
						aria-label={text.searchPlaceholder}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</Text>
			)}

			{view && commands.length === 0 ? (
				<SettingsCard>
					<div className="cmd-empty">
						<Text size="label" weight="medium">
							{text.emptyTitle}
						</Text>
						<Text as="p" size="detail" tone="faint">
							{text.whatIsIt}
						</Text>
						<Button variant="primary" icon={<Plus size={13} aria-hidden />} onClick={() => setCreating(true)}>
							{text.newCommand}
						</Button>
					</div>
				</SettingsCard>
			) : view && visible.length === 0 ? (
				<SettingsCard>
					<div className="cmd-empty">
						<Text size="label" tone="faint">
							{text.searchEmpty}
						</Text>
					</div>
				</SettingsCard>
			) : (
				visible.length > 0 && (
					<SettingsCard>
						{visible.map((command) => (
							<div
								key={command.path}
								className="cmd-row"
								role="button"
								tabIndex={0}
								aria-label={text.editNamed(command.name)}
								data-command-row={command.name}
								onClick={() => void (async () => api.open(command.path, cwd))().catch((error: unknown) => notify(reasonOf(error), "error"))}
								onKeyDown={(event) => {
									if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
									event.preventDefault();
									void (async () => api.open(command.path, cwd))().catch((error: unknown) => notify(reasonOf(error), "error"));
								}}
							>
								<span className="cmd-row-mark" aria-hidden>
									<SquareTerminal size={16} strokeWidth={1.8} />
								</span>
								<span className="cmd-row-body">
									<span>
										<Text size="label" mono tone="faint">
											/
										</Text>
										<Text size="label" mono>
											{command.name}
										</Text>
										{command.argumentHint && (
											<Text size="detail" mono tone="faint">
												{` ${command.argumentHint}`}
											</Text>
										)}
									</span>
									<Text size="detail" tone="muted">
										{command.description || command.path}
									</Text>
								</span>
								<span className="cmd-row-side" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
									<Text size="detail" tone="faint">
										{originText(command, text)}
									</Text>
									<IconButton
										size="sm"
										label={text.deleteNamed(command.name)}
										disabled={pending.has(command.path)}
										icon={<Trash2 size={14} />}
										onClick={() => remove(command)}
									/>
								</span>
							</div>
						))}
					</SettingsCard>
				)
			)}
			{/*
			 * 内置的单列一段、不能编辑：这一页回答的是「敲 / 能用什么」，漏掉最常用的那几条就答错了。不混进「已安装」：
			 * 它们没有文件可打开，也不分个人和项目。
			 */}
			{visibleBuiltins.length > 0 && (
				<>
					<div className="cmd-head">
						<div className="cmd-head-title">
							<Text size="label" weight="medium">
								{text.builtin}
							</Text>
							<Text size="detail" tone="faint" numeric>
								{visibleBuiltins.length}
							</Text>
						</div>
					</div>
					<SettingsCard>
						{visibleBuiltins.map((command) => (
							<div key={command.name} className="cmd-row cmd-row-static" data-builtin-command={command.name}>
								<span className="cmd-row-mark" aria-hidden>
									<SquareTerminal size={16} strokeWidth={1.8} />
								</span>
								<span className="cmd-row-body">
									<span>
										<Text size="label" mono tone="faint">
											/
										</Text>
										<Text size="label" mono>
											{command.name}
										</Text>
										{command.argumentHint && (
											<Text size="detail" mono tone="faint">
												{` ${command.argumentHint}`}
											</Text>
										)}
									</span>
									<Text size="detail" tone="muted">
										{command.description}
									</Text>
								</span>
							</div>
						))}
					</SettingsCard>
				</>
			)}
			{confirmer.element}
			{creating && view && (
				<CreateDialog
					dirs={{ user: view.dir, ...(view.projectDir ? { workspace: view.projectDir } : {}) }}
					project={project}
					defaultScope={scope}
					taken={takenNames(view.commands)}
					text={text}
					onClose={() => setCreating(false)}
					onCreate={async (name, target) => {
						await api.create(name, target, cwd);
						setCreating(false);
						// 建在个人目录里时顶上还停在项目，列表按范围筛，新的那条就不在眼前。
						if (target === "user") choose(null);
						else refresh();
					}}
				/>
			)}
		</div>
	);
}

/** 每一层里 Plume 自己目录下已有的名字。`.claude` 下的同名命令不挡：新文件不写进那里。 */
function takenNames(commands: readonly CommandRow[]): Record<CommandScope, ReadonlySet<string>> {
	const taken = { workspace: new Set<string>(), user: new Set<string>() };
	for (const command of commands) if (command.origin === "plume") taken[command.scope].add(command.name);
	return taken;
}

/** 这一页看哪一层：个人的，或某一个项目的。和钩子页、技能页的是同一个样子。 */
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
				className="cmd-scope"
			>
				{value ? <Folder size={14} strokeWidth={1.8} /> : <Monitor size={14} strokeWidth={1.8} />}
				<Text size="label" className="cmd-scope-name">
					{value?.name ?? text.personal}
				</Text>
				<ChevronDown size={13} strokeWidth={1.9} className="cmd-scope-caret" data-open={menu.open || undefined} />
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

function Problems({ title, items, text }: { title: string; items: CommandDiagnostic[]; text: Messages }) {
	if (items.length === 0) return null;
	return (
		<div className="cmd-problems" role="status">
			<Text size="label" weight="medium" tone="danger">
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

/** 新建一条命令：起个名字、选存在哪。页面顶上没选项目时只能存进个人目录：不知道该写进哪个仓库。 */
function CreateDialog({
	dirs,
	project,
	defaultScope,
	taken,
	text,
	onClose,
	onCreate,
}: {
	dirs: { user: string; workspace?: string };
	project: { name: string } | null;
	defaultScope: CommandScope;
	/** 每一层里已有的名字，重名在打字时就说，不必等按下创建。 */
	taken: Record<CommandScope, ReadonlySet<string>>;
	text: Messages;
	onClose: () => void;
	onCreate: (name: string, scope: CommandScope) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [scope, setScope] = useState<CommandScope>(dirs.workspace ? defaultScope : "user");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const trimmed = name.trim();
	const problem = !trimmed ? null : !NAME.test(trimmed) ? text.nameInvalid : taken[scope].has(trimmed) ? text.nameTaken(trimmed) : null;
	const ready = Boolean(trimmed) && !problem && !busy;
	const dir = (scope === "workspace" ? dirs.workspace : undefined) ?? dirs.user;
	const submit = () => {
		if (!ready) return;
		setBusy(true);
		setError(null);
		void onCreate(trimmed, scope)
			.catch((cause: unknown) => setError(reasonOf(cause)))
			.finally(() => setBusy(false));
	};
	return (
		<Dialog
			onClose={onClose}
			width={480}
			title={text.newCommand}
			icon={<SquareTerminal size={16} />}
			actions={(dismiss) => (
				<>
					<Button onClick={() => dismiss()}>{text.cancel}</Button>
					<Button variant="primary" disabled={!ready} loading={busy} onClick={submit}>
						{text.createAndEdit}
					</Button>
				</>
			)}
		>
			<div className="cmd-form">
				<Text size="label" weight="medium" id="plume-commands-name-label">
					{text.nameLabel}
				</Text>
				<Text size="label">
					<span className="cmd-field">
						<Text size="label" mono tone="faint">
							/
						</Text>
						<input
							aria-labelledby="plume-commands-name-label"
							autoFocus
							value={name}
							spellCheck={false}
							onChange={(event) => setName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.nativeEvent.isComposing) {
									event.preventDefault();
									submit();
								}
							}}
						/>
					</span>
				</Text>
				<Text as="p" size="detail" tone={problem || error ? "danger" : "faint"}>
					{problem ?? error ?? text.nameHint}
				</Text>
				{project && dirs.workspace ? (
					<div className="cmd-where">
						<Segmented
							value={scope}
							onChange={(next) => {
								setScope(next);
								setError(null);
							}}
							options={[
								{ value: "workspace", label: text.scopeProjectNamed(project.name) },
								{ value: "user", label: text.personal },
							]}
						/>
						<Text as="p" size="detail" tone="faint">
							{scope === "workspace" ? text.scopeProjectDetail : text.scopePersonalDetail}
						</Text>
					</div>
				) : null}
				<Text as="p" size="detail" tone="faint">
					{text.whereLabel}
					<Text size="detail" mono>{`${dir}/${trimmed || "…"}.md`}</Text>
				</Text>
			</div>
		</Dialog>
	);
}

export default {
	name: "plume.commands",
	apply(ui) {
		mountStyles();
		const api = ui.remote<CommandsApi>();
		const notify = ui.notify.bind(ui);
		const listAll: ListAll = (context) => ui.listCommands(context);
		ui.settingsSection("commands", () => <CommandsSettings api={api} listAll={listAll} notify={notify} projects={ui.useProjects()} />, {
			title: (locale) => MESSAGES[locale].settingsTitle,
			icon: SquareTerminal,
			// 「Agent 能力」组里依次是命令、钩子、网页搜索。
			order: 1,
			group: "agent",
			page: "nav",
		});
	},
} satisfies UiPlugin;
