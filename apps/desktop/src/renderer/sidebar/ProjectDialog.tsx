/**
 * 新建、编辑项目的对话框，和项目行上的「…」菜单。
 *
 * 第一个源文件夹作为新会话的工作目录，其余源文件夹供读取。
 * 移除先把它的聊天归档、再忘掉这条登记，磁盘上的东西都不动，所以菜单上没有会删掉文件的项。
 */

import type { ProjectEntry } from "@plume/contract";
import {
	type Anchor,
	Button,
	Confirm,
	Dialog,
	DialogAction,
	type Dismiss,
	IconButton,
	Input,
	MenuBody,
	MenuItem,
	MenuSeparator,
	Popover,
	useI18n,
} from "@plume/ui";
import { Archive, Folder, FolderOpen, FolderPlus, Monitor, Pencil, SquarePen, X } from "@plume/ui/icons";
import { useState } from "react";
import { attachmentActions } from "../composer/attachments/actions.ts";
import { revealKey } from "../files/open-targets.ts";
import type { SidebarActions } from "./actions.ts";

/** 宽到放得下一行路径，又窄到还是一张表单而不是一页。 */
const PROJECT_DIALOG_WIDTH = 520;

function baseName(path: string): string {
	return path.split(/[\\/]/).findLast(Boolean) ?? path;
}

export function ProjectDialog({ project, actions, onClose }: { project?: ProjectEntry; actions: SidebarActions; onClose: () => void }) {
	const { t } = useI18n();
	const editing = project !== undefined;
	const [name, setName] = useState(project?.name ?? "");
	const [folders, setFolders] = useState(() => (project ? [...new Set([project.path, ...(project.folders ?? [])])] : []));
	const [confirmingRemove, setConfirmingRemove] = useState(false);

	const addFolder = async () => {
		const picked = await window.plume.pickFolder(t("project.addFolderOnThisComputer"));
		if (picked) setFolders((current) => (current.includes(picked) ? current : [...current, picked]));
	};

	// 存在退场动画之后，不在还留在屏幕上的对话框底下改列表。
	const submit = (dismiss: Dismiss) => {
		if (!folders.length) return;
		dismiss(() => {
			if (project) actions.updateProject(project.id, name, folders[0]!, folders);
			else actions.createProject(name, folders[0]!, folders);
			onClose();
		});
	};

	// 移除在同一个面上问，不在对话框上再叠一层确认：问的就是这个对话框正在显示的东西。
	if (confirmingRemove && project) {
		return (
			<Dialog
				onClose={onClose}
				width={PROJECT_DIALOG_WIDTH}
				label={t("projectMenu.removeConfirm", { name: project.name })}
				title={t("projectMenu.removeConfirm", { name: project.name })}
				detail={t("projectMenu.removeDetail")}
				actions={(dismiss) => (
					<>
						<div className="flex-1" />
						<DialogAction onClick={() => setConfirmingRemove(false)}>{t("common.cancel")}</DialogAction>
						<DialogAction
							tone="danger"
							onClick={() =>
								dismiss(() => {
									actions.removeProject(project.id);
									onClose();
								})
							}
						>
							{t("common.remove")}
						</DialogAction>
					</>
				)}
			/>
		);
	}

	return (
		<Dialog
			onClose={onClose}
			width={PROJECT_DIALOG_WIDTH}
			label={editing ? t("project.edit") : t("project.create")}
			title={editing ? t("project.edit") : t("project.create")}
			actions={(dismiss) => (
				<>
					{editing && (
						<DialogAction tone="danger" onClick={() => setConfirmingRemove(true)}>
							{t("project.removeLocal")}
						</DialogAction>
					)}
					<div className="flex-1" />
					<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
					<DialogAction tone="primary" disabled={!folders.length} onClick={() => submit(dismiss)}>
						{editing ? t("common.save") : t("project.create")}
					</DialogAction>
				</>
			)}
		>
			{/* 包成表单，在名称框里按回车就是创建：名称往往是按「创建」前最后碰的东西。 */}
			{(dismiss) => (
				<form
					data-plume-project-dialog={editing ? "edit" : "create"}
					onSubmit={(event) => {
						event.preventDefault();
						submit(dismiss);
					}}
				>
					<div className="plume-field mb-5 gap-2.5">
						<Folder size={15} strokeWidth={1.8} className="shrink-0 text-ink-muted" aria-hidden />
						<Input
							autoFocus
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder={t("project.namePlaceholder")}
							aria-label={t("project.namePlaceholder")}
							className="min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-ink-faint"
						/>
					</div>

					<div className="flex items-center justify-between pb-2">
						<span className="text-label text-ink">{t("project.sourceFolders")}</span>
						{folders.length > 0 && (
							<span className="flex items-center gap-1.5 text-detail text-ink-faint">
								<Monitor size={13} strokeWidth={1.8} aria-hidden />
								{t("project.thisComputer")}
							</span>
						)}
					</div>
					<div className="overflow-hidden rounded-2xl bg-card">
						{folders.length > 0 ? (
							<>
								{folders.map((folder, index) => (
									// 路径放在悬停提示里，行上只写文件夹名：一行绝对路径要读过一长串前缀才看到不同的那一段。
									<div
										key={folder}
										data-plume-source-folder={folder}
										data-row-actions=""
										className="flex h-11 items-center gap-2.5 px-4"
										data-plume-tip={folder}
									>
										<Folder size={15} strokeWidth={1.8} className="shrink-0 text-ink-muted" aria-hidden />
										<span className="plume-fade-tail min-w-0 flex-1 truncate text-label text-ink">{baseName(folder)}</span>
										{index === 0 ? (
											<span className="shrink-0 px-1.5 text-caption text-ink-faint" data-plume-main-folder="" data-plume-tip={t("project.mainFolderHint")}>
												{t("project.mainFolder")}
											</span>
										) : (
											<Button
												variant="subtle"
												size="xs"
												className="plume-row-action shrink-0"
												data-plume-make-main=""
												ariaLabel={t("project.makeMainNamed", { name: baseName(folder) })}
												onClick={() => setFolders((current) => [folder, ...current.filter((entry) => entry !== folder)])}
											>
												{t("project.makeMain")}
											</Button>
										)}
										<IconButton
											size="sm"
											label={t("project.removeFolderNamed", { name: baseName(folder) })}
											onClick={() => setFolders((current) => current.filter((entry) => entry !== folder))}
											icon={<X size={14} strokeWidth={2} aria-hidden />}
										/>
									</div>
								))}
								<button
									type="button"
									data-plume-add-folder
									onClick={() => void addFolder()}
									className="flex h-11 w-full items-center gap-2.5 px-4 text-left text-label text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
								>
									<FolderPlus size={15} strokeWidth={1.8} className="shrink-0" aria-hidden />
									{t("project.addFolder")}
								</button>
							</>
						) : (
							<div className="flex flex-col items-center gap-3 px-4 py-7">
								<p className="text-label text-ink-muted">{t("project.addFolderOnThisComputer")}</p>
								<DialogAction data-plume-add-folder onClick={() => void addFolder()}>
									<FolderPlus size={14} strokeWidth={1.8} aria-hidden />
									{t("project.add")}
								</DialogAction>
							</div>
						)}
					</div>
					{/* 可见的提交按钮在表单外的按钮行里，这一个只让回车能提交。 */}
					<button type="submit" className="hidden" tabIndex={-1} aria-hidden />
				</form>
			)}
		</Dialog>
	);
}

/** 项目行上的操作。新建会话排第一：行上的按钮也是它，这里是键盘和右键的路。 */
export function ProjectMenu({
	anchor,
	project,
	live,
	actions,
	onNewSession,
	onClose,
}: {
	anchor: Anchor;
	project: ProjectEntry;
	/** 项目里还列着的会话数：「归档聊天」上的数，没有时那一项按不了。 */
	live: number;
	actions: SidebarActions;
	onNewSession: () => void;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const [mode, setMode] = useState<"menu" | "edit" | "remove">("menu");

	if (mode === "remove") {
		return (
			<Confirm
				title={t("projectMenu.removeConfirm", { name: project.name })}
				detail={t("projectMenu.removeDetail")}
				confirmLabel={t("common.remove")}
				onCancel={onClose}
				onConfirm={() => {
					actions.removeProject(project.id);
					onClose();
				}}
			/>
		);
	}
	if (mode === "edit") return <ProjectDialog project={project} actions={actions} onClose={onClose} />;

	return (
		<Popover anchor={anchor} onClose={onClose} placement="right" width="compact" label={t("projectMenu.actionsFor", { name: project.name })}>
			<MenuBody>
				<MenuItem
					icon={<SquarePen size={13} strokeWidth={1.8} />}
					onClick={() => {
						onNewSession();
						onClose();
					}}
				>
					{t("projectMenu.newSessionHere")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem icon={<Pencil size={13} strokeWidth={1.8} />} onClick={() => setMode("edit")}>
					{t("projectMenu.editProject")}
				</MenuItem>
				<MenuItem
					icon={<FolderOpen size={13} strokeWidth={1.8} />}
					onClick={() => {
						onClose();
						attachmentActions.reveal({ path: project.path, name: project.name });
					}}
				>
					{t(revealKey())}
				</MenuItem>
				<MenuSeparator />
				<MenuItem
					icon={<Archive size={13} strokeWidth={1.8} />}
					hint={live > 0 ? String(live) : undefined}
					disabled={live === 0}
					onClick={() => {
						actions.archiveProject(project.id);
						onClose();
					}}
				>
					{t("projectMenu.archiveChats")}
				</MenuItem>
				<MenuItem icon={<X size={13} strokeWidth={1.9} />} danger onClick={() => setMode("remove")}>
					{t("common.remove")}
				</MenuItem>
			</MenuBody>
		</Popover>
	);
}
