import type { PanelProps, UiPlugin } from "@plume/contract/ui";
import { PanelEmpty, useI18n } from "@plume/ui";
import { History, ListTodo } from "@plume/ui/icons";
import type { DiagnosticsApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { environmentSections } from "./Sections.tsx";
import { createState, type Runtime } from "./state.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { TracePanel } from "./TracePanel.tsx";
import css from "./diagnostics.css";

export default {
	name: "plume.diagnostics",
	apply(ui) {
		const style = document.createElement("style");
		style.dataset.pluginStyle = ui.name;
		style.textContent = css;
		document.head.append(style);
		ui.effect(() => style.remove());
		const api = ui.remote<DiagnosticsApi>();
		const state = createState(api, ui);
		const runtime: Runtime = {
			ui,
			api,
			state,
			openTrace(id, call) {
				state.select(id, { call });
				ui.openPanel("trajectory", id);
			},
			openJob(id, job) {
				state.select(id, { job });
				ui.openPanel("tasks", id);
			},
			openOutput(id, callId) {
				void api
					.fullOutput(id, callId)
					.then((file) => {
						state.select(id, { file });
						ui.openPanel("output", id);
					})
					.catch((error: unknown) => ui.notify(String(error), "error"));
			},
		};
		function Tasks({ session, shown }: PanelProps) {
			const words = MESSAGES[useI18n().resolvedLocale];
			return session ? (
				<TaskPanel key={session.summary.id} session={session} runtime={runtime} shown={shown} />
			) : (
				<PanelEmpty icon={ListTodo} title={words.tasks}>
					{words.openConversation}
				</PanelEmpty>
			);
		}
		function Trace({ session, shown }: PanelProps) {
			const words = MESSAGES[useI18n().resolvedLocale];
			return session ? (
				<TracePanel key={session.summary.id} session={session} runtime={runtime} shown={shown} />
			) : (
				<PanelEmpty icon={History} title={words.trajectory}>
					{words.openConversation}
				</PanelEmpty>
			);
		}
		function Output({ session }: PanelProps) {
			const selected = state.useSelection(session?.summary.id ?? "");
			const words = MESSAGES[useI18n().resolvedLocale];
			return session && selected.file ? (
				<div className="plume-diagnostics-file">
					<ui.FilePreview sessionId={session.summary.id} {...selected.file} />
				</div>
			) : (
				<PanelEmpty icon={ListTodo} title={words.outputGone} />
			);
		}
		ui.panel("tasks", Tasks, {
			title: (locale) => MESSAGES[locale].tasks,
			description: (locale) => MESSAGES[locale].taskDescription,
			icon: ListTodo,
			shortcut: "CommandOrControl+J",
			restore: true,
			detachable: true,
			available: ({ session }) => session,
			order: -20,
		});
		ui.panel("trajectory", Trace, {
			title: (locale) => MESSAGES[locale].trajectory,
			description: (locale) => MESSAGES[locale].traceDescription,
			icon: History,
			shortcut: "CommandOrControl+L",
			restore: true,
			detachable: true,
			available: ({ session }) => session,
			order: -19,
		});
		ui.panel("output", Output, { title: (locale) => MESSAGES[locale].output, listed: false });
		const sections = environmentSections(runtime);
		ui.environmentSection("jobs", sections.Jobs, { label: (locale) => MESSAGES[locale].jobs, order: 10, attention: sections.useMonitors });
		ui.environmentSection("wakeups", sections.Wakeups, { label: (locale) => MESSAGES[locale].wakeups, order: 50, attention: sections.usePendingWakeups });
		ui.environmentSection("compactions", sections.Compactions, { label: (locale) => MESSAGES[locale].compactions, order: 85 });
		ui.sessionMenuItem("trajectory", {
			label: (locale) => MESSAGES[locale].viewTrajectory,
			icon: History,
			run: async (session) => {
				await ui.openSession(session.id);
				runtime.openTrace(session.id);
			},
		});
		ui.jobViewer(runtime.openJob);
	},
} satisfies UiPlugin;
