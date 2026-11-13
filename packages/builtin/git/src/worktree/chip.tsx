/**
 * 输入框上方、项目签那一行里属于工作树的一格，按对话所处的时刻是三样之一：
 *
 * - 新对话（还没发第一条、项目是仓库）：开关，这一个对话要不要自己的工作树。只有这时选才有意义，跑起来的对话挪不进副本。
 *   两个答案一眼都看得见：只有记号，或者记号加名字、用强调色，和计划模式那颗开关说同一件事的样子一样。
 * - 有工作树的对话：工作树签，⑂ 加分支名，和基分支差几个提交；点开是合回去、同步进来的菜单，合回去以后可以顺手归档。这颗签不切分支：
 *   工作树就是它的分支，在里面检出别的会把对话的活放到它看不见的地方。
 * - 要过却没建成的对话：琥珀色的提醒，一直在，点开是说明和 git 的原话。
 */

import type { ComposerChipProps } from "@plume/contract/ui";
import {
	ComposerToggle,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	Popover,
	ScrollText,
	Text,
	macKeyboard,
	useLiveRefresh,
	usePopover,
} from "@plume/ui";
import { Archive, Check, ChevronDown, CircleAlert, FolderOpen, GitFork, GitMerge, MessageSquare, RefreshCw, Undo2 } from "@plume/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MergeOutcome, SessionRecord, SessionWorktree, SyncOutcome, WorktreeState } from "./api.ts";
import type { WorktreeMessages as Messages } from "../messages.ts";
import { notify, reasonOf, revealPath, useText, worktree } from "./remote.ts";

const ICON = { size: 13, strokeWidth: 1.8 } as const;
/** 冲突的文件先点名这么几个，其余的数一个数：认得出，又读得完。 */
const NAMED_FILES = 4;

type Anchor = ReturnType<typeof usePopover>["anchor"];

export function WorktreeSlot({ sessionId, cwd, running, send }: ComposerChipProps) {
	if (!sessionId) return cwd ? <NewWorktreeToggle cwd={cwd} /> : null;
	return <SessionWorktreeSlot sessionId={sessionId} cwd={cwd} running={running} send={send} />;
}

/**
 * 新对话的开关，按项目目录记在逻辑入口：换个项目、发出第一条以后，都回到关。
 */
function NewWorktreeToggle({ cwd }: { cwd: string }) {
	const text = useText();
	const [repo, setRepo] = useState(false);
	const [on, setOn] = useState(false);
	useEffect(() => {
		let live = true;
		setRepo(false);
		Promise.all([worktree().isRepo(cwd), worktree().worktreePick(cwd)]).then(
			([isRepo, picked]) => {
				if (!live) return;
				setRepo(isRepo);
				setOn(picked);
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [cwd]);
	if (!repo) return null;
	const change = (next: boolean) => {
		setOn(next);
		worktree()
			.chooseWorktree(cwd, next)
			.then(undefined, (error: unknown) => {
				setOn(!next);
				notify(reasonOf(error), "error");
			});
	};
	return (
		<ComposerToggle
			on={on}
			onChange={change}
			icon={<GitFork size={16} strokeWidth={1.8} />}
			label={text.toggle}
			tip={on ? text.toggleOn : text.toggleOff}
			data-worktree-toggle=""
		/>
	);
}

/** 上次读到的样子，按会话：回到一个对话时先画它，同时重读。 */
const lastRecord = new Map<string, SessionRecord | null>();
const lastState = new Map<string, WorktreeState>();

function SessionWorktreeSlot({ sessionId, cwd, running, send }: { sessionId: string; cwd?: string; running: boolean; send: (text: string) => void }) {
	const [record, setRecord] = useState<SessionRecord | null>(() => lastRecord.get(sessionId) ?? null);
	const current = useRef(sessionId);
	current.current = sessionId;

	useEffect(() => setRecord(lastRecord.get(sessionId) ?? null), [sessionId]);

	// 第一轮里工作树是在跑起来以后才建的：跟着这一轮读，建好、建不成都当场出现。读的是插件记下的一份，很便宜。
	const refresh = useCallback(async () => {
		const next = await worktree().worktreeRecord(sessionId);
		lastRecord.set(sessionId, next);
		if (current.current === sessionId) setRecord(next);
		// `cwd` 只为在会话换了目录时重读一次。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [sessionId, cwd]);
	useLiveRefresh(refresh, running);

	if (record?.worktree) return <WorktreeChip sessionId={sessionId} tree={record.worktree} running={running} send={send} />;
	if (record?.error) return <FailedNote reason={record.error} />;
	return null;
}

/**
 * 工作树对着基分支的样子，每次现问 git：打开对话、一轮结束（模型提交了）、窗口回到前台（人在终端里提交了）时重读。
 * 不定时轮询：每读一次是好几个 git 调用，没人干活的工作树里什么都不会变。
 */
function useWorktreeState(sessionId: string, running: boolean) {
	const [state, setState] = useState<WorktreeState | null>(() => lastState.get(sessionId) ?? null);
	const current = useRef(sessionId);
	current.current = sessionId;
	const refresh = useCallback(async () => {
		const next = await worktree()
			.worktreeState(sessionId)
			.catch(() => null);
		if (next) lastState.set(sessionId, next);
		else lastState.delete(sessionId);
		if (current.current === sessionId) setState(next);
		return next;
	}, [sessionId]);
	useEffect(() => setState(lastState.get(sessionId) ?? null), [sessionId]);
	useEffect(() => {
		if (!running) void refresh();
	}, [refresh, running]);
	useEffect(() => {
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);
	return { state, refresh };
}

type WorktreeView = ReturnType<typeof useWorktreeState>;

/** `↑2 ↓1`：等着合回去的、基分支上新落的；同步停在冲突上时多一个琥珀色记号。 */
function DistanceMarks({ ahead, behind, conflicted }: { ahead: number; behind: number; conflicted: boolean }) {
	if (!ahead && !behind && !conflicted) return null;
	return (
		<Text size="caption" tone="faint" numeric className="worktree-chip-marks">
			{ahead > 0 && <span>↑{ahead}</span>}
			{behind > 0 && <span>↓{behind}</span>}
			{conflicted && <CircleAlert size={12} strokeWidth={2} className="worktree-warning" aria-hidden />}
		</Text>
	);
}

function WorktreeChip({ sessionId, tree, running, send }: { sessionId: string; tree: SessionWorktree; running: boolean; send: (text: string) => void }) {
	const text = useText();
	const menu = usePopover();
	const view = useWorktreeState(sessionId, running);
	const { state } = view;
	return (
		<>
			{/* 字号挂在外面这一层：签本身是按钮，`Text` 渲染不成按钮。 */}
			<Text size="label" className="worktree-chip-slot">
				<button
					type="button"
					data-plume-tip={text.chipTip(tree.branch)}
					data-worktree-chip=""
					aria-haspopup="menu"
					aria-expanded={menu.open}
					onClick={menu.toggle}
					// 目录被收走时变灰：说的那个东西眼下不在盘上。
					data-dimmed={state?.present === false || undefined}
					className="plume-composer-control plume-scroll worktree-chip"
				>
					<span className="worktree-chip-icon">
						<GitFork size={16} strokeWidth={1.8} />
					</span>
					<ScrollText text={tree.branch} className="worktree-chip-name" />
					<DistanceMarks ahead={state?.ahead ?? 0} behind={state?.behind ?? 0} conflicted={Boolean(state?.merging)} />
					<ChevronDown size={14} className="worktree-chip-icon" aria-hidden />
				</button>
			</Text>
			{menu.open && <WorktreeMenu anchor={menu.anchor} onClose={menu.close} sessionId={sessionId} tree={tree} view={view} running={running} send={send} />}
		</>
	);
}

/** `archive`：刚合回去、对话还没归档，结果下面问一句要不要顺手归档。 */
type Note = { tone: "ok" | "warn"; text: string; archive?: boolean };

/**
 * 工作树签后面的菜单：它对着基分支在哪，和能做的两件事——把它的提交合回去、把基分支的新提交带进来。
 *
 * 做完的结果留在菜单里、动作下面，而不是弹一条提示：冲突连着文件和下一步怎么办，读的时候它得还在。
 */
function WorktreeMenu({
	anchor,
	onClose,
	sessionId,
	tree,
	view,
	running,
	send,
}: {
	anchor: Anchor;
	onClose: () => void;
	sessionId: string;
	tree: SessionWorktree;
	view: WorktreeView;
	running: boolean;
	send: (text: string) => void;
}) {
	const text = useText();
	const [busy, setBusy] = useState<"merge" | "sync" | "abort" | null>(null);
	const [note, setNote] = useState<Note | null>(null);
	const { state } = view;
	const base = state?.base ?? tree.base ?? "main";

	// 打开时重读：签上那份可能是一轮以前的。
	useEffect(() => {
		void view.refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 每次打开读一次，不是每次读到都再读
	}, []);

	const files = (list: string[]) =>
		list.length > NAMED_FILES ? `${list.slice(0, NAMED_FILES).join(", ")} ${text.moreFiles(list.length - NAMED_FILES)}` : list.join(", ");

	async function act<T>(kind: "merge" | "sync" | "abort", run: () => PromiseLike<T>, describe: (outcome: T) => Note | null) {
		setBusy(kind);
		setNote(null);
		try {
			setNote(describe(await run()));
		} catch (error) {
			setNote({ tone: "warn", text: text.refusedFailed(reasonOf(error)) });
		} finally {
			setBusy(null);
			await view.refresh();
		}
	}

	const merge = () =>
		act(
			"merge",
			() => worktree().mergeWorktree(sessionId),
			(outcome: MergeOutcome): Note => {
				switch (outcome.kind) {
					case "merged":
						return { tone: "ok", text: text.merged(outcome.commits, outcome.base), archive: !outcome.archived };
					case "nothing":
						return { tone: "ok", text: text.whyNothing };
					case "uncommitted":
						return { tone: "warn", text: text.whyUncommitted(outcome.files) };
					case "conflict":
						return { tone: "warn", text: text.mergeConflict(files(outcome.files), outcome.base) };
					default:
						return { tone: "warn", text: refusal(text, outcome, base) };
				}
			},
		);

	const sync = () =>
		act(
			"sync",
			() => worktree().syncWorktree(sessionId),
			(outcome: SyncOutcome): Note | null => {
				switch (outcome.kind) {
					case "synced":
						return { tone: "ok", text: text.synced(outcome.commits, outcome.base) };
					case "up-to-date":
						return { tone: "ok", text: text.whyUpToDate };
					case "uncommitted":
						return { tone: "warn", text: text.whyUncommitted(outcome.files) };
					// 由动作上面那块冲突说，连着该怎么办。
					case "conflict":
						return null;
					default:
						return { tone: "warn", text: refusal(text, outcome, base) };
				}
			},
		);

	const abortSync = () =>
		act(
			"abort",
			() => worktree().abortWorktreeSync(sessionId),
			(done: boolean) => (done ? null : { tone: "warn", text: text.refusedFailed("git merge --abort") }),
		);

	/*
	 * 冲突交给做了这些活的对话：以人的身份直接发给它，按钮上写明了要它做什么。它比谁都清楚两边各自想做什么。
	 */
	function resolve(conflicted: string[]) {
		onClose();
		send(text.resolvePrompt(base, conflicted.join(", ")));
	}

	// 活合回去了，对话多半也到头了：归档照归档的规矩收走目录，分支已在基分支里就一起删。
	function archive() {
		onClose();
		worktree()
			.archiveSession(sessionId)
			.then(undefined, (error: unknown) => notify(reasonOf(error), "error"));
	}

	const reveal = () => {
		onClose();
		revealPath(tree.cwd).then(undefined, (error: unknown) => notify(text.revealFailed(reasonOf(error)), "error"));
	};

	const present = state?.present ?? true;
	const mergeWhy = running
		? text.whyRunning
		: state?.merging
			? text.whyConflicts
			: state && state.uncommitted > 0
				? text.whyUncommitted(state.uncommitted)
				: state && state.ahead === 0
					? text.whyNothing
					: undefined;
	const syncWhy = running
		? text.whyRunning
		: !present
			? text.whyTakenBack
			: state && state.uncommitted > 0
				? text.whyUncommitted(state.uncommitted)
				: state && state.behind === 0
					? text.whyUpToDate
					: undefined;

	return (
		<Popover
			anchor={anchor}
			onClose={onClose}
			placement="top"
			align="start"
			width="wide"
			maxHeight={MENU_MAX_HEIGHT}
			label={text.menuTitle}
			footer={
				note && (
					<div className="worktree-note-block">
						<div data-worktree-note={note.tone} className="worktree-note">
							{note.tone === "ok" ? (
								<Check {...ICON} className="worktree-note-icon worktree-ok" aria-hidden />
							) : (
								<CircleAlert {...ICON} className="worktree-note-icon worktree-warning" aria-hidden />
							)}
							<Text size="caption" tone={note.tone === "ok" ? "muted" : "default"} className="worktree-note-text">
								{note.text}
							</Text>
						</div>
						{note.archive && (
							<MenuBody className="worktree-note-archive">
								<MenuItem icon={<Archive {...ICON} />} onClick={archive}>
									{text.archive}
								</MenuItem>
							</MenuBody>
						)}
					</div>
				)
			}
		>
			<MenuBody>
				<Status branch={tree.branch} base={base} state={state} text={text} />
				<MenuSeparator />
				{state?.merging && (
					<>
						<MenuLabel>
							<span className="worktree-conflicts-label">
								<CircleAlert {...ICON} className="worktree-warning" aria-hidden />
								<Text size="caption" tone="default">
									{text.conflicts(base)}
								</Text>
							</span>
						</MenuLabel>
						{state.conflicted.length > 0 && (
							<Text as="p" size="caption" tone="muted" mono data-plume-tip={state.conflicted.join(", ")} className="worktree-conflicts">
								{files(state.conflicted)}
							</Text>
						)}
						<MenuItem icon={<MessageSquare {...ICON} />} disabled={running || busy !== null} onClick={() => resolve(state.conflicted)}>
							{text.resolve}
						</MenuItem>
						<MenuItem icon={<Undo2 {...ICON} />} disabled={running || busy !== null} onClick={() => void abortSync()}>
							{text.abortSync}
						</MenuItem>
						<MenuSeparator />
					</>
				)}
				<MenuItem
					icon={<GitMerge {...ICON} className={busy === "merge" ? "worktree-pulse" : undefined} />}
					disabled={Boolean(mergeWhy) || busy !== null}
					detail={mergeWhy}
					onClick={() => void merge()}
				>
					{text.merge(base)}
				</MenuItem>
				{!state?.merging && (
					<MenuItem
						icon={<RefreshCw {...ICON} className={busy === "sync" ? "worktree-pulse" : undefined} />}
						disabled={Boolean(syncWhy) || busy !== null}
						detail={syncWhy}
						onClick={() => void sync()}
					>
						{text.sync(base)}
					</MenuItem>
				)}
				<MenuItem icon={<FolderOpen {...ICON} />} disabled={!present} onClick={reveal}>
					{macKeyboard() ? text.reveal : /^Win/i.test(navigator.platform) ? text.revealExplorer : text.revealOther}
				</MenuItem>
			</MenuBody>
		</Popover>
	);
}

function refusal(text: Messages, outcome: Extract<MergeOutcome | SyncOutcome, { kind: "refused" }>, base: string): string {
	switch (outcome.reason) {
		case "gone":
			return text.refusedGone;
		case "no-base":
			return text.refusedNoBase;
		case "running":
			return text.refusedRunning;
		case "syncing":
			return text.whyConflicts;
		case "busy":
			return text.refusedBusy;
		case "elsewhere":
			return text.refusedElsewhere(base, outcome.detail ?? "");
		case "failed":
			return text.refusedFailed(outcome.detail ?? "git");
	}
}

/** 分支名，和一行话说它对着基分支怎样。 */
function Status({ branch, base, state, text }: { branch: string; base: string; state: WorktreeState | null; text: Messages }) {
	const facts = [text.cutFrom(base)];
	if (state && !state.present) facts.push(text.takenBack);
	if (state && state.ahead > 0) facts.push(text.ahead(state.ahead));
	if (state && state.behind > 0) facts.push(text.behind(state.behind));
	// 同步中途改过的文件就是冲突的那些，下面那块会点名。
	if (state && state.uncommitted > 0 && !state.merging) facts.push(text.uncommitted(state.uncommitted));
	return (
		<div data-worktree-status="" className="worktree-status">
			<Text size="detail" mono>
				<ScrollText text={branch} />
			</Text>
			<Text as="p" size="caption" tone="faint" className="worktree-status-facts">
				{facts.join(" · ")}
			</Text>
		</div>
	);
}

/**
 * 要过工作树、却在项目里跑的对话：这意味着什么，以及 git 自己说的原因。就放在发送前会看一眼项目和分支的地方，一直在。
 */
function FailedNote({ reason }: { reason: string }) {
	const text = useText();
	const note = usePopover();
	return (
		<>
			<button
				type="button"
				data-worktree-failed=""
				aria-label={text.failed}
				data-plume-tip={text.failed}
				aria-haspopup="dialog"
				aria-expanded={note.open}
				onClick={note.toggle}
				className="plume-composer-control worktree-failed"
			>
				<CircleAlert size={16} strokeWidth={1.9} aria-hidden />
			</button>
			{note.open && (
				<Popover anchor={note.anchor} onClose={note.close} placement="top" align="start" width="wide" role="dialog" label={text.failed}>
					<div data-worktree-failed-note="" className="worktree-failed-note">
						<span className="worktree-failed-title">
							<CircleAlert {...ICON} className="worktree-warning" aria-hidden />
							<Text size="label">{text.failed}</Text>
						</span>
						<Text as="p" size="caption" tone="muted">
							{text.failedDetail}
						</Text>
						<Text as="p" size="caption" tone="faint" mono className="worktree-failed-reason">
							{reason}
						</Text>
					</div>
				</Popover>
			)}
		</>
	);
}
