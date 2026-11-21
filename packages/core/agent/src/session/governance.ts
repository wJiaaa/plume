import type { AgentEvent, PluginStatus, SessionSummary, PermissionMode } from "@plume/contract";
import { layerProjectSettings } from "../project-config.ts";
import type { ModelSettings } from "../model-settings.ts";
import type { StoredSettings } from "../models.ts";
import { text } from "../i18n.ts";
import type { Session } from "./session.ts";

type ProjectConfig = Awaited<ReturnType<typeof layerProjectSettings>>;

export interface GovernanceDeps {
	modelSettings: Pick<ModelSettings, "read" | "sessionManager">;
	/** 回边：插件宿主后建，在 `createAgent` 里接上。 */
	hostStatus(): PluginStatus[];
	sessions: Map<string, Session>;
	emit(event: AgentEvent): void;
	summaries(): SessionSummary[];
}

export interface Governance {
	manages(plugin: string): boolean;
	governs(plugin: string, summary: SessionSummary): boolean;
	concerned(session: Session): Set<string>;
	applyProjectConfig(session: Session, configured: ProjectConfig): void;
	readSessionSettings(session: Session): Promise<StoredSettings>;
	refreshProject(session: Session): void;
}

export function createGovernance(deps: GovernanceDeps): Governance {
	const { modelSettings, hostStatus, sessions, emit, summaries } = deps;
	/**
	 * 这个插件此刻能不能当会话的管理者：人把会话交给了它（`setSessionManager`），它装着、在跑、还声明着 `Plugin.manage`。
	 * 停用、卸下、更新后不再声明时就不能，设置里那一项留着，装回来接着生效。
	 */
	function manages(plugin: string): boolean {
		return (
			modelSettings.sessionManager() === plugin &&
			hostStatus().some((status) => status.name === plugin && status.state === "active" && status.manage === "sessions")
		);
	}

	/** 插件能不能像代管一样动这个顶层会话：代管着它，或它没有别的插件代管、而这个插件拿着管理授权。 */
	function governs(plugin: string, summary: SessionSummary): boolean {
		return summary.kind === "top" && (summary.steward === plugin || (summary.steward === undefined && manages(plugin)));
	}

	/**
	 * 和这个会话有关的插件，不声明 `observe: "all"` 也收得到它的观察：建它的（子会话、独立会话的 `owner`），代管它的、代管它父会话的
	 * （代管插件要看得见子智能体、侧边聊天弹的卡才答得了），开出它还在等它闲下来的（`launchedBy`）。
	 */
	function concerned(session: Session): Set<string> {
		const { owner, steward, parentId } = session.summary;
		const parentSteward = parentId ? sessions.get(parentId)?.summary.steward : undefined;
		const top = parentId ? sessions.get(parentId)?.summary : session.summary;
		const managing = modelSettings.sessionManager();
		const manager = managing && top && governs(managing, top) ? managing : undefined;
		return new Set([owner, steward, parentSteward, manager, session.launchedBy].filter((name): name is string => name !== undefined));
	}

	function applyProjectConfig(session: Session, configured: ProjectConfig): void {
		session.projectLayer = configured.layer;
		// 放宽的已经拿掉了（`withoutLoosening`），留下的权限模式就是这个会话实际按的那一档；界面的权限签照它显示。
		const required = configured.layer.permissionMode as PermissionMode | undefined;
		if (required !== session.summary.projectPermission) {
			if (required) session.summary.projectPermission = required;
			else delete session.summary.projectPermission;
			if (sessions.get(session.summary.id) === session) emit({ type: "sessions", sessions: summaries() });
		}
		const notices = JSON.stringify([configured.refused, configured.loosened, configured.error ?? ""]);
		if (notices === session.projectNotices) return;
		session.projectNotices = notices;
		if (configured.refused.length > 0)
			emit({ type: "notice", sessionId: session.summary.id, text: text("project.configRefused", { keys: configured.refused.join(", ") }), level: "warn" });
		// 放宽权限的键不认，说一声：不然人照着仓库的说明以为已经是完全访问、已经批准过，却还在弹卡。
		if (configured.loosened.length > 0)
			emit({ type: "notice", sessionId: session.summary.id, text: text("project.configLoosening", { keys: configured.loosened.join(", ") }), level: "warn" });
		if (configured.error) emit({ type: "notice", sessionId: session.summary.id, text: configured.error, level: "warn" });
	}

	function readSessionSettings(session: Session): Promise<StoredSettings> {
		const cwd = session.summary.cwd;
		const reading: Promise<StoredSettings> = modelSettings.read().then(async (global) => {
			const configured = await layerProjectSettings(global, cwd);
			// 较慢的旧读取等待最新读取，不能把新的项目层盖回去或短暂退回全局权限。
			if (cwd !== session.summary.cwd) return readSessionSettings(session);
			if (session.projectRead !== reading) return session.projectRead!;
			applyProjectConfig(session, configured);
			return configured.settings;
		});
		session.projectRead = reading;
		return reading;
	}

	/**
	 * 一轮之外重读这个会话的项目配置，只为让摘要上的 `projectPermission` 跟上（打开会话、改了本机设置、设置页读了这个目录的配置）。
	 * 不等、不报错：读不到时下一轮照样会读，到时候再说。
	 */
	function refreshProject(session: Session): void {
		void readSessionSettings(session).catch(() => undefined);
	}

	return { manages, governs, concerned, applyProjectConfig, readSessionSettings, refreshProject };
}
