import type { ConversationCardProps, PanelProps, UiPlugin } from "@plume/contract/ui";
import type { SessionView } from "@plume/contract";
import { PanelEmpty, Text, useI18n } from "@plume/ui";
import { Bot, History, ListTodo } from "@plume/ui/icons";
import type { DiagnosticsApi } from "./api.ts";
import { EnvironmentCard, EnvironmentToggle } from "./Environment.tsx";
import { MESSAGES } from "./messages.ts";
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
		function Environment(props: ConversationCardProps) {
			return <EnvironmentCard {...props} runtime={runtime} />;
		}
		function Toggle({ session }: { session: SessionView }) {
			return <EnvironmentToggle session={session} runtime={runtime} />;
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
		function Child({ session }: PanelProps) {
			const selected = state.useSelection(session?.summary.id ?? "");
			return selected.child ? <ui.Conversation sessionId={selected.child} /> : null;
		}
		function Children({ session, shown }: PanelProps) {
			const words = MESSAGES[useI18n().resolvedLocale];
			const data = state.useSnapshot(session?.summary.id ?? "", Boolean(session) && shown);
			return (
				<div className="plume-diagnostics-child-list">
					{data.children.map((child) => (
						<button
							type="button"
							key={child.id}
							className="plume-diagnostics-row"
							onClick={() => {
								if (session) {
									state.select(session.summary.id, { child: child.id });
									ui.openPanel("child", session.summary.id);
								}
							}}
						>
							<Bot size={14} />
							<Text size="detail" className="plume-diagnostics-grow">
								{child.title}
							</Text>
							<Text size="caption" tone="faint">
								{child.running ? words.active : words.done}
							</Text>
						</button>
					))}
				</div>
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
		ui.panel("child", Child, { title: (locale) => MESSAGES[locale].children, listed: false });
		ui.panel("children", Children, { title: (locale) => MESSAGES[locale].children, listed: false });
		ui.conversationCard("environment", Environment, { order: -20, lane: true });
		ui.sessionToolbar("environment", Toggle);
		ui.sessionMenuItem("trajectory", {
			label: (locale) => MESSAGES[locale].viewTrajectory,
			icon: History,
			run: async (session) => {
				await ui.openSession(session.id);
				runtime.openTrace(session.id);
			},
		});
		ui.deliveryAction("job", runtime.openJob);
	},
} satisfies UiPlugin;
