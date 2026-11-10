import type { SessionStats, SessionTarget } from "@plume/contract";
import type { SessionMenuActions } from "./SessionMenu.tsx";

/** 侧栏要应用替它做的事。出错由应用提示，这里不等结果。 */
export interface SidebarActions extends SessionMenuActions {
	open(sessionId: string): void;
	newSession(target: SessionTarget): void;
	createProject(name: string, path: string, folders?: string[]): void;
	updateProject(projectId: string, name: string, path: string, folders?: string[]): void;
	stats(sessionId: string): Promise<SessionStats>;
	reorderProjects(sourceId: string, targetId: string, placement: "before" | "after"): Promise<void>;
	reorderSessions(projectId: string, sessionIds: string[]): Promise<void>;
	removeProject(projectId: string): void;
	/** 把项目里还列着的会话都归档。 */
	archiveProject(projectId: string): void;
}
