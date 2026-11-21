import type { AgentEvent, AgentService, CommandContext } from "@plume/contract";
import type { PluginHost } from "../host.ts";
import { setLocale } from "../i18n.ts";
import type { JsonFiles } from "../json-files.ts";
import type { Events } from "../session/events.ts";

/** 界面传来的命令环境只留认得的两项，插件拿到的是干净的对象。 */
function commandContext(input: CommandContext | undefined): CommandContext {
	return {
		...(typeof input?.cwd === "string" && input.cwd ? { cwd: input.cwd } : {}),
		...(typeof input?.sessionId === "string" && input.sessionId ? { sessionId: input.sessionId } : {}),
	};
}

export interface PluginsServiceDeps {
	pluginsFile: string;
	files: Pick<JsonFiles, "write">;
	host: Pick<PluginHost, "commands" | "expandCommand" | "status" | "toolOwners" | "setEnabled" | "call" | "values">;
	events: Pick<Events, "watchers" | "pluginsChanged">;
}

export function pluginsService(
	deps: PluginsServiceDeps,
): Pick<
	AgentService,
	| "listCommands"
	| "expandCommand"
	| "listPlugins"
	| "listTools"
	| "setPluginEnabled"
	| "callPlugin"
	| "watchPluginValue"
	| "setPluginSettings"
	| "setLocale"
	| "watch"
> {
	const {
		pluginsFile,
		files,
		host,
		events: { watchers, pluginsChanged },
	} = deps;
	return {
		listCommands: (context) => host.commands(commandContext(context)),
		expandCommand: (plugin, name, rest, context) =>
			host.expandCommand(String(plugin), String(name), typeof rest === "string" ? rest : "", commandContext(context)),
		listPlugins: () => host.status(),
		listTools: () => host.toolOwners(),
		async setPluginEnabled(key, enabled) {
			const disabled = await host.setEnabled(String(key), enabled === true);
			await files.write(pluginsFile, { disabled });
			return pluginsChanged();
		},
		async callPlugin(plugin, method, args, call) {
			return host.call(plugin, method, args, call);
		},
		watchPluginValue(plugin, kind, key, sessionId, call) {
			return host.values.watch(plugin, kind, key, sessionId, call.signal);
		},
		async setPluginSettings(plugin, patch) {
			return host.values.setSettings(plugin, patch);
		},
		setLocale(locale) {
			setLocale(locale);
		},
		async *watch(call) {
			const queue: AgentEvent[] = [];
			let wake: (() => void) | undefined;
			const push = (event: AgentEvent) => {
				queue.push(event);
				wake?.();
			};
			const stopWaiting = () => wake?.();
			watchers.add(push);
			call.signal.addEventListener("abort", stopWaiting);
			try {
				while (!call.signal.aborted) {
					if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
					wake = undefined;
					while (queue.length > 0) yield queue.shift() as AgentEvent;
				}
			} finally {
				watchers.delete(push);
				call.signal.removeEventListener("abort", stopWaiting);
			}
		},
	};
}
