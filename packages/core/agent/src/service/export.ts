import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentService, Log, ToolDefinition } from "@plume/contract";
import { errorText, marks } from "@plume/loop";
import { writeFileAtomic } from "../atomic-write.ts";
import { conversationMarkdown } from "../conversation-markdown.ts";
import type { PluginHost } from "../host.ts";
import { activeLocale, text } from "../i18n.ts";
import type { ModelSettings } from "../model-settings.ts";
import { protectSource, type SessionDb } from "../session-db.ts";
import type { Registry } from "../session/registry.ts";

export interface ExportServiceDeps {
	dataDir: string;
	log: Log;
	modelSettings: Pick<ModelSettings, "read">;
	store: Pick<SessionDb, "exportTo" | "exportSession" | "messages">;
	host: Pick<PluginHost, "tool">;
	registry: Pick<Registry, "find" | "readRecord">;
}

export function exportService(deps: ExportServiceDeps): Pick<AgentService, "exportSessions" | "exportSession"> {
	const {
		dataDir,
		log,
		modelSettings,
		store,
		host,
		registry: { find, readRecord },
	} = deps;
	return {
		async exportSessions(file) {
			if (!isAbsolute(file)) throw new Error(text("storage.exportPath"));
			await mkdir(dirname(file), { recursive: true });
			store.exportTo(file);
		},
		async exportSession(sessionId, file, format) {
			const session = find(sessionId);
			if (!isAbsolute(file)) throw new Error(text("storage.exportPath"));
			await mkdir(dirname(file), { recursive: true });
			if (format === "database") {
				store.exportSession(sessionId, file);
				return;
			}
			if (format !== "markdown") throw new Error(text("storage.exportFormat"));
			// 和原始记录共用保护：Markdown 也不能经目录别名或大小写差异盖掉源库。
			protectSource(join(dataDir, "sessions", "sessions.db"), file);
			const settings = await modelSettings.read();
			/** 导出时问注册这个工具的插件要它的说法；插件的函数出错时当没给，照本体的写法导出。 */
			const askTool = <T>(name: string, what: string, read: (definition: ToolDefinition) => T): T | undefined => {
				const definition = host.tool(name)?.definition;
				if (!definition) return undefined;
				try {
					return read(definition);
				} catch (error) {
					log("agent", "warn", `工具 ${name} 的 ${what} 出错，导出时照没给处理：${errorText(error)}`);
					return undefined;
				}
			};
			const markdown = conversationMarkdown(
				{
					summary: session.summary,
					messages: store.messages(sessionId),
					compactions: marks(readRecord(session)),
					exportedAt: new Date(),
					modelLabel: (providerId, modelId) => {
						const provider = settings.providers.find((entry) => entry.id === providerId);
						return `${provider?.name ?? providerId}/${provider?.models.find((entry) => entry.modelId === modelId)?.name ?? modelId}`;
					},
					describeTool: (name, args) => {
						const said = askTool(name, "describe", (definition) => definition.describe?.(args));
						return typeof said === "string" ? said : undefined;
					},
					forwardTool: (name, args) => {
						const target = askTool(name, "forwards", (definition) => definition.forwards?.(args));
						return target && typeof target.name === "string" && target.args && typeof target.args === "object" ? target : undefined;
					},
					quoteResult: (result) => {
						const quoted = askTool(result.toolName, "exportResult", (definition) => definition.exportResult?.(result));
						return typeof quoted === "string" ? quoted : undefined;
					},
				},
				activeLocale(),
			);
			await writeFileAtomic(file, markdown);
		},
	};
}
