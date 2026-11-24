import type { SessionView } from "@plume/contract";
import type { Remote, UiContext } from "@plume/contract/ui";
import {
	EnvironmentRow,
	EnvironmentSplitRow,
	IconButton,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	Popover,
	useI18n,
	usePopover,
} from "@plume/ui";
import { Download, Plus, Settings, Wrench } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScriptsApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { ScriptEditorDialog } from "./ScriptEditorDialog.tsx";
import { ScriptIcon } from "./ScriptIcon.tsx";
import { DEFAULT_SETTINGS, effectiveScripts, filterImportableScripts, primaryScript } from "./store.ts";
import type { ProjectScript, ScriptInput, ScriptsSettings } from "./types.ts";

const PREFERRED_STORAGE_KEY = "plume.scripts.preferred";

function readPreferredMap(): Record<string, string> {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(PREFERRED_STORAGE_KEY) ?? "{}");
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof value === "string" && value) out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}

function writePreferred(projectId: string, scriptId: string): void {
	try {
		const map = readPreferredMap();
		map[projectId] = scriptId;
		localStorage.setItem(PREFERRED_STORAGE_KEY, JSON.stringify(map));
	} catch {}
}

export function ScriptsToolbar({ session, api, ui }: { session: SessionView; api: Remote<ScriptsApi>; ui: UiContext }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const projectId = session.summary.project;
	const projects = ui.useProjects();
	const [savedSettings] = ui.useSettings<ScriptsSettings>();
	const settings = savedSettings ?? DEFAULT_SETTINGS;
	const project = useMemo(() => (projectId ? projects.find((entry) => entry.id === projectId) : undefined), [projects, projectId]);

	const [preferredId, setPreferredId] = useState<string | null>(() => (projectId ? (readPreferredMap()[projectId] ?? null) : null));
	const [repoScripts, setRepoScripts] = useState<ScriptInput[]>([]);
	const [editor, setEditor] = useState<{ open: true; script: ProjectScript | null } | null>(null);
	const menu = usePopover();

	useEffect(() => {
		setPreferredId(projectId ? (readPreferredMap()[projectId] ?? null) : null);
	}, [projectId]);

	const loadRepo = useCallback(() => {
		if (!project?.path) {
			setRepoScripts([]);
			return;
		}
		let cancelled = false;
		void api
			.readRepoScripts(project.path)
			.then((result) => {
				if (cancelled) return;
				setRepoScripts(result.status === "valid" ? result.scripts : []);
			})
			.catch(() => {
				if (!cancelled) setRepoScripts([]);
			});
		return () => {
			cancelled = true;
		};
	}, [api, project?.path]);

	useEffect(() => loadRepo(), [loadRepo]);

	// 仅在属于某个项目的会话标题栏显示。
	if (!projectId) return null;

	const scripts = effectiveScripts(settings, projectId);
	const primary = primaryScript(scripts, preferredId);
	const importable = filterImportableScripts(scripts, repoScripts);

	const run = async (script: ProjectScript) => {
		menu.close();
		setPreferredId(script.id);
		writePreferred(projectId, script.id);
		try {
			const outcome = await api.runScript(session.summary.id, script.id);
			if (outcome.previewUrl) {
				void ui.openLink(outcome.previewUrl, session.summary.id).catch((error: unknown) => {
					ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
			}
		} catch (error) {
			ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const importScript = async (candidate: ScriptInput) => {
		menu.close();
		try {
			await api.importRepoScript(projectId, candidate);
			ui.notify(text.importedNotice(candidate.name), "info");
		} catch (error) {
			ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const openMenu = (anchor: HTMLElement) => {
		if (!menu.open) loadRepo();
		if (menu.open) menu.close();
		else menu.openAt(anchor);
	};

	const menuItems = (
		<MenuBody insetIcons>
			{scripts.map((script) => (
				<MenuItem
					key={script.id}
					icon={<ScriptIcon icon={script.icon} size={14} />}
					trailing={
						<span className="plume-scripts-menu-edit" onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
							<IconButton
								size="xs"
								label={text.editNamed(script.name)}
								icon={<Settings size={12} strokeWidth={1.9} />}
								onClick={(event) => {
									event.stopPropagation();
									menu.close();
									setEditor({ open: true, script });
								}}
							/>
						</span>
					}
					onClick={() => void run(script)}
				>
					{script.name}
				</MenuItem>
			))}
			{importable.length > 0 && (
				<>
					{scripts.length > 0 && <MenuSeparator />}
					<MenuLabel>{text.fromRepoFile}</MenuLabel>
					{importable.map((candidate) => (
						<MenuItem
							key={`${candidate.name}:${candidate.command}`}
							icon={<ScriptIcon icon={candidate.icon} size={14} />}
							trailing={<Download size={13} strokeWidth={1.8} aria-label={text.importNamed(candidate.name)} />}
							onClick={() => void importScript(candidate)}
						>
							{candidate.name}
						</MenuItem>
					))}
				</>
			)}
			{(scripts.length > 0 || importable.length > 0) && <MenuSeparator />}
			<MenuItem
				icon={<Plus size={14} strokeWidth={1.9} />}
				onClick={() => {
					menu.close();
					setEditor({ open: true, script: null });
				}}
			>
				{text.addScript}
			</MenuItem>
		</MenuBody>
	);

	return (
		<>
			{primary ? (
				<EnvironmentSplitRow
					icon={<ScriptIcon icon={primary.icon} size={15} />}
					title={primary.name}
					tip={text.runNamed(primary.name)}
					ariaLabel={text.projectScripts}
					menuLabel={text.scriptActions}
					open={menu.open}
					onClick={() => void run(primary)}
					onMenuClick={openMenu}
					data-scripts-toolbar=""
				/>
			) : importable.length > 0 ? (
				<EnvironmentSplitRow
					icon={<Wrench size={15} strokeWidth={1.8} />}
					title={text.projectScripts}
					ariaLabel={text.projectScripts}
					menuLabel={text.scriptActions}
					open={menu.open}
					onMenuClick={openMenu}
					data-scripts-toolbar=""
				/>
			) : (
				<EnvironmentRow
					icon={<Plus size={15} strokeWidth={1.8} />}
					title={text.addProjectScript}
					onClick={() => setEditor({ open: true, script: null })}
					data-scripts-toolbar=""
				/>
			)}

			{menu.open && (
				<Popover
					anchor={menu.anchor}
					onClose={menu.close}
					placement="bottom"
					align="start"
					width={menu.anchor instanceof HTMLElement && menu.anchor.offsetWidth > 0 ? menu.anchor.offsetWidth : "default"}
					maxHeight={MENU_MAX_HEIGHT}
					label={text.scriptActions}
				>
					{menuItems}
				</Popover>
			)}

			{editor?.open && (
				<ScriptEditorDialog
					script={editor.script}
					onSave={async (scriptId, input) => {
						await api.saveScript(projectId, scriptId, input);
					}}
					onDelete={async (scriptId) => {
						await api.deleteScript(projectId, scriptId);
					}}
					onClose={() => setEditor(null)}
				/>
			)}
		</>
	);
}
