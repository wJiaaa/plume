import type { BackgroundJobInfo, SessionView } from "@plume/contract";
import {
	ActionSpinner,
	Caret,
	CodeBlock,
	IconButton,
	InlineSelect,
	PanelEmpty,
	Scroller,
	ScrollText,
	SearchField,
	Text,
	useConfirmer,
	useI18n,
} from "@plume/ui";
import { Check, Circle, CircleAlert, Copy, ExternalLink, FileText, Globe, ListTodo, Pause, Square, X } from "@plume/ui/icons";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { entriesOf, filterEntries, jobCall, latestTodos } from "./entries.ts";
import { RunDetail } from "./Detail.tsx";
import { MESSAGES, STATUS_LABELS } from "./messages.ts";
import type { Runtime } from "./state.tsx";
import { TaskRuns } from "./TaskRuns.tsx";

function Header({ label, hint, alert }: { label: string; hint?: string | number; alert?: string }) {
	return (
		<div className="plume-diagnostics-heading plume-diagnostics-section-head">
			<Text size="caption" tone="faint">
				{label}
			</Text>
			<Text size="caption" tone="faint" numeric>
				{hint}
			</Text>
			{alert && (
				<span className="plume-diagnostics-alert" data-plume-tip={alert} role="img" aria-label={alert}>
					<CircleAlert size={12} />
				</span>
			)}
		</div>
	);
}
function JobOutput({ id, job, runtime, shown }: { id: string; job: BackgroundJobInfo; runtime: Runtime; shown: boolean }) {
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
		<div className="plume-diagnostics-job-output">
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
				<Text as="p" size="caption" tone="faint">
					{words.tail}
				</Text>
			)}
			{!value && !error ? (
				<Text size="caption" tone="faint">
					{words.loading}
				</Text>
			) : value?.text ? (
				<CodeBlock>{value.text}</CodeBlock>
			) : (
				<Text size="caption" tone="faint">
					{words.noOutput}
				</Text>
			)}
		</div>
	);
}

function Jobs({ session, runtime, shown }: { session: SessionView; runtime: Runtime; shown: boolean }) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const id = session.summary.id;
	const data = runtime.state.useSnapshot(id, shown, true);
	const selection = runtime.state.useSelection(id);
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState<string>();
	const root = useRef<HTMLDivElement>(null);
	const confirm = useConfirmer();
	useEffect(() => {
		if (!selection.job || data.loading || data.error) return;
		if (!data.jobs.some((job) => job.id === selection.job)) {
			runtime.ui.notify(words.outputGone);
			runtime.state.select(id, { job: undefined });
			return;
		}
		setOpen((value) => new Set(value).add(selection.job!));
		requestAnimationFrame(() => root.current?.querySelector(`[data-service-id="${CSS.escape(selection.job!)}"]`)?.scrollIntoView({ block: "nearest" }));
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
	const jobs = [...data.jobs].sort((a, b) => Number(a.finishedAt !== undefined) - Number(b.finishedAt !== undefined) || b.startedAt - a.startedAt);
	return (
		<div ref={root} data-session-services>
			{data.error && (
				<Text as="p" size="caption" tone="danger" role="alert">
					{data.error}
				</Text>
			)}
			{jobs.length > 0 && <Header label={words.jobs} hint={jobs.length} alert={data.discoveryError && words.portFailed(data.discoveryError)} />}
			{jobs.map((job) => {
				const expanded = open.has(job.id);
				const ended = job.finishedAt !== undefined;
				const call = jobCall(session.messages, job.id);
				return (
					<div key={job.id} data-service-id={job.id} data-service-ended={ended || undefined} className="plume-diagnostics-job">
						<div className="plume-diagnostics-heading">
							<button
								type="button"
								className="plume-diagnostics-row plume-diagnostics-grow"
								data-plume-tip={job.command}
								aria-expanded={expanded}
								onClick={() =>
									setOpen((value) => {
										const next = new Set(value);
										if (!next.delete(job.id)) next.add(job.id);
										return next;
									})
								}
							>
								<Caret open={expanded} size={11} />
								<span className="plume-diagnostics-dot" data-status={job.status === "failed" ? "error" : ended ? "done" : "running"} />
								<Text size="detail" tone={ended ? "faint" : "muted"} className="plume-diagnostics-grow">
									<ScrollText text={job.description || job.command} />
								</Text>
							</button>
							<Text size="caption" tone={job.status === "failed" ? "danger" : "faint"} numeric data-service-outcome>
								{ended ? (job.exitCode === 0 ? words.done : `${words.exitCode} ${job.exitCode ?? "—"}`) : job.pid}
							</Text>
							{call && <IconButton size="sm" label={words.fullOutput} icon={<FileText size={12} />} onClick={() => runtime.openOutput(id, call.toolCallId)} />}
							{!ended && (
								<div className="plume-diagnostics-actions">
									<IconButton
										size="sm"
										label={words.stop}
										disabled={busy === job.id || job.status === "stopping"}
										icon={<Square size={12} />}
										onClick={() => void stop(job.id, false)}
									/>
									<IconButton
										size="sm"
										label={words.kill}
										disabled={busy === job.id}
										tone="danger"
										icon={<X size={13} />}
										onClick={() =>
											confirm.ask({ title: words.killConfirm, detail: job.command, confirmLabel: words.kill, onConfirm: () => void stop(job.id, true) })
										}
									/>
								</div>
							)}
						</div>
						{job.endpoints.map((endpoint) => {
							const address = `${endpoint.address}:${endpoint.port}`;
							return (
								<div key={`${endpoint.pid}:${address}`} className="plume-diagnostics-heading plume-diagnostics-endpoint" data-service-endpoint={endpoint.port}>
									<Text size="caption" tone="faint" mono className="plume-diagnostics-grow">
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
							<Text as="p" size="caption" tone="danger">
								{job.error}
							</Text>
						)}
						{expanded && <JobOutput id={id} job={job} runtime={runtime} shown={shown} />}
					</div>
				);
			})}
			{confirm.element}
		</div>
	);
}

export function TaskPanel({ session, runtime, shown }: { session: SessionView; runtime: Runtime; shown: boolean }) {
	const { resolvedLocale: locale } = useI18n();
	const words = MESSAGES[locale];
	const data = runtime.state.useSnapshot(session.summary.id, shown, false, true);
	const all = useMemo(() => entriesOf(session, data.observations), [session, data.observations]);
	const runs = useMemo(() => all.filter((entry) => entry.source === "tool-call").reverse(), [all]);
	const todos = useMemo(() => latestTodos(session.messages), [session.messages]);
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState("");
	const search = useDeferredValue(query);
	const matched = useMemo(() => filterEntries(runs, search, status), [runs, search, status]);
	const scrollRef = useRef<HTMLDivElement>(null);
	return (
		<Scroller className="plume-diagnostics-scroll" contentClassName="plume-diagnostics-task-content" scrollRef={scrollRef}>
			<Jobs session={session} runtime={runtime} shown={shown} />
			{!runs.length && !todos.length && !data.jobs.length && (
				<PanelEmpty icon={ListTodo} title={words.tasks}>
					{words.empty}
				</PanelEmpty>
			)}
			{todos.length > 0 && (
				<>
					<Header label={words.plan} hint={`${todos.filter((todo) => todo.status === "completed").length}/${todos.length}`} />
					{todos.map((todo, index) => (
						<div className="plume-diagnostics-todo" key={index}>
							{todo.status === "completed" ? (
								<Check size={13} />
							) : todo.status === "in_progress" ? (
								session.summary.running || data.children.some((child) => child.running) ? (
									<ActionSpinner size={13} />
								) : session.summary.stop?.reason === "aborted" || session.summary.stop?.reason === "interrupted" ? (
									<Pause size={13} />
								) : (
									<span
										className="plume-diagnostics-dot"
										data-status={
											session.summary.stop?.reason === "error" || session.summary.stop?.reason === "stalled" || session.summary.stop?.reason === "max_turns"
												? "error"
												: "running"
										}
									/>
								)
							) : (
								<Circle size={13} />
							)}
							<Text
								size="detail"
								tone={todo.status === "completed" ? "faint" : "muted"}
								className={todo.status === "completed" ? "plume-diagnostics-completed" : "plume-diagnostics-grow"}
							>
								<ScrollText text={todo.content} />
							</Text>
						</div>
					))}
				</>
			)}
			{runs.length > 0 && (
				<>
					<Header label={words.runs} hint={`${matched.length}/${runs.length}`} />
					<div className="plume-diagnostics-controls">
						<SearchField value={query} onChange={setQuery} placeholder={words.search} className="plume-diagnostics-grow" />
						<InlineSelect
							compact
							ariaLabel={words.filter}
							value={status}
							onChange={setStatus}
							options={[
								{ value: "", label: words.all },
								...(["running", "error", "done", "cancelled", "interrupted"] as const).map((value) => ({ value, label: STATUS_LABELS[locale][value] })),
							]}
						/>
					</div>
					{!matched.length && (
						<Text as="p" size="caption" tone="faint">
							{words.noMatch}
						</Text>
					)}
					<TaskRuns
						key={`${session.summary.id}:${search}:${status}`}
						entries={matched}
						scrollRef={scrollRef}
						render={(entry) => <RunDetail entry={entry} runtime={runtime} sessionId={session.summary.id} />}
					/>
				</>
			)}
		</Scroller>
	);
}
