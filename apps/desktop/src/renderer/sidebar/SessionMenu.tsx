/** 会话行和标题栏共用的操作；重命名留在同一个浮层里，失败时保留输入。 */
import type { ProjectEntry, SessionSummary } from "@plume/contract";
import { type Anchor, Button, Input, MenuBody, MenuItem, MenuSeparator, Popover, useI18n } from "@plume/ui";
import {
	Archive,
	ArchiveRestore,
	Check,
	ChevronRight,
	Copy,
	CornerUpRight,
	ExternalLink,
	FileDown,
	Folder,
	FolderInput,
	Mail,
	MailOpen,
	Pencil,
	Pin,
	PinOff,
	Trash2,
	X,
} from "@plume/ui/icons";
import { useEffect, useId, useRef, useState } from "react";
import { attachmentActions } from "../composer/attachments/actions.ts";
import { revealKey } from "../files/open-targets.ts";
import { notify } from "../toast/index.ts";
import { SessionMenuItems } from "../plugins.tsx";

const ICON = { size: 13, strokeWidth: 1.8 } as const;

export interface SessionMenuActions {
	archive(sessionId: string, archived?: boolean): void;
	/** 重命名失败时保留表单，让人能改完重试。 */
	rename(sessionId: string, title: string): Promise<void>;
	pin(sessionId: string, pinned: boolean): Promise<void>;
	unread(sessionId: string, unread: boolean): Promise<void>;
	move(sessionId: string, projectId: string | undefined): Promise<void>;
	export(sessionId: string, format: "database" | "markdown"): Promise<void>;
	newWindow(sessionId: string): void;
}

export function SessionMenu({
	anchor,
	session,
	projects,
	actions,
	onClose,
	onRequestDelete,
	below = false,
}: {
	anchor: Anchor;
	/** 标题栏入口向下展开，侧栏右键仍在旁边展开。 */
	below?: boolean;
	session: SessionSummary;
	projects: readonly ProjectEntry[];
	actions: SessionMenuActions;
	onClose: () => void;
	/**
	 * 问要不要删这个会话。只给已归档的：确认框归打开菜单的那一方，菜单一点就卸了，留不住它。
	 */
	onRequestDelete?: () => void;
}) {
	const { t } = useI18n();
	const side = below ? ({ placement: "bottom", align: "start" } as const) : ({ placement: "right" } as const);
	const titleId = useId();
	const [mode, setMode] = useState<"menu" | "rename" | "projects">("menu");
	const [draft, setDraft] = useState(session.title);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const current = projects.find((project) => project.id === session.project);
	// 「打开方式」悬停展开：离开那一行后稍等一下再收，指针从行斜着移进子菜单时不会半路把它关掉。
	const [openIn, setOpenIn] = useState(false);
	const openInRow = useRef<HTMLDivElement>(null);
	const openInLeave = useRef(0);
	const showOpenIn = () => {
		window.clearTimeout(openInLeave.current);
		setOpenIn(true);
	};
	const hideOpenIn = () => {
		openInLeave.current = window.setTimeout(() => setOpenIn(false), 160);
	};
	useEffect(() => () => window.clearTimeout(openInLeave.current), []);
	const save = async () => {
		if (saving || !draft.trim()) return;
		setSaving(true);
		setError(undefined);
		try {
			await actions.rename(session.id, draft);
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};
	const perform = async (action: () => Promise<void>, done?: string) => {
		onClose();
		try {
			await action();
			if (done) notify(done);
		} catch (cause) {
			notify(cause instanceof Error ? cause.message : String(cause), "error");
		}
	};
	const copy = (value: string, done: string) => perform(() => window.plume.files.copyText(value), done);

	if (mode === "rename") {
		return (
			<Popover anchor={anchor} onClose={onClose} {...side} width="compact" role="dialog" label={t("sessionMenu.rename")}>
				<form
					className="p-2.5"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<label htmlFor={titleId} className="block pb-1.5 text-detail text-ink-faint">
						{t("sessionMenu.titleLabel")}
					</label>
					<Input
						id={titleId}
						name="session-title"
						autoFocus
						value={draft}
						disabled={saving}
						onChange={(event) => {
							setDraft(event.target.value);
							setError(undefined);
						}}
						onKeyDown={(event) => {
							if (event.key !== "Escape") return;
							event.stopPropagation();
							setMode("menu");
						}}
						className="plume-field w-full"
					/>
					{error && (
						<p role="alert" className="pt-2 text-detail text-danger">
							{error}
						</p>
					)}
					<div className="flex justify-end gap-1.5 pt-2.5">
						<Button
							type="submit"
							variant="primary"
							size="sm"
							label={t("common.save")}
							loading={saving}
							disabled={!draft.trim()}
							icon={<Check size={13} strokeWidth={2.2} aria-hidden />}
						/>
						<Button
							variant="subtle"
							size="sm"
							label={t("common.cancel")}
							disabled={saving}
							onClick={() => setMode("menu")}
							icon={<X size={13} strokeWidth={2} aria-hidden />}
						/>
					</div>
				</form>
			</Popover>
		);
	}

	if (mode === "projects") {
		return (
			<Popover anchor={anchor} onClose={onClose} {...side} width="compact" label={t("sessionMenu.moveToProject")}>
				<MenuBody>
					<MenuItem icon={<FolderInput {...ICON} />} onClick={() => setMode("menu")}>
						{t("common.back")}
					</MenuItem>
					<MenuSeparator />
					{projects.map((project) => (
						<MenuItem
							key={project.id}
							icon={<Folder {...ICON} />}
							hint={current?.id === project.id ? t("sessionMenu.currentProject") : undefined}
							disabled={session.running || current?.id === project.id}
							onClick={() => void perform(() => actions.move(session.id, project.id))}
						>
							{project.name}
						</MenuItem>
					))}
					{session.project && (
						<>
							<MenuSeparator />
							<MenuItem icon={<FolderInput {...ICON} />} disabled={session.running} onClick={() => void perform(() => actions.move(session.id, undefined))}>
								{t("sessionMenu.removeFrom", { name: current?.name || t("sessionMenu.project") })}
							</MenuItem>
						</>
					)}
				</MenuBody>
			</Popover>
		);
	}

	return (
		<Popover anchor={anchor} onClose={onClose} {...side} width="compact" label={t("sessionMenu.options")}>
			<MenuBody>
				{!session.archived && (
					<MenuItem
						icon={session.pinned ? <PinOff {...ICON} /> : <Pin {...ICON} />}
						onClick={() => void perform(() => actions.pin(session.id, !session.pinned), t(session.pinned ? "sessionMenu.unpinned" : "sessionMenu.pinned"))}
					>
						{t(session.pinned ? "sessionMenu.unpin" : "sessionMenu.pin")}
					</MenuItem>
				)}
				<MenuItem
					icon={<Pencil {...ICON} />}
					onClick={() => {
						setDraft(session.title);
						setError(undefined);
						setMode("rename");
					}}
				>
					{t("common.rename")}
				</MenuItem>
				<MenuItem
					icon={session.archived ? <ArchiveRestore {...ICON} /> : <Archive {...ICON} />}
					onClick={() => {
						onClose();
						actions.archive(session.id, !session.archived);
					}}
				>
					{t(session.archived ? "common.unarchive" : "common.archive")}
				</MenuItem>
				{!session.archived && (
					<MenuItem
						icon={session.unread ? <MailOpen {...ICON} /> : <Mail {...ICON} />}
						onClick={() =>
							void perform(() => actions.unread(session.id, !session.unread), t(session.unread ? "sessionMenu.markedRead" : "sessionMenu.markedUnread"))
						}
					>
						{t(session.unread ? "sessionMenu.markRead" : "sessionMenu.markUnread")}
					</MenuItem>
				)}
				{session.archived && onRequestDelete && (
					<MenuItem
						icon={<Trash2 {...ICON} className="text-danger" />}
						onClick={() => {
							onClose();
							onRequestDelete();
						}}
					>
						<span className="text-danger">{t("common.delete")}</span>
					</MenuItem>
				)}
				<MenuSeparator />
				<MenuItem icon={<Folder {...ICON} />} disabled={session.running} onClick={() => setMode("projects")}>
					{t("sessionMenu.project")}
				</MenuItem>
				<div ref={openInRow} data-open-in="" onMouseEnter={showOpenIn} onMouseLeave={hideOpenIn}>
					<MenuItem icon={<ExternalLink {...ICON} />} trailing={<ChevronRight {...ICON} className="text-ink-faint" />} onClick={showOpenIn}>
						{t("sessionMenu.openIn")}
					</MenuItem>
					{openIn && openInRow.current && (
						<Popover
							anchor={openInRow.current}
							onClose={() => setOpenIn(false)}
							placement="right"
							align="start"
							width="compact"
							label={t("sessionMenu.openIn")}
							onMouseEnter={showOpenIn}
							onMouseLeave={hideOpenIn}
						>
							<MenuBody>
								<MenuItem
									icon={<ExternalLink {...ICON} />}
									onClick={() => {
										onClose();
										actions.newWindow(session.id);
									}}
								>
									{t("sessionMenu.newWindow")}
								</MenuItem>
							</MenuBody>
						</Popover>
					)}
				</div>
				<MenuSeparator />
				{session.cwd && (
					<>
						<MenuItem
							icon={<CornerUpRight {...ICON} />}
							onClick={() => {
								onClose();
								attachmentActions.reveal({ path: session.cwd, name: session.cwd });
							}}
						>
							{t(revealKey())}
						</MenuItem>
						<MenuItem icon={<Copy {...ICON} />} onClick={() => void copy(session.cwd, t("sessionMenu.cwdCopied"))}>
							{t("sessionMenu.copyCwd")}
						</MenuItem>
					</>
				)}
				<MenuItem icon={<FileDown {...ICON} />} onClick={() => void perform(() => actions.export(session.id, "database"))}>
					{t("sessionMenu.exportRecords")}
				</MenuItem>
				<MenuItem icon={<FileDown {...ICON} />} onClick={() => void perform(() => actions.export(session.id, "markdown"))}>
					{t("sessionMenu.exportMarkdown")}
				</MenuItem>
				<MenuItem icon={<Copy {...ICON} />} onClick={() => void copy(session.id, t("sessionMenu.sessionIdCopied"))}>
					{t("sessionMenu.copySessionId")}
				</MenuItem>
				<SessionMenuItems session={session} onClose={onClose} />
			</MenuBody>
		</Popover>
	);
}
