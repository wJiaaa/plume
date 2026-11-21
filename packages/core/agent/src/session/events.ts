import type { AgentEvent, PluginStatus, RegisteredToolInfo, SessionObservation } from "@plume/contract";
import type { Session } from "./session.ts";

export interface EventsDeps {
	/** 回边：会话库模块后建，在 `createAgent` 里接上。 */
	sessions: Pick<Map<string, Session>, "get">;
	/** 回边：插件宿主后建，在 `createAgent` 里接上。 */
	host: {
		observe(observation: SessionObservation, concerned: ReadonlySet<string>): void;
		status(): PluginStatus[];
		toolOwners(): RegisteredToolInfo[];
	};
	/** 回边：治理模块后建，在 `createAgent` 里接上。 */
	concerned(session: Session): Set<string>;
}

export interface Events {
	watchers: Set<(event: AgentEvent) => void>;
	emit(event: AgentEvent): void;
	observe(sessionId: string, event: SessionObservation["event"], timestamp?: number): void;
	modelsChanged(): void;
	pluginsChanged(): PluginStatus[];
	toolsChanged(): void;
}

export function createEvents(deps: EventsDeps): Events {
	const { sessions, host, concerned } = deps;
	const watchers = new Set<(event: AgentEvent) => void>();
	const emit = (event: AgentEvent) => {
		for (const watcher of watchers) watcher(event);
		if (event.type === "toolStart" || event.type === "approval" || event.type === "hiccups" || event.type === "notice" || event.type === "rewound") {
			observe(event.sessionId, event);
		}
	};
	/** 删除后晚回来的请求不能重新创建诊断记录。 */
	function observe(sessionId: string, event: SessionObservation["event"], timestamp = Date.now()): void {
		const session = sessions.get(sessionId);
		if (session) host.observe({ sessionId, at: session.messages?.length ?? 0, timestamp, event }, concerned(session));
	}

	/** 模型设置在界面以外变了，已经排着告诉界面了：一个插件加载时登记来源、设默认模型接连发生，攒到这一刻结束只说一次。 */
	let modelsPending = false;
	const modelsChanged = () => {
		if (modelsPending) return;
		modelsPending = true;
		queueMicrotask(() => {
			modelsPending = false;
			emit({ type: "models" });
		});
	};

	const pluginsChanged = () => {
		const plugins = host.status();
		emit({ type: "plugins", plugins });
		return plugins;
	};

	/** 工具表的变化已经排着告诉界面了，见 `toolsChanged`。 */
	let toolsPending = false;
	const toolsChanged = () => {
		// 一个插件加载时一件件登记，攒到这一刻结束再告诉界面一次。
		if (toolsPending) return;
		toolsPending = true;
		queueMicrotask(() => {
			toolsPending = false;
			emit({ type: "tools", tools: host.toolOwners() });
		});
	};

	return { watchers, emit, observe, modelsChanged, pluginsChanged, toolsChanged };
}
