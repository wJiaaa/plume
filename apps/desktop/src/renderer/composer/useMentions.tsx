import type { AgentService, ProjectEntry, SessionSummary, SessionTarget } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import { AgentAvatar, assignAvatars, ScrollText, useI18n } from "@plume/ui";
import { FileCode, FolderArchive, MessageSquare, Minimize2, Paperclip, Puzzle } from "@plume/ui/icons";
import type { EditorView } from "@codemirror/view";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { listMentions, usePluginUis } from "../plugins.tsx";
import { notify } from "../toast/index.ts";
import type { CommandHandlers } from "./command-marks.ts";
import { type ComboboxState, CompletionPopup } from "./CompletionPopup.tsx";
import { mentionMarks, setMentionAvatars } from "./mention-marks.tsx";
import { formatMention, parseMentionTrigger, rankMentions, type MentionCompletion, type MentionItem } from "./mentions.ts";

export function useMentions({
	editor,
	agent,
	cwd,
	sessionId,
	target,
	sessions,
	projects,
	onSession,
}: {
	editor: { current: EditorView | null };
	agent: Remote<AgentService>;
	cwd?: string;
	sessionId?: string;
	target: SessionTarget;
	sessions?: readonly SessionSummary[];
	projects?: readonly ProjectEntry[];
	onSession: (ref: { id: string; title: string }) => void;
}) {
	const { t, resolvedLocale } = useI18n();
	const id = useId();
	const version = usePluginUis();
	const [completion, setCompletion] = useState<MentionCompletion | null>(null);
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [active, setActive] = useState(0);
	const [keyboardSelection, setKeyboardSelection] = useState(true);
	const [provided, setProvided] = useState<MentionItem[]>([]);
	const [files, setFiles] = useState<MentionItem[]>([]);
	const [pastSessions, setPastSessions] = useState<SessionSummary[]>([]);
	const [knownProjects, setKnownProjects] = useState<ProjectEntry[]>([]);
	const opened = completion !== null;
	const project = target.project;
	useEffect(() => {
		if (!opened) return;
		let alive = true;
		setProvided([]);
		setFiles([]);
		if (!sessions)
			void agent
				.listSessions()
				.then((entries) => {
					if (alive) setPastSessions(entries);
				})
				.catch(() => {});
		if (!projects)
			void agent
				.listProjects()
				.then((entries) => {
					if (alive) setKnownProjects(entries);
				})
				.catch(() => {});
		const report = (error: unknown) => {
			if (alive) notify(t("commands.readFailed", { reason: String(error) }), "error");
		};
		void Promise.all([agent.listCommands({ cwd, sessionId }), listMentions({ cwd, sessionId })])
			.then(([commands, mentions]) => {
				if (!alive) return;
				setProvided([
					...mentions,
					...commands
						.filter((command) => command.name.startsWith("skill:"))
						.map((command): MentionItem => ({
							id: `${command.plugin}/${command.name}`,
							title: command.name.slice(6),
							description: command.description,
							origin: command.source,
							kind: "plugin",
							token: `/${command.name}`,
						})),
				]);
			})
			.catch(report);
		void agent
			.mentionFiles({ project }, sessionId)
			.then((entries) => {
				if (alive)
					setFiles(
						entries.map((entry) => ({
							id: `file:${entry.path}`,
							kind: "file",
							title: entry.name + (entry.isDirectory ? "/" : ""),
							token: formatMention(entry.path + (entry.isDirectory ? "/" : "")),
							description: t("mention.projectPaths"),
							origin: entry.origin ?? t("common.workspace"),
						})),
					);
			})
			.catch(report);
		return () => {
			alive = false;
		};
		// 列表由主输入框提供时读取它的实时快照；子输入框只在打开菜单时请求。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 不随会话活动重读目录与插件名单
	}, [agent, cwd, sessionId, project, opened, version, t]);
	const term = completion?.term ?? "";
	useEffect(() => {
		setActive(0);
		setKeyboardSelection(true);
	}, [term, cwd, sessionId]);
	const items: MentionItem[] = [
		{ id: "action:pick-file", title: t("mention.pickFile"), kind: "action" },
		{ id: "action:pick-directory", title: t("mention.pickFolder"), kind: "action" },
		{ id: "action:compact", title: "compact", description: t("mention.compact"), kind: "action", token: "@compact" },
		...provided,
		...(sessions ?? pastSessions)
			.filter((session) => !session.parentId && !session.owner && session.id !== sessionId)
			.map((session): MentionItem => ({
				id: `session:${session.id}`,
				title: session.title || t("mention.untitled"),
				kind: "session",
				sessionId: session.id,
				origin: t("mention.pastSessions"),
				description: [
					(projects ?? knownProjects).find((entry) => entry.id === session.project)?.name,
					new Date(session.updatedAt).toLocaleDateString(resolvedLocale),
				]
					.filter(Boolean)
					.join(" · "),
			})),
		...files,
	];
	const matches = opened && focused && !dismissed ? rankMentions(term, items) : [];
	const current = Math.min(active, Math.max(0, matches.length - 1));
	const avatars = useMemo(
		() => assignAvatars(provided.filter((item) => item.kind === "subagent").map((item) => ({ name: item.title, avatar: item.avatar }))),
		[provided],
	);
	useEffect(() => {
		editor.current?.dispatch({ effects: setMentionAvatars.of(avatars) });
	}, [editor, avatars]);
	useEffect(() => {
		const content = editor.current?.contentDOM;
		if (!content || !matches.length) return;
		content.setAttribute("aria-controls", id);
		content.setAttribute("aria-activedescendant", `${id}-${current}`);
		content.setAttribute("aria-autocomplete", "list");
		return () => {
			for (const name of ["aria-controls", "aria-activedescendant", "aria-autocomplete"]) content.removeAttribute(name);
		};
	}, [editor, id, current, matches.length]);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const pick = async (item: MentionItem) => {
		const view = editor.current;
		if (!view || !completion) return;
		const before = view.state.doc;
		setDismissed(true);
		try {
			const path =
				item.id === "action:pick-file" || item.id === "action:pick-directory"
					? await window.plume.files.pickReference(item.id === "action:pick-directory")
					: undefined;
			if (!alive.current || editor.current !== view || view.state.doc !== before) return;
			if (!item.token && !item.sessionId && !path) return;
			const token = path ? formatMention(path) : (item.token ?? "");
			const next = before.sliceString(completion.end, completion.end + 1);
			const insert = token + (token && !/\s/.test(next) ? " " : "");
			view.dispatch({
				changes: { from: completion.start, to: completion.end, insert },
				selection: { anchor: completion.start + insert.length },
				userEvent: "input.complete",
			});
			if (item.sessionId) onSession({ id: item.sessionId, title: item.title });
			view.focus();
		} catch (error) {
			notify(String(error), "error");
		}
	};
	const handlers = useRef<CommandHandlers>({ key: () => false, update: () => undefined });
	handlers.current = {
		update(view, edited) {
			const selection = view.state.selection.main;
			setCompletion(parseMentionTrigger(view.state.doc.toString(), selection.from, selection.to));
			setFocused(view.hasFocus);
			if (edited) setDismissed(false);
		},
		key(key) {
			if (!matches.length) return false;
			if (key === "Escape") setDismissed(true);
			else if (key === "ArrowUp" || key === "ArrowDown") {
				setKeyboardSelection(true);
				setActive((current + (key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
			} else void pick(matches[current]!);
			return true;
		},
	};
	const extension = useMemo(() => mentionMarks(handlers), []);
	const headings = {
		action: "mention.actions",
		file: "mention.filesAndFolders",
		subagent: "mention.agents",
		plugin: "mention.pluginsAndSkills",
		session: "mention.sessions",
	} as const;
	const menu = (
		<CompletionPopup
			id={id}
			items={matches}
			term={term}
			active={current}
			keyboardSelection={keyboardSelection}
			label={t("mention.menu")}
			keyOf={(item) => item.id}
			groupOf={(item) => item.kind}
			heading={(item) => t(headings[item.kind])}
			onPick={(item) => void pick(item)}
			onHover={(index) => {
				setActive(index);
				setKeyboardSelection(false);
			}}
			row={(item, index, selected) => {
				const Icon =
					item.id === "action:compact"
						? Minimize2
						: item.kind === "action"
							? Paperclip
							: item.kind === "plugin"
								? Puzzle
								: item.kind === "session"
									? MessageSquare
									: item.title.endsWith("/")
										? FolderArchive
										: FileCode;
				return {
					label: [item.title, item.description, item.origin].filter(Boolean).join(t("common.comma")),
					data: { "data-mention-kind": item.kind, "data-mention-title": item.title },
					content: (
						<>
							{item.kind === "subagent" ? (
								<AgentAvatar
									avatar={avatars.get(item.title)!}
									size={18}
									seed={item.title}
									host=".plume-command-option"
									cheer={keyboardSelection && selected ? index : null}
								/>
							) : (
								<Icon size={16} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
							)}
							<ScrollText text={item.title} className="min-w-0 max-w-[42%] shrink-0 text-ink" />
							{item.description && <ScrollText text={item.description} className="min-w-0 flex-1 text-ink-muted" />}
							{item.origin && <ScrollText text={item.origin} className="ml-auto min-w-0 max-w-[20%] shrink-0 text-detail text-ink-faint" />}
						</>
					),
				};
			}}
		/>
	);
	const combobox: ComboboxState = { id, active: current, open: matches.length > 0 };
	return { extension, menu, combobox };
}
