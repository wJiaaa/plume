import type { ProjectInfo, Remote, UiContext } from "@plume/contract/ui";
import {
	Button,
	IconButton,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	Popover,
	SettingsCard,
	SettingsNotice,
	Text,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import { AlertCircle, Check, ChevronDown, Download, Folder, Monitor, Pencil, Plus, RotateCcw, Trash2 } from "@plume/ui/icons";
import { useCallback, useEffect, useState } from "react";
import type { ScriptsApi } from "./api.ts";
import { MESSAGES, type Messages } from "./messages.ts";
import { ScriptEditorDialog } from "./ScriptEditorDialog.tsx";
import { ScriptIcon } from "./ScriptIcon.tsx";
import { DEFAULT_SETTINGS, effectiveScripts, filterImportableScripts, hasProjectOverride } from "./store.ts";
import type { ProjectScript, RepoScriptsResult, ScriptInput, ScriptsSettings } from "./types.ts";

/** 记住上次在设置页选中的项目 id（null 为全局默认），离开设置页再回来时保留。 */
let lastScopeProjectId: string | null = null;

function ScopePicker({
	value,
	projects,
	onChange,
	text,
}: {
	value: ProjectInfo | null;
	projects: readonly ProjectInfo[];
	onChange: (projectId: string | null) => void;
	text: Messages;
}) {
	const menu = usePopover();
	const renderOption = (project: ProjectInfo | null) => {
		const selected = (project?.id ?? null) === (value?.id ?? null);
		return (
			<MenuItem
				key={project?.id ?? "__global__"}
				selected={selected}
				icon={project ? <Folder size={14} strokeWidth={1.8} /> : <Monitor size={14} strokeWidth={1.8} />}
				trailing={selected ? <Check size={13} strokeWidth={2.2} /> : undefined}
				onClick={() => {
					onChange(project?.id ?? null);
					menu.close();
				}}
			>
				{project?.name ?? text.globalDefaults}
			</MenuItem>
		);
	};
	return (
		<>
			<button
				type="button"
				className="plume-scripts-scope"
				aria-label={text.scopeLabel}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				data-scripts-scope=""
				onClick={menu.toggle}
			>
				{value ? <Folder size={14} strokeWidth={1.8} /> : <Monitor size={14} strokeWidth={1.8} />}
				<Text size="label" className="plume-scripts-scope-name">
					{value?.name ?? text.globalDefaults}
				</Text>
				<ChevronDown size={13} strokeWidth={1.9} className="plume-scripts-scope-caret" data-open={menu.open || undefined} />
			</button>
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="start" width="default" maxHeight={MENU_MAX_HEIGHT}>
					<MenuBody insetIcons>
						{renderOption(null)}
						{projects.length > 0 && (
							<>
								<MenuSeparator />
								<MenuLabel>{text.projectsGroup}</MenuLabel>
								{projects.map(renderOption)}
							</>
						)}
					</MenuBody>
				</Popover>
			)}
		</>
	);
}

export function ScriptsSettings({ api, ui }: { api: Remote<ScriptsApi>; ui: UiContext }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const projects = ui.useProjects();
	const [savedSettings] = ui.useSettings<ScriptsSettings>();
	const settings = savedSettings ?? DEFAULT_SETTINGS;

	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(lastScopeProjectId);
	const project = selectedProjectId ? (projects.find((entry) => entry.id === selectedProjectId) ?? null) : null;
	const scopeProjectId = project?.id ?? null;

	const [repoResult, setRepoResult] = useState<RepoScriptsResult>({ status: "missing" });
	const [editor, setEditor] = useState<{ open: true; script: ProjectScript | null } | null>(null);
	const confirmer = useConfirmer();

	const chooseScope = (projectId: string | null) => {
		lastScopeProjectId = projectId;
		setSelectedProjectId(projectId);
	};

	const refreshRepo = useCallback(() => {
		if (!project?.path) {
			setRepoResult({ status: "missing" });
			return;
		}
		let cancelled = false;
		void api
			.readRepoScripts(project.path)
			.then((result) => {
				if (!cancelled) setRepoResult(result);
			})
			.catch((error: unknown) => {
				if (!cancelled) setRepoResult({ status: "invalid", error: error instanceof Error ? error.message : String(error) });
			});
		return () => {
			cancelled = true;
		};
	}, [api, project?.path]);

	useEffect(() => refreshRepo(), [refreshRepo]);

	const scripts = effectiveScripts(settings, scopeProjectId ?? undefined);
	const overridden = scopeProjectId !== null && hasProjectOverride(settings, scopeProjectId);
	const importable = project && repoResult.status === "valid" ? filterImportableScripts(scripts, repoResult.scripts) : [];

	const handleReset = () => {
		if (!project) return;
		confirmer.ask({
			title: text.resetConfirmTitle(project.name),
			detail: text.resetConfirmDetail,
			confirmLabel: text.resetConfirmAction,
			cancelLabel: text.cancel,
			onConfirm: () => {
				void api.resetProject(project.id).catch((error: unknown) => {
					ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
			},
		});
	};

	const handleDelete = (script: ProjectScript) => {
		confirmer.ask({
			title: text.deleteConfirmTitle(script.name),
			detail: text.deleteConfirmDetail,
			confirmLabel: text.deleteConfirmAction,
			cancelLabel: text.cancel,
			onConfirm: () => {
				void api.deleteScript(scopeProjectId, script.id).catch((error: unknown) => {
					ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
			},
		});
	};

	const handleImport = (candidate: ScriptInput) => {
		if (!project) return;
		void api
			.importRepoScript(project.id, candidate)
			.then(() => {
				ui.notify(text.importedNotice(candidate.name), "info");
			})
			.catch((error: unknown) => {
				ui.notify(error instanceof Error ? error.message : String(error), "error");
			});
	};

	return (
		<div data-scripts-settings="">
			<div className="plume-scripts-scope-bar">
				<ScopePicker value={project} projects={projects} onChange={chooseScope} text={text} />
				{overridden && (
					<Button variant="subtle" size="sm" icon={<RotateCcw size={13} aria-hidden />} onClick={handleReset}>
						{text.resetToGlobal}
					</Button>
				)}
			</div>

			{project && (
				<Text as="p" size="detail" tone="faint" className="plume-scripts-scope-note">
					{overridden ? text.projectOverride : text.inheritingGlobal}
				</Text>
			)}

			{project && repoResult.status === "invalid" && (
				<SettingsNotice tone="danger" icon={AlertCircle} className="plume-scripts-notice" role="alert">
					<div>
						<Text as="p" size="label" weight="medium" tone="danger">
							{text.repoInvalidTitle}
						</Text>
						<Text as="p" size="detail" tone="muted" mono>
							{repoResult.error}
						</Text>
					</div>
				</SettingsNotice>
			)}

			<div className="plume-scripts-head">
				<div className="plume-scripts-head-title">
					<Text as="h2" size="body" weight="semibold">
						{text.projectScripts}
					</Text>
					<Text size="detail" tone="faint" numeric>
						{scripts.length}
					</Text>
				</div>
				<div className="plume-scripts-head-actions">
					<Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => setEditor({ open: true, script: null })}>
						{text.addScript}
					</Button>
				</div>
			</div>

			{scripts.length === 0 ? (
				<SettingsCard>
					<div className="plume-scripts-empty">
						<Text size="label" weight="medium">
							{project ? text.emptyProjectTitle : text.emptyGlobalTitle}
						</Text>
						<Text as="p" size="detail" tone="faint">
							{project ? text.emptyProjectDetail : text.emptyGlobalDetail}
						</Text>
						<Button variant="primary" icon={<Plus size={13} aria-hidden />} onClick={() => setEditor({ open: true, script: null })}>
							{text.addScript}
						</Button>
					</div>
				</SettingsCard>
			) : (
				<SettingsCard>
					{scripts.map((script) => (
						<div key={script.id} data-settings-item="" className="plume-scripts-row" data-script-row={script.id}>
							<span className="plume-scripts-row-mark" aria-hidden>
								<ScriptIcon icon={script.icon} size={16} />
							</span>
							<div className="plume-scripts-row-body">
								<div className="plume-scripts-row-title">
									<Text size="label" weight="medium">
										{script.name}
									</Text>
									{script.runOnWorktreeCreate && (
										<span className="plume-scripts-badge">
											<Text size="caption" tone="muted">
												{text.badgeSetup}
											</Text>
										</span>
									)}
									{script.runOnWorktreeCreate && script.waitForSetup && (
										<span className="plume-scripts-badge">
											<Text size="caption" tone="muted">
												{text.badgeWait}
											</Text>
										</span>
									)}
									{script.stopOnArchive && (
										<span className="plume-scripts-badge">
											<Text size="caption" tone="muted">
												{text.badgeStopOnArchive}
											</Text>
										</span>
									)}
									{script.previewUrl && script.autoOpenPreview && (
										<span className="plume-scripts-badge">
											<Text size="caption" tone="muted">
												{text.badgePreview}
											</Text>
										</span>
									)}
								</div>
								<Text size="detail" tone="muted" mono className="plume-scripts-row-cmd">
									{script.command}
								</Text>
							</div>
							<div className="plume-scripts-row-actions">
								<IconButton
									size="sm"
									label={text.editNamed(script.name)}
									icon={<Pencil size={13} strokeWidth={1.8} />}
									onClick={() => setEditor({ open: true, script })}
								/>
								<IconButton
									size="sm"
									tone="danger"
									label={text.deleteNamed(script.name)}
									icon={<Trash2 size={13} strokeWidth={1.8} />}
									onClick={() => handleDelete(script)}
								/>
							</div>
						</div>
					))}
				</SettingsCard>
			)}

			{project && importable.length > 0 && (
				<>
					<div className="plume-scripts-head">
						<div className="plume-scripts-head-title">
							<Text as="h2" size="body" weight="semibold">
								{text.repoSectionTitle}
							</Text>
							<Text size="detail" tone="faint" numeric>
								{importable.length}
							</Text>
						</div>
					</div>
					<Text as="p" size="detail" tone="faint" className="plume-scripts-scope-note">
						{text.repoSectionDetail}
					</Text>
					<SettingsCard>
						{importable.map((candidate) => (
							<div key={`${candidate.name}:${candidate.command}`} data-settings-item="" className="plume-scripts-row">
								<span className="plume-scripts-row-mark" aria-hidden>
									<ScriptIcon icon={candidate.icon} size={16} />
								</span>
								<div className="plume-scripts-row-body">
									<Text size="label" weight="medium">
										{candidate.name}
									</Text>
									<Text size="detail" tone="muted" mono className="plume-scripts-row-cmd">
										{candidate.command}
									</Text>
								</div>
								<div className="plume-scripts-row-actions">
									<Button size="sm" variant="subtle" icon={<Download size={13} aria-hidden />} onClick={() => handleImport(candidate)}>
										{text.importAction}
									</Button>
								</div>
							</div>
						))}
					</SettingsCard>
				</>
			)}

			{editor?.open && (
				<ScriptEditorDialog
					script={editor.script}
					onSave={async (scriptId, input) => {
						await api.saveScript(scopeProjectId, scriptId, input);
					}}
					onDelete={async (scriptId) => {
						await api.deleteScript(scopeProjectId, scriptId);
					}}
					onClose={() => setEditor(null)}
				/>
			)}
			{confirmer.element}
		</div>
	);
}
