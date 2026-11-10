import type { ProjectEntry, SessionTarget } from "@plume/contract";
import { IconButton, MENU_MAX_HEIGHT, MenuBody, MenuFooter, MenuItem, MenuSearch, Popover, ScrollText, useI18n, usePopover, useRolled } from "@plume/ui";
import { Check, ChevronDown, Folder, MessageSquare, Plus, X } from "@plume/ui/icons";
import { type ReactNode, useState } from "react";
import { ProjectDialog } from "../sidebar/ProjectDialog.tsx";
import type { SidebarActions } from "../sidebar/actions.ts";

/** 选择项目只决定下一段对话，不改已发送会话的归属。`children` 接在项目签后面、同一行里：插件加的格子。 */
export function ProjectPicker({
	project,
	projects,
	actions,
	onChoose,
	disabled,
	children,
}: {
	project?: ProjectEntry;
	projects: ProjectEntry[];
	actions: SidebarActions;
	onChoose: (target: SessionTarget) => void;
	disabled?: boolean;
	children?: ReactNode;
}) {
	const { t } = useI18n();
	const menu = usePopover();
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const label = project?.name ?? "Chat";
	const rolls = useRolled(label);
	const listed = projects.filter(
		(entry) =>
			!query ||
			entry.name.toLowerCase().includes(query.toLowerCase()) ||
			[entry.path, ...(entry.folders ?? [])].some((folder) => folder.toLowerCase().includes(query.toLowerCase())),
	);
	const choose = (target: SessionTarget) => {
		onChoose(target);
		menu.close();
	};
	return (
		<div className="flex min-w-0 items-center gap-0.5 p-1.5">
			<div className="group/chip relative flex min-w-0">
				<button
					type="button"
					data-project-trigger
					data-plume-tip={label}
					disabled={disabled}
					aria-haspopup="menu"
					aria-expanded={menu.open}
					onClick={menu.toggle}
					className={`plume-composer-control plume-scroll flex min-w-0 items-center gap-1 rounded-lg pr-2 pl-3 text-label text-ink transition-[color,background-color,opacity] disabled:opacity-60 ${menu.open ? "bg-card-hover" : project ? "group-hover/chip:bg-card-hover" : "hover:bg-card-hover"}`}
				>
					<span className="shrink-0 text-ink-muted">
						{project ? <Folder size={16} strokeWidth={1.8} aria-hidden /> : <MessageSquare size={16} strokeWidth={1.8} aria-hidden />}
					</span>
					<ScrollText key={label} text={label} className={`min-w-0 ${rolls ? "plume-roll" : ""}`} />
					<ChevronDown
						size={14}
						className={`shrink-0 text-ink-muted ${project ? "group-hover/chip:opacity-0 group-focus-within/chip:opacity-0" : ""}`}
						aria-hidden
					/>
				</button>
				{project && (
					<span className="pointer-events-none absolute inset-y-0 right-1 flex items-center opacity-0 group-hover/chip:pointer-events-auto group-hover/chip:opacity-100 group-focus-within/chip:pointer-events-auto group-focus-within/chip:opacity-100">
						<IconButton size="sm" disabled={disabled} label={t("project.without")} icon={<X size={14} />} onClick={() => choose({})} />
					</span>
				)}
			</div>
			{children}
			{creating && <ProjectDialog actions={actions} onClose={() => setCreating(false)} />}
			{menu.open && (
				<Popover
					anchor={menu.anchor}
					onClose={menu.close}
					placement="top"
					align="start"
					width="wide"
					maxHeight={MENU_MAX_HEIGHT}
					label={t("project.switch")}
					header={<MenuSearch value={query} onChange={setQuery} placeholder={t("project.search")} />}
					footer={
						<MenuFooter>
							<MenuItem
								icon={<Plus size={13} />}
								onClick={() => {
									menu.close();
									setCreating(true);
								}}
							>
								{t("project.new")}
							</MenuItem>
							{project && (
								<MenuItem icon={<X size={13} />} onClick={() => choose({})}>
									{t("project.without")}
								</MenuItem>
							)}
						</MenuFooter>
					}
				>
					<MenuBody>
						{listed.map((entry) => (
							<MenuItem
								key={entry.id}
								icon={<Folder size={13} />}
								title={entry.path}
								selected={entry.id === project?.id}
								trailing={entry.id === project?.id ? <Check size={13} /> : undefined}
								onClick={() => choose({ project: entry.id })}
							>
								{entry.name}
							</MenuItem>
						))}
						{listed.length === 0 && <p className="px-2.5 py-5 text-center text-detail text-ink-faint">{t("project.none")}</p>}
					</MenuBody>
				</Popover>
			)}
		</div>
	);
}
