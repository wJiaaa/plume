/**
 * Git 面板：此刻在改什么、以前改过什么、还有哪些分支，三个问题三个视图。
 *
 * 三个视图共用一个文件列表：「改了什么」不管是没提交的、一个提交里的，还是两个分支之间的，画出来都一样。
 * 上面一行是在哪个分支、和远端差多少，以及拉取、提交与推送、获取三颗按钮。
 */

import type { PanelProps } from "@plume/contract/ui";
import {
	ActionSpinner,
	Button,
	CountUp,
	IconButton,
	PanelEmpty,
	RetainedViews,
	SkeletonList,
	Text,
	useLiveRefresh,
	useNarrow,
	usePopover,
	useSlowLoad,
} from "@plume/ui";
import { AlertCircle, ArrowDownToLine, ArrowUpFromLine, GitBranch, GitCommitHorizontal, GitCompare, RefreshCw, Sparkles, X } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteResult, RepoRef } from "../api.ts";
import type { MessageKey } from "../messages.ts";
import { BranchesView } from "./BranchesView.tsx";
import { ChangesView } from "./ChangesView.tsx";
import { readCheckout, useCheckout } from "./checkout.ts";
import { CommitPushDialog } from "./CommitPushDialog.tsx";
import { useCommitWork } from "./commit-work.ts";
import { draft, notify } from "./host.ts";
import { HistoryView } from "./HistoryView.tsx";
import { useT } from "./i18n.ts";
import { git, settle } from "./remote.ts";
import { RepoPicker } from "./RepoPicker.tsx";
import { syncPlan, type SyncButton } from "./sync-plan.ts";
import type { Act } from "./types.ts";
import { useRepoStatus } from "./use-repo-status.ts";

type View = "changes" | "history" | "branches";

/**
 * 多久悄悄问一次远端。
 *
 * 等的是别人推送，不是每秒都要问的事；每一次又是一次网络请求，笔记本可能正连着手机热点。
 * 五分钟不费什么，又足够让「远端领先 3 个提交」在还有用的时候出现。
 */
const QUIET_FETCH_INTERVAL_MS = 5 * 60_000;

/** 三个视图存的是文案的键：这张表在模块加载时成型，那时还不知道界面是哪种语言。 */
const VIEWS: { id: View; labelKey: MessageKey; icon: typeof GitCompare }[] = [
	{ id: "changes", labelKey: "git.changes", icon: GitCompare },
	{ id: "history", labelKey: "git.history", icon: GitCommitHorizontal },
	{ id: "branches", labelKey: "common.branches", icon: GitBranch },
];

/** 人按下停止的那一下：调用以取消结束，不算失败，什么都不用说。 */
function cancelled(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "E_CANCELLED";
}

/**
 * 同步那一行的一颗按钮：平时是图标，行里放得下时，值得按的那一颗把字写出来。
 *
 * 「推送 1」是一句话，`↑¹` 是一道谜题；但三颗都写字就成了一排在喊的工具栏，加重的意义正是只有一样东西突出。
 */
function SyncControl({
	icon,
	word,
	state,
	running,
	cancellable = true,
	busyLabel,
	disabled,
	roomForWords,
	onClick,
}: {
	icon: React.ReactNode;
	/** 写字时的动词。 */
	word: string;
	state: SyncButton;
	running: boolean;
	/**
	 * 转着的这一下能不能叫停。
	 *
	 * 远端的三件事可以：它们跨网络、可能卡住，再按一次就是取消。本地的提交不行：落在磁盘上的那一刻起没有中途可言，
	 * 模型写到一半的句子也叫不回来。能停的悬停时变成一个叉；不能停的一直转，按下去是回到弹窗，那里写着正在发生什么。
	 */
	cancellable?: boolean;
	/** 停不了的那一下在做什么；没有就用 `state.tip`。 */
	busyLabel?: string;
	disabled: boolean;
	roomForWords: boolean;
	onClick: (event: React.MouseEvent<HTMLElement>) => void;
}) {
	const t = useT();
	const [hovered, setHovered] = useState(false);
	const label = running ? (cancellable ? t("git.cancelAction", { word }) : (busyLabel ?? state.tip)) : state.tip;
	const currentIcon = running ? hovered && cancellable ? <X size={12} strokeWidth={2} className="git-ink" /> : <ActionSpinner size={12} /> : icon;

	// 只给加重的那一颗、只在它空闲、只在行够宽时写字：写出来不能把分支名挤出视野。
	if (!roomForWords || !state.emphasis || running) {
		return (
			<span
				data-plume-busy={running ? (cancellable ? "cancellable" : "working") : undefined}
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
				className="git-inline-flex"
			>
				<IconButton
					icon={currentIcon}
					label={label}
					size="sm"
					disabled={disabled}
					explainDisabled={state.disabled}
					emphasis={state.emphasis}
					badge={running ? null : state.count}
					onClick={onClick}
				/>
			</span>
		);
	}
	return (
		<button
			type="button"
			aria-label={label}
			data-plume-tip={label}
			disabled={disabled}
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			className="git-sync-word"
		>
			{currentIcon}
			<Text size="caption" weight="medium" numeric>
				{state.count === null ? word : `${word} ${state.count}`}
			</Text>
		</button>
	);
}

export function GitPanel({ session, cwd: projectDir, shown }: PanelProps) {
	const t = useT();
	/*
	 * 看的是下一轮在哪跑的那个项目目录，还没发消息的新对话也一样。不属于任何项目的聊天没有检出可看：
	 * 这时面板本来就不列出来（见 `ui.tsx` 的 `available`），这里只是兜底。
	 */
	const root = projectDir ?? null;
	const running = session?.summary.running ?? false;
	const checkout = useCheckout(root);
	const [view, setView] = useState<View>("changes");
	/*
	 * 面板在看哪个仓库。
	 *
	 * 工作区是人打开的一个文件夹，里面放好几个仓库很平常：前端挨着后端，或者有意分开管版本的几个服务。
	 * 把根目录当成仓库，其余的就都看不见了。
	 */
	const [repos, setRepos] = useState<RepoRef[]>([]);
	/** 第一次扫描完之前为真：「没有仓库」要等知道了才说。 */
	const [scanning, setScanning] = useState(true);
	/** 改了扫描结果的事情之后加一，重扫。 */
	const [rescan, setRescan] = useState(0);
	/** 每个仓库的工作树，按仓库路径存。 */
	const [trees, setTrees] = useState<Record<string, RepoRef[]>>({});
	const [selected, setSelected] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [narrowNav, navRef] = useNarrow(330);
	/*
	 * 同步那一行能不能把要做的那一步写成字。
	 *
	 * 量的是这一行而不是窗口：同一个面板可能很窄，也可能占半个宽屏。260 是因为「推送 1」比单个图标多占 30px 左右，
	 * 再窄就要拿分支名（说明你在哪的那个东西）的字来换。
	 */
	const [narrowSyncRow, syncRowRef] = useNarrow(260);
	const roomForWords = !narrowSyncRow;

	/*
	 * 项目换了就重扫；选中的仓库还在就留着。
	 *
	 * 每个仓库同时问它的工作树。工作树自己有 `.git`，目录扫描会把它当成另一个仓库再列一遍：同一段历史的同一个分支，
	 * 两个名字出现两次。所以被某个仓库认作工作树的，从顶层拿掉，挂到它所属的仓库下面。
	 */
	useEffect(() => {
		if (!root) {
			setRepos([]);
			setTrees({});
			setScanning(false);
			return;
		}
		let live = true;
		setScanning(true);
		void (async () => {
			const found = await git()
				.repos(root)
				.catch(() => [] as RepoRef[]);
			const lists = await Promise.all(
				found.map(
					async (repo) =>
						[
							repo.path,
							await git()
								.worktrees(repo.path)
								.catch(() => [] as RepoRef[]),
						] as const,
				),
			);
			if (!live) return;
			const linked = new Map<string, RepoRef[]>();
			const claimed = new Set<string>();
			for (const [path, all] of lists) {
				const attached = all.filter((tree) => tree.worktree);
				linked.set(path, attached);
				for (const tree of attached) claimed.add(tree.path);
			}
			const roots = found.filter((repo) => !claimed.has(repo.path));
			setRepos(roots);
			setTrees(Object.fromEntries(roots.map((repo) => [repo.path, linked.get(repo.path) ?? []])));
			setSelected((current) => {
				const reachable = [...roots.map((repo) => repo.path), ...claimed];
				return current && reachable.includes(current) ? current : (roots[0]?.path ?? null);
			});
			setScanning(false);
		})();
		return () => {
			live = false;
		};
	}, [root, rescan]);

	/*
	 * 只认真的仓库，从不拿项目根目录顶替。
	 *
	 * 拿文件夹兜底的话，一个根本没有版本管理的目录会画成一个没有分支的仓库：分支名的位置一条横线，拉取推送按了没用，
	 * 还宣布「工作区干净」，说的是一段不存在的历史。
	 */
	const cwd = selected;
	const { status, read, refresh } = useRepoStatus(cwd);

	/*
	 * 检出在底下动了就从头重读，读的时候说一声。
	 *
	 * 切分支改变这个面板的每一个答案，大仓库上 `git status` 要读一会儿，这期间屏幕上的列表属于刚离开的分支。
	 * 把旧分支的文件写在新分支的名字底下比什么都不显示更糟：它是错的，而且没有任何东西说它错。
	 * 只在真的动了时：一轮在跑时每 1.5 秒的轮询原地替换列表，那是「agent 刚改了一个文件」，不该闪占位。
	 */
	const branch = checkout?.branch ?? null;
	const [switching, setSwitching] = useState(false);
	useEffect(() => {
		if (!cwd) return;
		let alive = true;
		setSwitching(true);
		void refresh().finally(() => {
			if (alive) setSwitching(false);
		});
		return () => {
			alive = false;
		};
	}, [cwd, branch, refresh]);

	// agent 干活的同时跟着刷新，不等这一轮结束：这个面板要看的改动正是一轮中间陆续落下的。
	useLiveRefresh(refresh, running);

	/** 每个会改仓库的操作都经过它：失败报出来，之后重读。 */
	const act = useCallback<Act>(
		async (operation) => {
			setBusy(true);
			const result = await settle(operation());
			if (!result.ok) notify(result.error ?? t("common.actionFailed"), "error");
			// 用 `read` 不用 `refresh`：要看到的是这个操作刚做完的样子，见 `useRepoStatus`。
			await read();
			setBusy(false);
			return result.ok;
		},
		[read, t],
	);

	/*
	 * 远端的三件事，只有它们会卡住。
	 *
	 * `sync` 记着哪一件在跑，这一行据此转那一颗、禁用另外两颗；`call` 是这次调用本身，再按一次正在转的按钮就 `.cancel()` 它。
	 */
	const [sync, setSync] = useState<"pull" | "push" | "fetch" | null>(null);
	const call = useRef<{ cancel(): void } | null>(null);

	const pushPopover = usePopover();
	/*
	 * 这一次提交的现场，存在面板上而不是弹窗里：弹窗关掉就卸载，而生成提交说明要两三秒、提交并推送更久，
	 * 状态跟着弹窗走等于一关就把正在发生的事从界面上抹掉。见 `commit-work.ts`。
	 */
	const commitWork = useCommitWork(cwd);

	const remote = useCallback(
		async (kind: "pull" | "push" | "fetch", start: () => PromiseLike<RemoteResult> & { cancel(): void }) => {
			// 已经在跑：这一下是停，不是再来一次。
			if (sync) {
				call.current?.cancel();
				return;
			}
			setSync(kind);
			const pending = start();
			call.current = pending;
			let result: RemoteResult;
			try {
				result = await pending;
			} catch (error) {
				result = cancelled(error) ? { ok: false, cancelled: true } : { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			call.current = null;
			// 取消什么都不说：看着的人就是按停的人。
			if (!result.ok && !result.cancelled) notify(result.error ?? t("common.actionFailed"), "error");
			await read();
			setSync(null);
		},
		[read, sync, t],
	);

	/*
	 * 悄悄问一下远端有什么。
	 *
	 * `ahead`、`behind` 是对着远端跟踪分支算的，只有获取过它们才会动：从不获取的面板上 `behind` 根本不会变成非零，
	 * `ahead` 说的是上次有人手动碰这个仓库时的样子。各个方向都是安静的：不转圈、不禁用按钮、失败直接丢掉。
	 * 笔记本断网是常态，不值得一条红字。
	 */
	const quietFetch = useCallback(async () => {
		if (!cwd) return;
		const result = await settle(git().fetch(cwd, true));
		if (result.ok) await read();
	}, [cwd, read]);

	/*
	 * 一露面先取一次，之后有人看着就每五分钟一次。
	 *
	 * 「看着」要问宿主（`shown`），不能从挂没挂着推断：后台的标签、收起的面板区都还挂着，计时器要是跟着挂载走，
	 * 就会一直替一个没人看的面板去网络上取东西。
	 */
	useEffect(() => {
		if (!cwd || !shown) return;
		void quietFetch();
		const timer = setInterval(() => void quietFetch(), QUIET_FETCH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [cwd, shown, quietFetch]);

	// 下面有几处提前返回，hook 都要在它们上面：每次渲染的 hook 数目要一样。
	const changeCount = (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0);
	/*
	 * 同步那一行和空状态要说的，在一处算好。两边读同一份，屏幕上同一时间只有一个答案。
	 */
	const plan = useMemo(() => syncPlan(status, t), [status, t]);
	/*
	 * 远端从没见过这个分支：推送就是发布。工具条上那颗按钮的字和弹窗里推送那一行读同一个判断。
	 */
	const neverPublished = plan.push.count === null && plan.branch !== "—" && status?.remoteState === "no-upstream";
	/*
	 * 还什么都不知道：仓库还在找，或者找到的那个还没回答状态。两种一样对待：拿一个空的状态画整个面板，
	 * 有两百个没提交文件的仓库会先宣布「工作区干净」再收回去，错得很有把握比没有答案更糟。
	 */
	const unread = scanning || (cwd !== null && status === null) || (root !== null && checkout === null);
	/* 等得够久才画占位：七十毫秒就消失的骨架是一下闪烁，读起来像故障，不像进度。 */
	const slowUnread = useSlowLoad(unread);
	const slowSwitch = useSlowLoad(switching);

	if (!root) {
		return (
			<PanelEmpty icon={GitBranch} title="Git">
				{t("gitPanel.needProject")}
			</PanelEmpty>
		);
	}

	/*
	 * 先什么都不说，但把形状画出来。占位站在行将来要占的位置上，到达时是内容落下，而不是版面突然出现。
	 */
	if (unread) {
		return slowUnread ? (
			<div className="git-enter git-skeleton-pad">
				<SkeletonList count={5} label={t("git.reading")} />
			</div>
		) : (
			<div className="git-fill" />
		);
	}

	/*
	 * git 答不上来，不等于答「不是」。
	 *
	 * 两种都画成下面那句话的话，一个 git 拒绝读的仓库（别的用户的检出、PATH 里没有 git）会被说成没有版本管理，
	 * 底下还挂着「初始化仓库」：两句错话加一个危险的建议。所以说清楚是什么挡住了，交给 Agent 去诊断。
	 */
	if (checkout?.problem) {
		const problem = checkout.problem;
		return (
			<PanelEmpty icon={AlertCircle} title={t("git.brokenRepo")}>
				<span className="git-problem-stack">
					<Text size="detail" tone="muted" mono className="git-problem">
						{problem}
					</Text>
					<Button
						size="sm"
						variant="primary"
						disabled={busy}
						icon={<Sparkles size={13} strokeWidth={2} />}
						onClick={() => draft(t("git.brokenRepoPrompt", { error: problem }))}
					>
						{t("gitPanel.diagnose")}
					</Button>
				</span>
			</PanelEmpty>
		);
	}

	if (!cwd) {
		return (
			<PanelEmpty icon={GitBranch} title={t("git.noRepo")}>
				<span className="git-empty-actions">
					<Button
						size="sm"
						variant="primary"
						disabled={busy}
						icon={<GitBranch size={13} strokeWidth={1.8} />}
						onClick={() => {
							void act(() => git().init(root)).then((ok) => {
								// 重扫而不是假定：新仓库要和别的仓库走同一条路回来，否则面板显示的是它自己编的。
								if (!ok) return;
								setRescan((n) => n + 1);
								void readCheckout(root);
							});
						}}
					>
						{t("gitPanel.initRepo")}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						icon={<Sparkles size={13} strokeWidth={2} className="git-accent" />}
						onClick={() => draft(t("git.noRepoPrompt", { path: root }))}
					>
						{t("gitPanel.letAgent")}
					</Button>
				</span>
			</PanelEmpty>
		);
	}

	return (
		<div className="git-panel">
			{/* 下面说的是哪个检出。只有能选时才有这一行：一个仓库、没有工作树是常态，下面的分支那一行已经说了在哪。 */}
			{(repos.length > 1 || Object.values(trees).some((list) => list.length > 0)) && (
				<RepoPicker repos={repos} trees={trees} selected={cwd} onSelect={setSelected} />
			)}

			{/* 在哪，以及和远端之间的三件事。每颗按钮说什么都来自 `syncPlan`，这里不做判断。 */}
			<div ref={syncRowRef} className="git-sync-row" data-plume-sync={status?.remoteState ?? "none"}>
				<GitBranch size={12.5} strokeWidth={1.8} className="git-shrink-0 git-faint" />
				<Text size="label" tone="muted" className="git-truncate">
					<span className="git-ink">{plan.branch}</span>
					{plan.detail && <span className="git-sync-detail">{plan.detail}</span>}
				</Text>
				<div className="git-spacer" />
				{view === "changes" && (
					<>
						<SyncControl
							icon={<ArrowDownToLine size={12} strokeWidth={1.9} />}
							word={t("common.pull")}
							state={plan.pull}
							running={sync === "pull"}
							// 只有在跑的那一颗还能按，再按一次是取消。
							disabled={plan.pull.disabled || busy || (sync !== null && sync !== "pull")}
							roomForWords={roomForWords}
							onClick={() => void remote("pull", () => git().pull(cwd))}
						/>
						{/*
						 * 提交的入口，也是提交这件事唯一的进度条。
						 *
						 * 它转圈的理由有两个，意思正相反：推送在跑，按一下是取消；提交或生成在跑，按一下是打开弹窗。
						 * `busy` 也要让开：提交走 `act`，它自己会置上 `busy`，照旧禁用的话人刚按下提交，通往它的唯一入口就灰了。
						 */}
						<SyncControl
							icon={<ArrowUpFromLine size={12} strokeWidth={1.9} />}
							word={neverPublished ? t("git.publish") : t("common.push")}
							state={plan.push}
							running={sync === "push" || commitWork.active}
							cancellable={sync === "push"}
							busyLabel={commitWork.generating ? t("commit.generating") : t("commit.committing")}
							disabled={(busy && !commitWork.active) || (sync !== null && sync !== "push")}
							roomForWords={roomForWords}
							onClick={(event) => {
								if (sync === "push") {
									call.current?.cancel();
									return;
								}
								pushPopover.toggle(event);
							}}
						/>
						{pushPopover.open && (
							<CommitPushDialog
								cwd={cwd}
								branch={status?.branch ?? plan.branch}
								stagedCount={status?.staged.length ?? 0}
								unstagedCount={status?.unstaged.length ?? 0}
								addedCount={status?.unstaged.reduce((sum, file) => sum + file.added, 0) ?? 0}
								removedCount={status?.unstaged.reduce((sum, file) => sum + file.removed, 0) ?? 0}
								busy={busy}
								running={sync !== null}
								work={commitWork}
								// 和工具条上那颗推送按钮读同一处，两边不各算各的。
								unpushed={plan.push.count ?? 0}
								publish={neverPublished && !plan.push.disabled}
								pushTip={plan.push.tip}
								onClose={pushPopover.close}
								// 分支换了，这一层的状态和同步计划都要重读，否则弹窗关上后面板还写着旧分支。
								onBranchChanged={() => void read()}
								onCommit={(message) => act(() => git().commitStaged(cwd, message))}
								// 走到这里 `message` 一定不空：留空时的生成发生在弹窗里，那里才画得出「正在生成」。
								onCommitAndPush={async (message, includeUnstaged) => {
									if (includeUnstaged) {
										const current = await git().status(cwd);
										const paths = current.unstaged.map((file) => file.path);
										if (paths.length > 0) await git().stage(cwd, paths);
									}
									if (!(await act(() => git().commitStaged(cwd, message)))) return false;
									void remote("push", () => git().push(cwd));
									return true;
								}}
								onPush={async () => {
									void remote("push", () => git().push(cwd));
								}}
							/>
						)}
					</>
				)}
				{/*
				 * 两件事一起做，而且两件都要：问远端（不获取的话 ahead、behind 说的是很久以前），再重读本地
				 * （实时刷新只在一轮在跑时轮询，别的编辑器里改的东西没人问就看不见）。
				 */}
				<IconButton
					icon={sync === "fetch" ? <ActionSpinner size={12} /> : <RefreshCw size={12} strokeWidth={1.9} />}
					label={sync === "fetch" ? t("git.cancelRefresh") : t("git.refresh")}
					size="sm"
					disabled={busy || (sync !== null && sync !== "fetch")}
					onClick={() => void remote("fetch", () => git().fetch(cwd, false))}
				/>
			</div>

			{/* 一排视图，有意义的地方带个数。 */}
			<div ref={navRef} className="git-views">
				{VIEWS.map((entry) => {
					const count = entry.id === "changes" && changeCount > 0 ? changeCount : null;
					const icon = <entry.icon size={12.5} strokeWidth={1.8} className="git-shrink-0" />;
					// 窄的时候字进悬停提示、数进角标，三个视图照样放得下。
					return narrowNav ? (
						<IconButton
							key={entry.id}
							label={`${t(entry.labelKey)}${count ? ` (${count})` : ""}`}
							ariaLabel={t(entry.labelKey)}
							active={view === entry.id}
							badge={count}
							onClick={() => setView(entry.id)}
							icon={icon}
						/>
					) : (
						<Button
							key={entry.id}
							variant="subtle"
							size="sm"
							ariaLabel={t(entry.labelKey)}
							pressed={view === entry.id}
							onClick={() => setView(entry.id)}
							icon={icon}
						>
							<span className="git-truncate">{t(entry.labelKey)}</span>
							{count && <CountUp value={count} className="git-count" />}
						</Button>
					);
				})}
			</div>

			<RetainedViews
				key={cwd}
				active={view}
				limit={3}
				render={(shown) => (
					<>
						{shown === "changes" && (
							<ChangesView
								sessionId={session?.summary.id}
								key={status?.branch ?? "detached"}
								loading={slowSwitch}
								status={status}
								// 看着的那个仓库，不是打开的文件夹：文件操作要和上面的状态读自同一个检出。
								cwd={cwd}
								busy={busy || sync !== null}
								act={act}
								plan={plan}
							/>
						)}
						{shown === "history" && <HistoryView cwd={cwd} />}
						{shown === "branches" && <BranchesView cwd={cwd} status={status} busy={busy} act={act} repos={repos} trees={trees} onSelectRepo={setSelected} />}
					</>
				)}
			/>
		</div>
	);
}
