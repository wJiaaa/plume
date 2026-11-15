import type { BackgroundJobInfo, SessionView } from "@plume/contract";
import type { SubagentTaskSummary } from "@plume/contract/ui";
import { Caret, IconButton, PanelEmpty, Scroller, ScrollText, Text, useConfirmer, useI18n, useNow } from "@plume/ui";
import { ChevronRight, CircleAlert, Copy, ExternalLink, Globe, ListTodo, Square, X } from "@plume/ui/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DiagnosticJob } from "./api.ts";
import { jobCall } from "./entries.ts";
import { MESSAGES, STATUS_LABELS } from "./messages.ts";
import type { Runtime } from "./state.tsx";

/** 卡片里只放尾部输出；截过的在提示后面给「查看完整输出」，没截过的整段都在这里，不再给入口。 */
function JobOutput({
	id,
	job,
	runtime,
	shown,
	onFullOutput,
}: {
	id: string;
	job: BackgroundJobInfo;
	runtime: Runtime;
	shown: boolean;
	onFullOutput?: () => void;
}) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const [value, setValue] = useState<Awaited<ReturnType<Runtime["api"]["output"]>>>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!shown) return;
		let live = true;
		let done = false;
		let timer: ReturnType<typeof setTimeout>;
		const read = async () => {
			try {
				if (!document.hidden) {
					const next = await runtime.api.output(id, job.id);
					done = next.done;
					if (live) {
						setValue(next);
						setError(undefined);
					}
				}
			} catch (cause) {
				if (live) setError(String(cause));
			} finally {
				if (live && !done) timer = setTimeout(() => void read(), 1000);
			}
		};
		void read();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [id, job.id, job.finishedAt, shown, runtime]);
	return (
		<div className="plume-diagnostics-job-output" data-job-output>
			{error && (
				<Text as="p" size="caption" tone="danger" role="alert">
					{error}
				</Text>
			)}
			{value?.error && (
				<Text as="p" size="caption" tone="danger">
					{value.error}
				</Text>
			)}
			{value?.truncated && (
				<Text as="p" size="caption" tone="faint" className="plume-diagnostics-job-tail">
					{words.tail}
					{onFullOutput && (
						<button type="button" className="plume-diagnostics-link" onClick={onFullOutput}>
							{words.fullOutput}
						</button>
					)}
				</Text>
			)}
			{!value && !error ? (
				<Text size="caption" tone="faint">
					{words.loading}
				</Text>
			) : value?.text ? (
				<Text as="div" size="caption" tone="muted" mono className="plume-diagnostics-job-text">
					{value.text}
				</Text>
			) : (
				<Text size="caption" tone="faint">
					{words.noOutput}
				</Text>
			)}
		</div>
	);
}

/** 跑了多久，按整秒走：还在跑的每秒走一下。 */
function Elapsed({ from }: { from: number }) {
	const now = useNow(true, 1000);
	const seconds = Math.max(0, Math.floor((now - from) / 1000));
	const text =
		seconds < 60
			? `${seconds}s`
			: seconds < 3600
				? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
				: `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
	return (
		<Text size="detail" tone="faint" numeric>
			{text}
		</Text>
	);
}

/** 卡片右边那个停止键：一枚实心方块；已经叫停还没停下的换成「强制结束」。 */
function StopButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick(): void }) {
	return (
		<IconButton
			size="sm"
			label={label}
			disabled={disabled}
			className="plume-diagnostics-stop"
			icon={<Square size={9} fill="currentColor" strokeWidth={0} />}
			onClick={onClick}
		/>
	);
}

/** 结束了的命令右边那个词：正常退出是完成，被信号停下（没有退出码）是已停止，别的写退出码。 */
function jobOutcome(job: BackgroundJobInfo, words: (typeof MESSAGES)["zh-CN"], failed: string): string {
	if (job.exitCode === 0) return words.done;
	if (job.exitCode !== null) return `${words.exitCode} ${job.exitCode}`;
	return job.error ? failed : words.jobStopped;
}

/** 一项后台任务一张卡：标题是命令的说明，右边是结果或停止按钮；展开后先是命令，再是输出。 */
function JobCard({
	id,
	job,
	session,
	runtime,
	shown,
	expanded,
	busy,
	onToggle,
	onStop,
	onKill,
}: {
	id: string;
	job: DiagnosticJob;
	session: SessionView;
	runtime: Runtime;
	shown: boolean;
	expanded: boolean;
	busy: boolean;
	onToggle(): void;
	onStop(): void;
	onKill(): void;
}) {
	const { resolvedLocale: locale } = useI18n();
	const words = MESSAGES[locale];
	const failed = STATUS_LABELS[locale].error;
	const ended = job.finishedAt !== undefined;
	const call = jobCall(session.messages, job.id);
	return (
		<div data-service-id={job.id} data-service-ended={ended || undefined} className="plume-diagnostics-job">
			<div className="plume-diagnostics-job-head">
				<button type="button" className="plume-diagnostics-job-toggle" data-plume-tip={job.command} aria-expanded={expanded} onClick={onToggle}>
					<Caret open={expanded} from="right" size={12} />
					<Text size="detail" tone={ended ? "muted" : "default"} className="plume-diagnostics-grow">
						<ScrollText text={job.description || job.command} />
					</Text>
				</button>
				{ended ? (
					<Text size="detail" tone={job.status === "failed" ? "danger" : "faint"} numeric data-service-outcome>
						{jobOutcome(job, words, failed)}
					</Text>
				) : (
					<>
						<Elapsed from={job.startedAt} />
						{job.status === "stopping" ? (
							<IconButton size="sm" label={words.kill} disabled={busy} tone="danger" icon={<X size={13} />} onClick={onKill} />
						) : (
							<StopButton label={words.stop} disabled={busy} onClick={onStop} />
						)}
					</>
				)}
			</div>
			{job.endpoints.map((endpoint) => {
				const address = `${endpoint.address}:${endpoint.port}`;
				return (
					<div key={`${endpoint.pid}:${address}`} className="plume-diagnostics-heading plume-diagnostics-endpoint" data-service-endpoint={endpoint.port}>
						<Text size="caption" tone="muted" mono className="plume-diagnostics-grow">
							<ScrollText text={address} />
						</Text>
						{endpoint.url && (
							<>
								<IconButton
									size="sm"
									label={words.openBuiltin}
									icon={<Globe size={12} />}
									onClick={() => void runtime.ui.openLink(endpoint.url!, id).catch((error: unknown) => runtime.ui.notify(String(error), "error"))}
								/>
								<IconButton
									size="sm"
									label={words.openSystem}
									icon={<ExternalLink size={12} />}
									onClick={() => void runtime.ui.openExternal(endpoint.url!).catch((error: unknown) => runtime.ui.notify(String(error), "error"))}
								/>
							</>
						)}
						<IconButton
							size="sm"
							label={words.copyUrl}
							icon={<Copy size={12} />}
							onClick={() =>
								void navigator.clipboard.writeText(endpoint.url ?? address).then(
									() => runtime.ui.notify(words.copied),
									(error: unknown) => runtime.ui.notify(String(error), "error"),
								)
							}
						/>
					</div>
				);
			})}
			{job.error && (
				<Text as="p" size="caption" tone="danger" className="plume-diagnostics-job-error">
					{job.error}
				</Text>
			)}
			{expanded && (
				<div className="plume-diagnostics-job-body">
					<Text as="div" size="caption" tone="faint" mono className="plume-diagnostics-break plume-diagnostics-job-command">
						$ {job.command}
					</Text>
					<JobOutput id={id} job={job} runtime={runtime} shown={shown} onFullOutput={call ? () => runtime.openOutput(id, call.toolCallId) : undefined} />
				</div>
			)}
		</div>
	);
}

/** 一个子 Agent 一张卡：整行点了打开它自己的视图，右边是跑了多久和停止键，结束了的写结果。 */
function SubagentCard({ task, busy, onOpen, onStop }: { task: SubagentTaskSummary; busy: boolean; onOpen(): void; onStop(): void }) {
	const { resolvedLocale: locale } = useI18n();
	const words = MESSAGES[locale];
	const active = task.state === "queued" || task.state === "running";
	return (
		<div data-subagent-task={task.id} className="plume-diagnostics-job">
			<div className="plume-diagnostics-job-head">
				<button type="button" className="plume-diagnostics-task-open" onClick={onOpen}>
					<Text size="detail" tone={active ? "default" : "muted"} className="plume-diagnostics-shrink">
						<ScrollText text={task.title || words.subagent} />
					</Text>
					<ChevronRight size={13} />
				</button>
				{task.state === "queued" ? (
					<Text size="detail" tone="faint">
						{words.queued}
					</Text>
				) : active ? (
					task.startedAt !== undefined && <Elapsed from={task.startedAt} />
				) : (
					<Text size="detail" tone={task.state === "failed" ? "danger" : "faint"}>
						{task.state === "done" ? words.done : task.state === "failed" ? STATUS_LABELS[locale].error : words.jobStopped}
					</Text>
				)}
				{active && <StopButton label={words.stop} disabled={busy} onClick={onStop} />}
			</div>
		</div>
	);
}

/** 一组：标题带数量；给了 `onToggle` 的能收起（已结束的那组），在跑的那组一直摊开。 */
function JobGroup({
	kind,
	label,
	count,
	alert,
	open,
	onToggle,
	children,
}: {
	kind: string;
	label: string;
	count: number;
	alert?: string;
	open: boolean;
	onToggle?: () => void;
	children: ReactNode;
}) {
	const title = (
		<>
			<Text size="detail" tone="muted">
				{label}
			</Text>
			<Text size="detail" tone="faint" numeric>
				{count}
			</Text>
		</>
	);
	return (
		<section className="plume-diagnostics-job-group" data-job-group={kind}>
			<div className="plume-diagnostics-heading">
				{onToggle ? (
					<button type="button" className="plume-diagnostics-group-head" aria-expanded={open} onClick={onToggle}>
						<Caret open={open} from="right" size={12} />
						{title}
					</button>
				) : (
					<div className="plume-diagnostics-group-head">{title}</div>
				)}
				{alert && (
					<span className="plume-diagnostics-alert" data-plume-tip={alert} role="img" aria-label={alert}>
						<CircleAlert size={12} />
					</span>
				)}
			</div>
			{open && children}
		</section>
	);
}

function toggled(set: Set<string>, key: string): Set<string> {
	const next = new Set(set);
	if (!next.delete(key)) next.add(key);
	return next;
}

function Jobs({ session, runtime, shown }: { session: SessionView; runtime: Runtime; shown: boolean }) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const id = session.summary.id;
	const data = runtime.state.useSnapshot(id, shown, true);
	const selection = runtime.state.useSelection(id);
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [endedOpen, setEndedOpen] = useState(true);
	const [busy, setBusy] = useState<string>();
	const root = useRef<HTMLDivElement>(null);
	const confirm = useConfirmer();
	// 子 Agent 由管它的插件经服务给出：没有这项服务时只列后台命令。
	const subagents = runtime.ui.useService("subagents.tasks");
	const [tasks, setTasks] = useState<SubagentTaskSummary[]>([]);
	useEffect(() => {
		if (!subagents || !shown) return;
		const stop = subagents.watch(id, setTasks);
		return () => {
			stop();
			setTasks([]);
		};
	}, [subagents, id, shown]);
	useEffect(() => {
		if (!selection.job || data.loading || data.error) return;
		const job = data.jobs.find((job) => job.id === selection.job);
		if (!job) {
			runtime.ui.notify(words.outputGone);
			runtime.state.select(id, { job: undefined });
			return;
		}
		setOpen((value) => new Set(value).add(job.id));
		if (job.finishedAt !== undefined) setEndedOpen(true);
		requestAnimationFrame(() => root.current?.querySelector(`[data-service-id="${CSS.escape(job.id)}"]`)?.scrollIntoView({ block: "nearest" }));
		runtime.state.select(id, { job: undefined });
	}, [selection.job, data.loading, data.error, data.jobs, id, runtime, words.outputGone]);
	const stop = async (jobId: string, force: boolean) => {
		setBusy(jobId);
		try {
			await runtime.api.stop(id, jobId, force);
			await runtime.state.refresh(id);
		} catch (error) {
			runtime.ui.notify(String(error), "error");
		} finally {
			setBusy(undefined);
		}
	};
	const stopTask = async (taskId: string) => {
		if (!subagents) return;
		setBusy(taskId);
		try {
			await subagents.stop(taskId);
		} catch (error) {
			runtime.ui.notify(String(error), "error");
		} finally {
			setBusy(undefined);
		}
	};
	type Item = { kind: "job"; job: DiagnosticJob; at: number } | { kind: "subagent"; task: SubagentTaskSummary; at: number };
	const items: Item[] = [
		...data.jobs.map((job) => ({ kind: "job" as const, job, at: job.startedAt })),
		// 还在排队的没有开始时间：排在最前，它是刚派出去的。
		...tasks.map((task) => ({ kind: "subagent" as const, task, at: task.startedAt ?? Number.MAX_SAFE_INTEGER })),
	].sort((a, b) => b.at - a.at);
	const running = (item: Item) => (item.kind === "job" ? item.job.finishedAt === undefined : item.task.state === "queued" || item.task.state === "running");
	const groups = [
		{ kind: "running", label: words.jobRunning, items: items.filter(running) },
		{ kind: "ended", label: words.jobEnded, items: items.filter((item) => !running(item)) },
	];
	return (
		<div ref={root} data-session-services>
			{data.error && (
				<Text as="p" size="caption" tone="danger" role="alert">
					{data.error}
				</Text>
			)}
			{!items.length && !data.error && (
				<PanelEmpty icon={ListTodo} title={words.tasks}>
					{words.taskEmpty}
				</PanelEmpty>
			)}
			{groups.map(
				(group) =>
					group.items.length > 0 && (
						<JobGroup
							key={group.kind}
							kind={group.kind}
							label={group.label}
							count={group.items.length}
							alert={group.kind === "running" && data.discoveryError ? words.portFailed(data.discoveryError) : undefined}
							open={group.kind === "running" || endedOpen}
							onToggle={group.kind === "running" ? undefined : () => setEndedOpen((value) => !value)}
						>
							{group.items.map((item) =>
								item.kind === "subagent" ? (
									<SubagentCard
										key={item.task.id}
										task={item.task}
										busy={busy === item.task.id}
										onOpen={() => subagents?.open(id, item.task.id)}
										onStop={() => void stopTask(item.task.id)}
									/>
								) : (
									<JobCard
										key={item.job.id}
										id={id}
										job={item.job}
										session={session}
										runtime={runtime}
										shown={shown}
										expanded={open.has(item.job.id)}
										busy={busy === item.job.id}
										onToggle={() => setOpen((value) => toggled(value, item.job.id))}
										onStop={() => void stop(item.job.id, false)}
										onKill={() =>
											confirm.ask({
												title: words.killConfirm,
												detail: item.job.command,
												confirmLabel: words.kill,
												onConfirm: () => void stop(item.job.id, true),
											})
										}
									/>
								),
							)}
						</JobGroup>
					),
			)}
			{confirm.element}
		</div>
	);
}

export function TaskPanel({ session, runtime, shown }: { session: SessionView; runtime: Runtime; shown: boolean }) {
	return (
		<Scroller className="plume-diagnostics-scroll" contentClassName="plume-diagnostics-task-content">
			<Jobs session={session} runtime={runtime} shown={shown} />
		</Scroller>
	);
}
