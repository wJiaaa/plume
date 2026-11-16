/**
 * 项目登记（`projects.json`）：项目的主目录、源文件夹和手动排的会话顺序，以及设置项目的那一组 AgentService 方法。
 * 改了就推一条 `projects` 事件；按项目排会话（`reorderProjectSessions`）要看会话，在 agent.ts。
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AgentService, ProjectEntry } from "@plume/contract";
import { text } from "./i18n.ts";
import type { JsonFiles } from "./json-files.ts";

export interface Projects {
	list(): ProjectEntry[];
	/** 登记着的这个项目；没有就抛错。 */
	find(projectId: string): ProjectEntry;
	/** 换成 `next`：先告诉界面，再写盘。 */
	save(next: ProjectEntry[]): Promise<void>;
	service: Pick<AgentService, "listProjects" | "createProject" | "updateProject" | "removeProject" | "reorderProjects">;
}

export async function openProjects(files: JsonFiles, file: string, changed: (projects: ProjectEntry[]) => void): Promise<Projects> {
	let projects = (await files.read<ProjectEntry[]>(file)) ?? [];

	async function save(next: ProjectEntry[]): Promise<void> {
		projects = next;
		changed(projects);
		await files.write(file, projects);
	}

	function find(projectId: string): ProjectEntry {
		const project = projects.find((entry) => entry.id === projectId);
		if (!project) throw new Error(text("project.notFound", { id: projectId }));
		return project;
	}

	return {
		list: () => projects,
		find,
		save,
		service: {
			listProjects: () => projects,
			async createProject(name, path, folders) {
				if (!path.trim()) throw new Error(text("project.emptyPath"));
				const project: ProjectEntry = {
					id: randomUUID(),
					name: name.trim() || basename(path.trim()),
					path: path.trim(),
					...(folders ? { folders: [...new Set([path.trim(), ...folders.map((folder) => folder.trim()).filter(Boolean)])] } : {}),
				};
				await save([project, ...projects]);
				return project;
			},
			async updateProject(projectId, name, path, folders) {
				find(projectId);
				if (!path.trim()) throw new Error(text("project.emptyPath"));
				await save(
					projects.map((entry) =>
						entry.id === projectId
							? {
									...entry,
									name: name.trim() || basename(path.trim()),
									path: path.trim(),
									...(folders ? { folders: [...new Set([path.trim(), ...folders.map((folder) => folder.trim()).filter(Boolean)])] } : {}),
								}
							: entry,
					),
				);
			},
			async removeProject(projectId) {
				find(projectId);
				await save(projects.filter((entry) => entry.id !== projectId));
			},
			async reorderProjects(sourceId, targetId, placement) {
				const source = find(sourceId);
				find(targetId);
				if (sourceId === targetId) return;
				if (placement !== "before" && placement !== "after") throw new Error("Invalid placement");
				const next = projects.filter((entry) => entry.id !== sourceId);
				next.splice(next.findIndex((entry) => entry.id === targetId) + (placement === "after" ? 1 : 0), 0, source);
				await save(next);
			},
		},
	};
}
