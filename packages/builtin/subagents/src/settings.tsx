/**
 * 设置 › 智能体里子智能体那一节：顶上一行是范围（个人还是哪个项目）、条数和搜索，下面「已安装」「内置智能体」两组，
 * 每一行是一种子智能体——脸、名字、工具数、用途，右边是它用的模型、思考档位和开关。点一行打开编辑器。
 *
 * 页头和「会话」那一组是产品的；这里只画名单。名单、编辑、删除都经逻辑入口读写定义文件，见 `definitions.ts`。
 */

import type { SessionModel, ToolKind } from "@plume/contract";
import type { ProjectInfo, Remote, UiContext } from "@plume/contract/ui";
import {
	ActionSpinner,
	AgentAvatar,
	AVATAR_COLORS,
	AVATAR_SHAPES,
	assignAvatars,
	Button,
	COLOR_ART,
	Dialog,
	DialogAction,
	Disclosure,
	formatAvatar,
	freshAvatar,
	IconButton,
	InlineSelect,
	Input,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	parseAvatar,
	Popover,
	SearchField,
	Segmented,
	Select,
	SettingsCard,
	SettingsNotice,
	Text,
	TextArea,
	Toggle,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import { Brain, Check, ChevronDown, Copy, Folder, Monitor, Plus, RefreshCw, RotateCcw, Shuffle, Trash2, TriangleAlert } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentDefinition } from "./agents.ts";
import type { AgentCatalog, SubagentsApi } from "./api.ts";
import type { AgentDraft, AgentRecord, AgentSave } from "./definitions.ts";
import { fill, MESSAGES, type Messages } from "./messages.ts";
import type { ModelChoice } from "./types.ts";
import { refreshFaces } from "./ui-state.ts";

type Avatar = NonNullable<ReturnType<typeof parseAvatar>>;

let ui: UiContext;
let api: Remote<SubagentsApi>;

export function connectSettings(context: UiContext, remote: Remote<SubagentsApi>): void {
	ui = context;
	api = remote;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 一个文件夹一个选择：几个项目登记在同一个文件夹上时，这几页改的是那个文件夹里的东西，名字一起说出来。 */
function folders(projects: readonly ProjectInfo[]): { path: string; name: string }[] {
	const byPath = new Map<string, string[]>();
	for (const project of projects) byPath.set(project.path, [...(byPath.get(project.path) ?? []), project.name]);
	return [...byPath].map(([path, names]) => ({ path, name: names.join(" / ") }));
}

/** 这一页的名单：读一次，存、删、刷新时重读；换了范围就换一份。 */
function useCatalog(project: string | null) {
	const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const generation = useRef(0);
	const refresh = useCallback(async () => {
		const current = ++generation.current;
		setBusy(true);
		setError("");
		try {
			const result = await api.catalog(project);
			if (current === generation.current) setCatalog(result);
		} catch (cause) {
			if (current === generation.current) setError(reasonOf(cause));
		} finally {
			if (current === generation.current) setBusy(false);
		}
	}, [project]);
	useEffect(() => {
		setCatalog(null);
		void refresh();
		return () => {
			// oxlint-disable-next-line react-hooks/exhaustive-deps -- generation 是作废计数，清理时加一正是要它的最新值
			generation.current++;
		};
	}, [refresh]);
	return { catalog, setCatalog, error, busy, refresh };
}

/** 名单还没读到时用同一个空数组：每次渲染给一个新的 `[]`，下面按它记住的头像就每次都重算。 */
const NO_RECORDS: AgentRecord[] = [];

export function AgentsSection() {
	const text = MESSAGES[useI18n().resolvedLocale];
	const choices = folders(ui.useProjects());
	/** null 是个人的；项目被移除后回到个人的，而不是继续读一个已经不在列表里的目录。 */
	const [projectPath, setProjectPath] = useState<string | null>(null);
	const project = choices.find((entry) => entry.path === projectPath) ?? null;
	const { catalog, setCatalog, error: loadError, busy, refresh } = useCatalog(project?.path ?? null);
	const [editor, setEditor] = useState<{ record?: AgentRecord; copy?: boolean; project: string | null } | null>(null);
	const [notice, setNotice] = useState("");
	// 刚存下的那一个：行底色亮一下，脸也跟着高兴一下（`at` 让同一个人连存两次也各算一次）。
	const [highlight, setHighlight] = useState<{ name: string; at: number } | null>(null);
	const [query, setQuery] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const confirm = useConfirmer();
	const defaults = ui.useModelDefaults();

	const records = catalog?.records ?? NO_RECORDS;
	const avatars = useMemo(() => assignAvatars(records.map(({ definition }) => definition)), [records]);
	const avatarOf = (name: string) => avatars.get(name) ?? freshAvatar([]);

	const afterChange = async () => {
		refreshFaces();
		await refresh();
	};
	const openEditor = async (record: AgentRecord, copy = false) => {
		try {
			const fresh = await api.read(project?.path ?? null, record.id);
			setEditor({ record: fresh, copy, project: project?.path ?? null });
		} catch (cause) {
			setError(reasonOf(cause));
		}
	};
	const remove = async (record: AgentRecord) => {
		setSaving(true);
		try {
			await api.remove(project?.path ?? null, record.id, record.revision);
			setNotice("");
			await afterChange();
		} catch (cause) {
			setError(reasonOf(cause));
		} finally {
			setSaving(false);
		}
	};
	// 和命令一样问：文件去废纸篓，从那里拿回来。
	const askRemove = (record: AgentRecord, then?: () => void) =>
		confirm.ask({
			title: fill(text.removeConfirm, { name: record.definition.name }),
			detail: text.removeDetail,
			confirmLabel: text.moveToTrash,
			cancelLabel: text.cancel,
			onConfirm: () => {
				then?.();
				void remove(record);
			},
		});

	// 模型偏好一次存一个：连着改两行时第二次不会盖掉第一次。开关静默排队，不让一整页跟着变淡再弹回来。
	const saves = useRef(Promise.resolve());
	const queue = (action: () => Promise<void>, quiet = false) => {
		if (!quiet) setSaving(true);
		setError("");
		const next = saves.current.then(action);
		saves.current = next.catch(() => undefined);
		void next
			.catch((cause: unknown) => setError(reasonOf(cause)))
			.finally(() => {
				if (!quiet) setSaving(false);
			});
	};
	const setModel = (name: string, choice: ModelChoice) =>
		queue(async () => {
			await api.setModel(name, choice);
			setCatalog((current) => current && { ...current, choices: { ...current.choices, [name]: choice } });
		});
	const setOn = (name: string, on: boolean) =>
		queue(async () => {
			await api.setEnabled(name, on);
			setCatalog((current) => current && { ...current, disabled: on ? current.disabled.filter((entry) => entry !== name) : [...current.disabled, name] });
		}, true);

	const needle = query.trim().toLowerCase();
	const matches = (agent: AgentDefinition) =>
		!needle || [agent.name, agent.description, agent.source, ...(agent.tools === "*" ? [] : agent.tools)].some((value) => value.toLowerCase().includes(needle));
	/*
	 * 「已安装」只列选中那一层自己的。改过的内置存在个人那一层（编辑内置总是存到那里），看项目时它不属于这一层，
	 * 归回「内置」一组，不然就从页面上消失了。
	 */
	const own = project ? "project" : "user";
	const installed = records.filter((record) => record.scope === own && matches(record.definition));
	const builtin = records.filter(
		(record) => (record.scope === "builtin" || (project && record.scope === "user" && record.customized)) && matches(record.definition),
	);
	const count = installed.length + builtin.length;
	const create = () => setEditor({ project: project?.path ?? null });

	const row = (record: AgentRecord) => {
		const name = record.definition.name;
		return (
			<AgentRow
				key={name}
				record={record}
				avatar={avatarOf(name)}
				saved={highlight?.name === name ? highlight.at : null}
				disabled={saving}
				on={!catalog?.disabled.includes(name)}
				setOn={(on) => setOn(name, on)}
				controls={
					catalog && (
						<AgentModelControls
							definition={record.definition}
							choice={catalog.choices[name] ?? {}}
							models={catalog.models}
							defaults={defaults}
							disabled={saving}
							onChange={(choice) => setModel(name, choice)}
						/>
					)
				}
				edit={() => void openEditor(record)}
				copy={() => void openEditor(record, true)}
				remove={record.scope === "builtin" ? undefined : () => (record.customized ? void remove(record) : askRemove(record))}
			/>
		);
	};

	return (
		<div data-subagents-settings="" className="subagents-settings">
			<div className="subagents-toolbar">
				<ProjectScope value={project} choices={choices} onChange={setProjectPath} />
				<span className="subagents-toolbar-rule" aria-hidden />
				<span className="subagents-toolbar-title">
					<Text size="label" weight="medium">
						{text.agentsTitle}
					</Text>
					<Text size="detail" tone="faint" numeric>
						{count}
					</Text>
				</span>
				<span className="subagents-toolbar-search">
					<SearchField size="comfortable" value={query} onChange={setQuery} placeholder={text.search} />
				</span>
			</div>

			{loadError && (
				<Banner
					action={
						<Button variant="subtle" size="sm" onClick={() => void refresh()}>
							{text.retry}
						</Button>
					}
				>
					{loadError}
				</Banner>
			)}
			{error && <Banner>{error}</Banner>}
			{notice && (
				<Text as="p" size="label" tone="muted" role="status" className="subagents-notice">
					{notice}
				</Text>
			)}

			{needle && count === 0 ? (
				<section className="subagents-group">
					<SettingsCard>
						<Text as="p" size="label" tone="faint" className="subagents-empty-search">
							{text.empty}
						</Text>
					</SettingsCard>
				</section>
			) : (
				<>
					<section className="subagents-group" hidden={Boolean(needle) && installed.length === 0}>
						<GroupHeader title={text.groupInstalled} count={installed.length}>
							<span className="subagents-group-actions">
								<Button
									variant="subtle"
									size="sm"
									label={text.refresh}
									disabled={busy}
									onClick={() => void afterChange()}
									icon={busy ? <ActionSpinner size={13} /> : <RefreshCw size={13} aria-hidden />}
								/>
								<Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={create}>
									{text.create}
								</Button>
							</span>
						</GroupHeader>
						{installed.length > 0 ? (
							<AgentList>{installed.map(row)}</AgentList>
						) : (
							<SettingsCard>
								<div className="subagents-empty">
									<Text size="label" weight="medium">
										{text.empty}
									</Text>
									<Text as="p" size="detail" tone="faint" className="subagents-empty-detail">
										{text.emptyDetail}
									</Text>
									<Button variant="primary" icon={<Plus size={13} aria-hidden />} onClick={create}>
										{text.create}
									</Button>
								</div>
							</SettingsCard>
						)}
					</section>
					{builtin.length > 0 && (
						<section className="subagents-group subagents-group-next">
							<GroupHeader title={text.groupBuiltin} count={builtin.length} />
							<AgentList>{builtin.map(row)}</AgentList>
						</section>
					)}
				</>
			)}

			{editor &&
				catalog &&
				(() => {
					const record = editor.record;
					const deletable = record && !editor.copy && record.scope !== "builtin" && !record.customized;
					return (
						<AgentEditor
							record={record}
							copy={editor.copy}
							project={editor.project}
							projectName={project?.name}
							tools={catalog.tools}
							avatarOf={avatarOf}
							taken={records
								.filter(({ definition }) => !record || editor.copy || definition.name !== record.definition.name)
								.map(({ definition }) => ({ name: definition.name, avatar: avatarOf(definition.name) }))}
							onClose={() => setEditor(null)}
							onDelete={deletable ? () => askRemove(record, () => setEditor(null)) : undefined}
							onSaved={(name) => {
								setEditor(null);
								setHighlight({ name, at: Date.now() });
								setNotice(text.savedForNext);
								void afterChange();
							}}
						/>
					);
				})()}
			{confirm.element}
		</div>
	);
}

function Banner({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
	return (
		<SettingsNotice tone="danger" role="alert" className="subagents-banner">
			<span className="subagents-banner-text">{children}</span>
			{action}
		</SettingsNotice>
	);
}

function GroupHeader({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
	return (
		<div className="subagents-group-head">
			<Text as="h2" size="label" weight="medium" className="subagents-group-title">
				{title}
				{count !== undefined && (
					<Text size="detail" tone="faint" numeric>
						{count}
					</Text>
				)}
			</Text>
			{children}
		</div>
	);
}

/** 一组行：设置卡片，行与行之间一道细线。 */
function AgentList({ children }: { children: React.ReactNode }) {
	return <SettingsCard className="subagents-list">{children}</SettingsCard>;
}

/** 跟在名字后面、说它从哪来、能用几样工具的淡字。 */
function Meta({ children }: { children: React.ReactNode }) {
	return (
		<Text size="detail" tone="faint" className="subagents-meta-tag">
			{children}
		</Text>
	);
}

function AgentRow({
	record,
	avatar,
	saved,
	disabled,
	on,
	setOn,
	controls,
	edit,
	copy,
	remove,
}: {
	record: AgentRecord;
	avatar: Avatar;
	/** 刚存下时是存下的时刻，否则 null。 */
	saved: number | null;
	disabled: boolean;
	on: boolean;
	setOn: (on: boolean) => void;
	controls: React.ReactNode;
	edit: () => void;
	copy: () => void;
	remove?: () => void;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const agent = record.definition;
	const name = agent.name;
	return (
		<div
			data-agent-profile={name}
			data-agent-saved={saved !== null || undefined}
			data-plume-avatar-host=""
			className="subagents-agent"
			data-editable={!disabled || undefined}
		>
			{/*
			 * 整行是编辑入口；但行里还有下拉和按钮，按钮套按钮不成立，所以用一层垫在最底下的按钮铺满整行，
			 * 上面的控件各自先接住自己的点击。
			 */}
			<button type="button" aria-label={fill(text.editNamed, { name })} disabled={disabled} className="subagents-agent-open" onClick={edit} />
			{/* 设置页、面板、输入框上方那条里都是这张脸。 */}
			<span className="subagents-agent-face">
				<AgentAvatar avatar={avatar} size={34} seed={name} host="[data-plume-avatar-host]" cheer={saved} />
			</span>
			<div className="subagents-agent-body">
				<div className="subagents-agent-line">
					<Text size="label" weight="medium" className="subagents-truncate">
						{name}
					</Text>
					{agent.source === "workspace" && <Meta>{text.project}</Meta>}
					{record.customized && <Meta>{text.builtinCustomised}</Meta>}
					<Meta>{agent.tools === "*" ? text.allTools : text.toolCount(agent.tools.length)}</Meta>
				</div>
				<Text as="p" size="detail" tone="faint" className="subagents-agent-description">
					{agent.description || text.noDescription}
				</Text>
			</div>
			<div className="subagents-agent-controls">
				{controls}
				<Toggle checked={on} onChange={setOn} ariaLabel={fill(text.enableNamed, { name })} />
				<span className="subagents-agent-actions">
					{/* 悬停时才出现，和命令行的删除、插件行的 ⋯ 一样。 */}
					<span className="subagents-row-action">
						<IconButton label={fill(text.duplicateFor, { name })} disabled={disabled} onClick={copy} icon={<Copy size={14} aria-hidden />} />
					</span>
					{remove && (
						<span className="subagents-row-action">
							<IconButton
								label={fill(record.customized ? (record.scope === "project" ? text.removeOverrideFor : text.restoreFor) : text.deleteFor, { name })}
								disabled={disabled}
								onClick={remove}
								icon={record.customized ? <RotateCcw size={14} aria-hidden /> : <Trash2 size={14} aria-hidden />}
							/>
						</span>
					)}
				</span>
			</div>
		</div>
	);
}

/** 思考档位里和默认档位对得上的那一档；模型没有这一档时用它自己标的默认档。 */
function levelFor(levels: SessionModel["thinking"], id: string | undefined) {
	return levels.find((level) => level.id === id) ?? levels.find((level) => level.isDefault) ?? levels[0];
}

function AgentModelControls({
	definition,
	choice,
	models,
	defaults,
	disabled,
	onChange,
}: {
	definition: AgentDefinition;
	choice: ModelChoice;
	models: SessionModel[];
	defaults: ReturnType<UiContext["useModelDefaults"]>;
	disabled: boolean;
	onChange: (choice: ModelChoice) => void;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const name = definition.name;
	// 没选时落到哪：定义里写了、这台机器上又有那个模型就用它，否则跟着主会话。
	const defined = definition.model ? models.find((model) => model.id === definition.model) : undefined;
	const inherited = defined ?? models.find((model) => model.id === defaults.sessionModel);
	const selected = choice.model ? models.find((model) => model.id === choice.model) : undefined;
	const current = choice.model ? selected : inherited;
	const levels = current?.thinking ?? [];
	const invalid = Boolean(choice.model && !selected);
	const invalidThinking = Boolean(choice.thinking && levels.length > 0 && !levels.some((level) => level.id === choice.thinking));
	const fallback = levelFor(levels, defaults.thinking);
	return (
		<fieldset disabled={disabled} aria-label={fill(text.runConfig, { name })} className="subagents-run-config">
			<ui.ModelSelect
				ariaLabel={fill(text.modelFor, { name })}
				value={choice.model ?? ""}
				disabled={disabled}
				{...(inherited ? { inheritedModelId: inherited.id, inheritDetail: inherited.name } : {})}
				inheritedSource={defined ? text.byDefault : text.followMainShort}
				inheritLabel={defined ? text.followDefinition : text.followMain}
				onChange={(model) => onChange(model ? { model } : {})}
			/>
			{/* 模型不支持思考时这一格不画——一个点不开的「不支持思考」只是占位。 */}
			{levels.length > 0 && (
				<InlineSelect
					ariaLabel={fill(text.thinkingFor, { name })}
					value={choice.thinking ?? ""}
					options={[
						{ value: "", label: fill(text.defaultThinking, { level: fallback?.label ?? text.thinkingOff }), icon: <Brain size={14} /> },
						...(invalidThinking && choice.thinking ? [{ value: choice.thinking, label: text.levelUnavailable }] : []),
						...levels.map((level) => ({ value: level.id, label: level.label, detail: level.detail, icon: <Brain size={14} /> })),
					]}
					onChange={(thinking) => onChange({ ...choice, thinking: (thinking || undefined) as ModelChoice["thinking"] })}
				/>
			)}
			{(invalid || invalidThinking) && (
				<Text tone="danger" className="subagents-run-alert" aria-label={text.configUnavailable} data-plume-tip={text.configUnavailableDetail}>
					<TriangleAlert size={15} aria-hidden />
				</Text>
			)}
		</fieldset>
	);
}

/**
 * 这一页看哪一层：个人的，或某一个项目的。胶囊靠一圈细线立住而不是垫底色——它是「在哪儿看」，不是工具条里的又一项。
 */
function ProjectScope({
	value,
	choices,
	onChange,
}: {
	value: { path: string; name: string } | null;
	choices: { path: string; name: string }[];
	onChange: (path: string | null) => void;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
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
				{choice?.name ?? text.user}
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
				className="subagents-scope"
			>
				{value ? <Folder size={14} strokeWidth={1.8} /> : <Monitor size={14} strokeWidth={1.8} />}
				<Text size="label" className="subagents-truncate">
					{value?.name ?? text.user}
				</Text>
				<ChevronDown size={13} strokeWidth={1.9} className="subagents-scope-caret" data-open={menu.open || undefined} />
			</button>
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="start" width="default" maxHeight={MENU_MAX_HEIGHT}>
					<MenuBody insetIcons>
						{option(null)}
						{choices.length > 0 && (
							<>
								<MenuSeparator />
								<MenuLabel>{text.workspace}</MenuLabel>
								{choices.map(option)}
							</>
						)}
					</MenuBody>
				</Popover>
			)}
		</>
	);
}

// ---- 编辑器 ----

/** 离开设置页再回来，没存的字还在；关掉应用就没了，指令不往浏览器的存储里写。 */
const drafts = new Map<string, { draft: AgentDraft; scope: "user" | "project" }>();
/** 新建时默认勾上的：读、按名字找、按内容搜、列目录（按工具声明做的是哪种活挑，不点名工具）。 */
const STARTER_KINDS: readonly ToolKind[] = ["view", "find", "search", "list"];
/** 能改文件、跑命令的几种活：勾选格右边一个红点。 */
const RISKY_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["command", "create", "modify"]);

/*
 * 新建、复制、编辑都在弹窗里：删除在左下，取消、保存在右下。
 *
 * 脸放在名字旁边，而且新建时就已经挑好了一张没人用的——它是这个智能体在设置页、面板里被认出来的方式，
 * 不该是一个等人想起来才去填的空。不满意就点它换，或者掷一次骰子。
 */
function AgentEditor({
	record,
	copy,
	project,
	projectName,
	tools,
	avatarOf,
	taken,
	onClose,
	onDelete,
	onSaved,
}: {
	record?: AgentRecord;
	copy?: boolean;
	project: string | null;
	projectName?: string;
	tools: AgentCatalog["tools"];
	avatarOf: (name: string) => Avatar;
	/** 除了正在编辑的这一个之外，每个人和他在用的脸。 */
	taken: { name: string; avatar: Avatar }[];
	onClose: () => void;
	onDelete?: () => void;
	onSaved: (name: string) => void;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const definition = record?.definition;
	const starter = STARTER_KINDS.flatMap((kind) => tools.flatMap((tool) => (tool.kind === kind ? [tool.name] : [])));
	const risky = new Set(tools.flatMap((tool) => (tool.kind && RISKY_KINDS.has(tool.kind) ? [tool.name] : [])));
	const draftKey = JSON.stringify([project, record?.id ?? "new", Boolean(copy)]);
	const remembered = drafts.get(draftKey);
	// 新建和复制一张新脸（复制出来的是另一个人）；编辑沿用它现在那张。只在第一次渲染时定下来。
	const [initialAvatar] = useState(() => formatAvatar(record && !copy ? avatarOf(record.definition.name) : freshAvatar(taken.map((other) => other.avatar))));
	const editing = Boolean(record && !copy);
	const initialScope: "user" | "project" = record ? (record.scope === "project" && !copy ? "project" : "user") : project ? "project" : "user";
	const original: AgentDraft = {
		name: copy ? `${definition?.name ?? "agent"}-copy` : (definition?.name ?? ""),
		description: definition?.description ?? "",
		prompt: definition?.prompt ?? "",
		tools: definition ? (definition.tools === "*" ? "*" : [...definition.tools]) : starter,
		avatar: initialAvatar,
	};
	const [draft, setDraft] = useState(remembered?.draft ?? original);
	const [scope, setScope] = useState<"user" | "project">(remembered?.scope ?? initialScope);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [leaving, setLeaving] = useState(false);
	const [rolls, setRolls] = useState(0);
	const picker = usePopover();
	const dirty = JSON.stringify(draft) !== JSON.stringify(original) || scope !== initialScope;
	useEffect(() => {
		if (dirty) drafts.set(draftKey, { draft, scope });
		else drafts.delete(draftKey);
	}, [draftKey, draft, scope, dirty]);
	// Esc 和点遮罩照常关掉：没存的字留在 `drafts` 里，下次打开还在。只有「取消」先问一句，因为它读起来像「扔掉」。
	const discard = () => {
		drafts.delete(draftKey);
		onClose();
	};
	const form = useRef<HTMLFormElement>(null);
	const patch = (next: Partial<AgentDraft>) => setDraft((current) => ({ ...current, ...next }));
	const face = parseAvatar(draft.avatar) ?? parseAvatar(initialAvatar) ?? freshAvatar(taken.map((other) => other.avatar));
	// 谁在用哪张：选脸的格子据此把别人的那张标出来、不让选，提示里说是谁。
	const owners = useMemo(() => new Map(taken.map((other) => [formatAvatar(other.avatar), other.name])), [taken]);
	const save = async (dismiss: (after?: () => void) => void) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const input: AgentSave = { scope, draft, ...(record ? (copy ? { copyFrom: record.id } : { id: record.id, revision: record.revision }) : {}) };
			await api.save(project, input);
			drafts.delete(draftKey);
			dismiss(() => onSaved(draft.name));
		} catch (cause) {
			setError(reasonOf(cause));
		} finally {
			setBusy(false);
		}
	};
	const title = editing && record ? fill(text.editorEditNamed, { name: record.definition.name }) : text.add;
	const selected = draft.tools;
	const scopeName = (value: "user" | "project") => (value === "project" ? (projectName ?? text.currentProject) : text.allProjects);
	return (
		<Dialog
			onClose={onClose}
			width={640}
			label={title}
			title={title}
			detail={record?.scope === "builtin" && !copy ? text.saveAsCustom : text.editorIntro}
			bodyClassName="subagents-editor-body"
			status={
				error ? (
					<Text as="p" size="detail" tone="danger" role="alert" className="subagents-editor-error">
						{error}
					</Text>
				) : undefined
			}
			actions={(dismiss) => {
				// 「还有没存的改动」就问在按下取消的那一排：底栏原地换成这句话和两个去处。
				if (leaving)
					return (
						<>
							<Text size="detail" role="alert" className="subagents-editor-leaving">
								{text.unsaved}
							</Text>
							<DialogAction autoFocus onClick={() => setLeaving(false)}>
								{text.keepEditing}
							</DialogAction>
							<DialogAction tone="danger" onClick={() => dismiss(discard)} data-agent-discard="">
								{text.discard}
							</DialogAction>
						</>
					);
				return (
					<>
						{onDelete && (
							<DialogAction tone="danger" disabled={busy} onClick={onDelete}>
								{text.delete}
							</DialogAction>
						)}
						<span className="subagents-spacer" />
						<DialogAction disabled={busy} onClick={() => (dirty ? setLeaving(true) : dismiss())}>
							{text.cancel}
						</DialogAction>
						{/* 按钮在表单外面：走 `requestSubmit`，名字的格式和必填由表单自己拦。 */}
						<DialogAction tone="primary" disabled={busy} onClick={() => form.current?.requestSubmit()} data-agent-save="">
							{text.save}
						</DialogAction>
					</>
				);
			}}
		>
			{(dismiss) => (
				<form
					ref={form}
					data-agent-editor=""
					className="subagents-editor"
					onSubmit={(event) => {
						event.preventDefault();
						void save(dismiss);
					}}
				>
					<fieldset disabled={busy} className="subagents-editor-fields">
						<div className="subagents-editor-head">
							{/* 脸是一块能点的底：点它挑，角上那颗骰子直接换一张没人用的。两颗按钮叠在一块底上而不是套在一起。 */}
							<div className="subagents-editor-face" data-plume-avatar-host="">
								<button
									type="button"
									aria-label={text.pickAvatar}
									data-plume-tip={`${text.pickAvatar} · ${avatarName(face, text)}`}
									aria-haspopup="dialog"
									aria-expanded={picker.open}
									data-agent-avatar={formatAvatar(face)}
									onClick={picker.toggle}
									className="subagents-editor-face-button"
								/>
								<AgentAvatar
									avatar={face}
									size={38}
									seed={draft.name || "new"}
									host="[data-plume-avatar-host]"
									cheer={rolls || null}
									className="subagents-editor-face-art"
								/>
								<span className="subagents-editor-dice">
									<IconButton
										size="sm"
										label={text.shuffleAvatar}
										data-agent-shuffle=""
										onClick={() => {
											patch({ avatar: formatAvatar(freshAvatar([...taken.map((other) => other.avatar), face])) });
											setRolls((n) => n + 1);
										}}
										icon={<Shuffle size={11} strokeWidth={2.2} aria-hidden />}
									/>
								</span>
							</div>
							<div className="subagents-editor-name">
								<Field label={text.nameLabel} htmlFor="plume-agent-name">
									<Text size="label">
										<Input
											id="plume-agent-name"
											autoFocus={!editing}
											aria-label={text.callName}
											placeholder="code-reviewer"
											value={draft.name}
											readOnly={editing}
											required
											pattern={editing ? undefined : "[a-z][a-z0-9_\\-]{0,63}"}
											onChange={(event) => patch({ name: event.target.value })}
											spellCheck={false}
											autoComplete="off"
											className="plume-field subagents-input subagents-mono"
										/>
									</Text>
								</Field>
							</div>
							<div className="subagents-editor-scope">
								<Field label={text.scopeLabel}>
									{/* 已有的智能体换不了范围（只能复制），所以编辑时写成文字：一个点不动的下拉看上去就是坏了。 */}
									{editing ? (
										<Text as="div" size="label" tone="muted" className="plume-field subagents-scope-fixed" data-plume-tip={text.scopeFixed}>
											{scopeName(scope)}
										</Text>
									) : (
										<Select
											ariaLabel={text.scope}
											value={scope}
											options={[
												{ value: "user" as const, label: text.allProjects },
												...(project ? [{ value: "project" as const, label: scopeName("project") }] : []),
											]}
											onChange={setScope}
										/>
									)}
								</Field>
							</div>
						</div>
						<Field label={text.purposeLabel} htmlFor="plume-agent-purpose">
							<Text size="label">
								<Input
									id="plume-agent-purpose"
									aria-label={text.purpose}
									placeholder={text.purposePlaceholder}
									required
									maxLength={2000}
									value={draft.description}
									onChange={(event) => patch({ description: event.target.value })}
									className="plume-field subagents-input"
								/>
							</Text>
						</Field>
						<Field label={text.instructionsLabel} htmlFor="plume-agent-instructions">
							<TextArea
								id="plume-agent-instructions"
								aria-label={text.instructions}
								placeholder={text.instructionsPlaceholder}
								required
								maxLength={200000}
								value={draft.prompt}
								rows={6}
								resizable
								onChange={(next) => patch({ prompt: next })}
							/>
						</Field>
						<Field label={text.allowedTools} hint={text.toolsNote}>
							<span className="subagents-fit">
								<Segmented
									value={selected === "*" ? "all" : "custom"}
									options={[
										{ value: "all", label: text.allToolsOption },
										{ value: "custom", label: text.customTools },
									]}
									onChange={(value) => patch({ tools: value === "all" ? "*" : selected === "*" ? starter : selected })}
								/>
							</span>
							{selected !== "*" && (
								<div className="subagents-tools">
									<div className="subagents-tools-grid">
										{[...new Set([...tools.map((tool) => tool.name), ...selected])].map((name) => (
											<ToolCheckbox
												key={name}
												name={name}
												risky={risky.has(name)}
												checked={selected.includes(name)}
												onChange={(checked) => patch({ tools: checked ? [...selected, name] : selected.filter((tool) => tool !== name) })}
											/>
										))}
									</div>
								</div>
							)}
						</Field>
						{definition && (
							<Disclosure variant="framed" title={<Text size="label">{text.advanced}</Text>}>
								<Text as="p" size="detail" tone="muted" className="subagents-advanced-note">
									{text.advancedNote}
								</Text>
								<Text as="div" size="caption" mono className="subagents-advanced-json">
									{JSON.stringify({ model: definition.model, output: definition.output, schemaMode: definition.schemaMode }, null, 2)}
								</Text>
							</Disclosure>
						)}
						<Text as="p" size="caption" tone="faint">
							{text.draftNote}
						</Text>
					</fieldset>
					{picker.open && (
						<Popover anchor={picker.anchor} onClose={picker.close} placement="bottom" align="start" width={316} label={text.pickAvatar}>
							<AvatarPicker
								value={face}
								owners={owners}
								text={text}
								onChange={(next) => {
									patch({ avatar: formatAvatar(next) });
									setRolls((n) => n + 1);
								}}
							/>
						</Popover>
					)}
				</form>
			)}
		</Dialog>
	);
}

/** 标题、控件、底下一行说明。 */
function Field({ label, htmlFor, hint, children }: { label: React.ReactNode; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="subagents-field">
			<label htmlFor={htmlFor} className="subagents-field-label">
				<Text size="detail" weight="medium">
					{label}
				</Text>
			</label>
			{children}
			{hint && (
				<Text as="p" size="caption" tone="faint" className="subagents-field-hint">
					{hint}
				</Text>
			)}
		</div>
	);
}

/** 工具勾选：整格是按钮，勾上是前景色实底。能改文件、跑命令的几样右边一个红点。 */
function ToolCheckbox({ name, risky, checked, onChange }: { name: string; risky: boolean; checked: boolean; onChange: (checked: boolean) => void }) {
	return (
		<button type="button" role="checkbox" aria-checked={checked} onClick={() => onChange(!checked)} className="subagents-tool">
			<span className="subagents-tool-box" data-checked={checked || undefined}>
				<Check size={14} strokeWidth={2.4} aria-hidden />
			</span>
			<Text size="label" weight="medium" className="subagents-truncate subagents-tool-name">
				{name}
			</Text>
			{risky && <span aria-hidden className="subagents-tool-risk" />}
		</button>
	);
}

// ---- 选脸 ----

/** 「云朵 · 紫」。形状在前、中间一个点：各语言形容词和名词的语序不同，拼成一句话总有一种语言读着别扭。 */
function avatarName(avatar: Avatar, text: Messages): string {
	return `${text.shapes[avatar.shape] ?? avatar.shape} · ${text.colors[avatar.color] ?? avatar.color}`;
}

/**
 * 十六种形状、十六种颜色。别人已经在用的那张不让选——每个智能体长得不一样是这套东西的全部意义。撞上的格子仍然看得见、
 * 仍然能悬停，提示里说是谁在用：藏起来的话，人会以为那种形状根本不存在。
 */
function AvatarPicker({
	value,
	owners,
	text,
	onChange,
}: {
	value: Avatar;
	owners: ReadonlyMap<string, string>;
	text: Messages;
	onChange: (next: Avatar) => void;
}) {
	const tip = (face: Avatar, name: string) => {
		const owner = owners.get(formatAvatar(face));
		return owner ? fill(text.avatarTaken, { name: owner }) : name;
	};
	return (
		<div className="subagents-picker" data-avatar-picker="">
			<Text as="p" size="detail" tone="faint" className="subagents-picker-label">
				{text.avatarShapes}
			</Text>
			<div role="radiogroup" aria-label={text.avatarShapes} className="subagents-picker-grid">
				{AVATAR_SHAPES.map((shape) => {
					const face = { shape, color: value.color };
					const selected = shape === value.shape;
					const taken = !selected && owners.has(formatAvatar(face));
					const label = text.shapes[shape] ?? shape;
					return (
						<button
							key={shape}
							type="button"
							role="radio"
							aria-checked={selected}
							aria-disabled={taken || undefined}
							aria-label={label}
							data-plume-tip={tip(face, label)}
							data-avatar-shape={shape}
							data-taken={taken || undefined}
							onClick={() => {
								if (!taken) onChange(face);
							}}
							className="subagents-picker-shape"
						>
							<AgentAvatar avatar={face} size={24} seed={shape} interactive={!taken} />
						</button>
					);
				})}
			</div>
			<Text as="p" size="detail" tone="faint" className="subagents-picker-label subagents-picker-label-next">
				{text.avatarColors}
			</Text>
			<div role="radiogroup" aria-label={text.avatarColors} className="subagents-picker-grid">
				{AVATAR_COLORS.map((color) => {
					const face = { shape: value.shape, color };
					const selected = color === value.color;
					const taken = !selected && owners.has(formatAvatar(face));
					const label = text.colors[color] ?? color;
					return (
						<button
							key={color}
							type="button"
							role="radio"
							aria-checked={selected}
							aria-disabled={taken || undefined}
							aria-label={label}
							data-plume-tip={tip(face, label)}
							data-avatar-color={color}
							data-taken={taken || undefined}
							onClick={() => {
								if (!taken) onChange(face);
							}}
							className="subagents-picker-color"
						>
							{/* 色块就是头像身体的颜料（`COLOR_ART`），不是界面的颜色：选的是这张脸的颜色，得和脸上的一模一样。 */}
							<span className="subagents-picker-swatch" style={{ background: COLOR_ART[color] }}>
								{selected && <Check size={12} strokeWidth={3} aria-hidden />}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
