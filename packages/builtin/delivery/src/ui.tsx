import type { ChangedFile, SessionView } from "@plume/contract";
import type { PanelProps, TurnFooterProps, UiContext, UiPlugin } from "@plume/contract/ui";
import { Button, Caret, IconButton, PanelEmpty, Popover, Scroller, Text, useConfirmer, useI18n } from "@plume/ui";
import { FileDiff as FileDiffIcon, Files, Undo2 } from "@plume/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DeliveryApi } from "./api.ts";
import deliveryCss from "./delivery.css";
import { fill, MESSAGES } from "./messages.ts";
import { createDeliveryState, type DeliveryState } from "./state.tsx";

const PREVIEW_FILES = 3;
const HOVER_OPEN_MS = 700;
const HOVER_CLOSE_MS = 160;
const REVIEW_PANEL = "review";

function useMounted() {
	const mounted = useRef(true);
	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	return mounted;
}

function relativeTo(root: string, path: string): string {
	const prefix = root.replace(/[\\/]+$/, "") + (root.includes("\\") ? "\\" : "/");
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function FileName({ path }: { path: string }) {
	const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
	return (
		<Text className="plume-delivery-name">
			<Text tone="muted">{path.slice(0, split)}</Text>
			<Text>{path.slice(split)}</Text>
		</Text>
	);
}

function Counts({ added, removed }: { added: number; removed: number }) {
	return (
		<Text numeric className="plume-delivery-counts">
			<Text className="plume-delivery-added">+{added}</Text>
			<Text tone="danger">−{removed}</Text>
		</Text>
	);
}

function useUndo(ui: UiContext, state: DeliveryState, sessionId: string, timestamp: number) {
	const messages = MESSAGES[useI18n().resolvedLocale];
	const confirm = useConfirmer();
	const mounted = useMounted();
	const ask = (path?: string) =>
		confirm.ask({
			title: path ? messages.revertFileConfirm : messages.revertAllConfirm,
			detail: (
				<Text size="body" tone="muted">
					{messages.revertDetail}
				</Text>
			),
			confirmLabel: messages.revertChanges,
			onConfirm: () => {
				void state
					.undo(sessionId, timestamp, path)
					.then((changed) => {
						if (mounted.current) ui.notify(changed ? messages.reverted : messages.cannotRevert, changed ? "info" : "warn");
					})
					.catch((error: unknown) => {
						if (mounted.current) ui.notify(String(error), "error");
					});
			},
		});
	return { ask, element: confirm.element };
}

function Delivery({ ui, state, session, timestamp }: TurnFooterProps & { ui: UiContext; state: DeliveryState }) {
	const messages = MESSAGES[useI18n().resolvedLocale];
	const { id: sessionId, cwd } = session.summary;
	const { data, undoing } = state.useDelivery(sessionId, timestamp);
	const pathMenu = ui.useFileMenu(cwd);
	const [expanded, setExpanded] = useState(false);
	const [hover, setHover] = useState<{ anchor: HTMLElement; path: string } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const mounted = useMounted();
	const undo = useUndo(ui, state, sessionId, timestamp);
	useEffect(() => () => clearTimeout(timer.current), []);
	const keepHover = () => clearTimeout(timer.current);
	const hideHover = () => {
		keepHover();
		setHover(null);
	};
	const schedule = (next: typeof hover, delay: number) => {
		keepHover();
		timer.current = setTimeout(() => {
			timer.current = undefined;
			if (!next || next.anchor.isConnected) setHover(next);
		}, delay);
	};
	const closeHover = () => schedule(null, HOVER_CLOSE_MS);
	const offRows = (event: { target: EventTarget | null }) => {
		if (event.target instanceof Element && event.target.closest("[data-delivery-file]")) return;
		closeHover();
	};
	useEffect(() => {
		if (pathMenu.open) {
			clearTimeout(timer.current);
			setHover(null);
		}
	}, [pathMenu.open]);
	if (!data?.files.length) return undo.element;
	const files = data.files;
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	const remaining = files.length - PREVIEW_FILES;
	const hovered = hover && files.find((file) => file.path === hover.path);
	const moreId = `delivery-${sessionId}-${timestamp}-more`;
	const openFile = (path: string) => {
		hideHover();
		void ui.openFile(path, sessionId).catch((error: unknown) => {
			if (mounted.current) ui.notify(String(error), "error");
		});
	};
	const review = (path?: string) => {
		hideHover();
		state.select(sessionId, { review: { timestamp, path } });
		ui.openPanel(REVIEW_PANEL, sessionId);
	};
	const askUndo = (path?: string) => {
		hideHover();
		undo.ask(path);
	};
	const undoButton = (file: ChangedFile) => (
		<IconButton
			size="sm"
			icon={<Undo2 size={14} />}
			label={file.canUndo ? messages.revertOne : file.undoReason || messages.cannotRevert}
			explainDisabled
			disabled={!file.canUndo || undoing}
			className={undoing ? "plume-delivery-busy" : ""}
			onClick={() => askUndo(file.path)}
		/>
	);
	const row = (file: ChangedFile) => (
		<button
			key={file.path}
			type="button"
			data-delivery-file={file.path}
			className="plume-delivery-row"
			onMouseEnter={(event) => {
				if (!pathMenu.open) schedule({ anchor: event.currentTarget, path: file.path }, HOVER_OPEN_MS);
			}}
			onPointerDown={hideHover}
			onFocus={(event) => {
				if (!event.currentTarget.matches(":focus-visible") || pathMenu.open) return;
				keepHover();
				setHover({ anchor: event.currentTarget, path: file.path });
			}}
			onBlur={closeHover}
			onClick={() => review(file.path)}
			onContextMenu={(event) => {
				hideHover();
				pathMenu.onContextMenu(event, { path: file.path, onOpen: () => openFile(file.path) });
			}}
		>
			<FileName path={relativeTo(cwd, file.path)} />
			<Counts added={file.added} removed={file.removed} />
		</button>
	);
	return (
		<>
			<div className="plume-delivery-wrap" onMouseLeave={closeHover} onMouseOver={offRows} onFocus={offRows}>
				<section data-turn-delivery aria-label={messages.fileChanges} className="plume-delivery-card">
					<div className="plume-delivery-head">
						<span className="plume-delivery-mark">
							<FileDiffIcon size={21} strokeWidth={1.7} />
						</span>
						<div className="plume-delivery-summary">
							<Text as="p" weight="medium" className="plume-delivery-heading">
								{fill(files.length === 1 ? messages.editedOne : messages.editedN, { n: files.length })}
							</Text>
							<Counts added={added} removed={removed} />
						</div>
						<div className="plume-delivery-actions">
							{files.every((file) => file.canUndo) && (
								<Button size="sm" variant="subtle" icon={<Undo2 size={14} />} loading={undoing} label={messages.revertThis} onClick={() => askUndo()}>
									<Text className="plume-delivery-action-label">{messages.revert}</Text>
								</Button>
							)}
							<Button size="sm" variant="subtle" icon={<Files size={14} />} label={messages.reviewAll} onClick={() => review()}>
								<Text className="plume-delivery-action-label">{messages.review}</Text>
							</Button>
						</div>
					</div>
					<div className="plume-delivery-files">
						{files.slice(0, PREVIEW_FILES).map(row)}
						{remaining > 0 && (
							<>
								<div id={moreId} className="plume-reveal" data-open={expanded} aria-hidden={!expanded} inert={!expanded}>
									<div>{files.slice(PREVIEW_FILES).map(row)}</div>
								</div>
								<button
									type="button"
									aria-expanded={expanded}
									aria-controls={moreId}
									className="plume-delivery-row plume-delivery-more"
									onClick={() => {
										hideHover();
										setExpanded(!expanded);
									}}
								>
									<Text size="detail" className="plume-delivery-action-label">
										{expanded ? messages.collapse : fill(remaining === 1 ? messages.showMoreOne : messages.showMore, { n: remaining })}
									</Text>
									<Caret open={expanded} size={14} />
								</button>
							</>
						)}
					</div>
				</section>
			</div>
			{hover && hovered && (
				<Popover
					anchor={hover.anchor}
					onClose={hideHover}
					role="group"
					label={messages.previewChanges}
					placement="top"
					align="start"
					width={hover.anchor.offsetWidth}
					maxHeight={420}
					surface="panel"
					onMouseEnter={keepHover}
					onMouseLeave={closeHover}
					header={
						<div className="plume-delivery-file-head">
							<FileName path={relativeTo(cwd, hovered.path)} />
							<Counts added={hovered.added} removed={hovered.removed} />
							{undoButton(hovered)}
						</div>
					}
				>
					<ui.FileDiff path={hovered.path} hunks={hovered.hunks} showPath={false} maxLines={Infinity} />
				</Popover>
			)}
			{undo.element}
			{pathMenu.element}
		</>
	);
}

function Review({ ui, state, session, timestamp, path }: { ui: UiContext; state: DeliveryState; session: SessionView; timestamp: number; path?: string }) {
	const messages = MESSAGES[useI18n().resolvedLocale];
	const { id: sessionId, cwd } = session.summary;
	const { data, undoing } = state.useDelivery(sessionId, timestamp);
	const undo = useUndo(ui, state, sessionId, timestamp);
	const pathMenu = ui.useFileMenu(cwd);
	const files = (data?.files ?? []).filter((file) => !path || file.path === path);
	return (
		<>
			{files.length ? (
				<Scroller top="none" className="plume-delivery-scroller">
					{files.map((file) => (
						<section key={file.path} data-delivery-diff={file.path} className="plume-delivery-diff">
							<div className="plume-delivery-sticky">
								<div className="plume-delivery-file-head" onContextMenu={(event) => pathMenu.onContextMenu(event, { path: file.path })}>
									<FileName path={relativeTo(cwd, file.path)} />
									<Counts added={file.added} removed={file.removed} />
									<IconButton
										size="sm"
										icon={<Undo2 size={14} />}
										label={file.canUndo ? messages.revertOne : file.undoReason || messages.cannotRevert}
										explainDisabled
										disabled={!file.canUndo || undoing}
										className={undoing ? "plume-delivery-busy" : ""}
										onClick={() => undo.ask(file.path)}
									/>
								</div>
							</div>
							<ui.FileDiff path={file.path} hunks={file.hunks} showPath={false} maxLines={Infinity} />
						</section>
					))}
				</Scroller>
			) : (
				<PanelEmpty icon={FileDiffIcon} title={messages.fileChanges} />
			)}
			{undo.element}
			{pathMenu.element}
		</>
	);
}

export default {
	name: "plume.delivery",
	apply(ui) {
		const state = createDeliveryState(ui.remote<DeliveryApi>(), ui);
		let style: HTMLStyleElement | null = null;
		let surfaces = 0;
		function useStyles() {
			useLayoutEffect(() => {
				if (!style) {
					style = document.createElement("style");
					style.dataset.pluginStyle = ui.name;
					style.textContent = deliveryCss;
					document.head.append(style);
				}
				++surfaces;
				return () => {
					if (!--surfaces) {
						style?.remove();
						style = null;
					}
				};
			}, []);
		}
		function Footer(props: TurnFooterProps) {
			useStyles();
			return <Delivery key={`${props.session.summary.id}:${props.timestamp}`} {...props} ui={ui} state={state} />;
		}
		function ReviewPanel({ session, setTitle }: PanelProps) {
			useStyles();
			const { review } = state.useSelection(session?.summary.id);
			const messages = MESSAGES[useI18n().resolvedLocale];
			useLayoutEffect(() => {
				setTitle(review?.path?.split(/[\\/]/).pop());
			}, [review?.path, setTitle]);
			if (!session || !review) return <PanelEmpty icon={FileDiffIcon} title={messages.fileChanges} />;
			return <Review key={`${session.summary.id}:${review.timestamp}:${review.path ?? ""}`} ui={ui} state={state} session={session} {...review} />;
		}
		ui.turnFooter("delivery", Footer);
		ui.panel(REVIEW_PANEL, ReviewPanel, {
			title: (locale) => MESSAGES[locale].fileChanges,
			icon: FileDiffIcon,
			listed: false,
			available: ({ session }) => session,
		});
	},
} satisfies UiPlugin;
