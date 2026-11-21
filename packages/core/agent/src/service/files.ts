import { basename, resolve } from "node:path";
import { extractDocumentText } from "@plume/document-text";
import type { AgentService } from "@plume/contract";
import { operateSessionFile } from "../file-operations.ts";
import { listSessionDirectory, locateSessionFiles, readSessionFile, readSessionFileBytes } from "../files.ts";
import { readManagedMedia } from "../media-access.ts";
import { projectRootsFor } from "../project-roots.ts";
import type { Projects } from "../projects.ts";
import type { Events } from "../session/events.ts";
import type { Registry } from "../session/registry.ts";

/** 抽字的文档最大多少字节：再大的文件读进来、解开都要好几秒，进程这段时间什么都做不了。 */
const DOCUMENT_LIMIT = 32 * 1024 * 1024;

export interface FilesServiceDeps {
	dataDir: string;
	mediaDir: string;
	trash: ((path: string) => Promise<void>) | undefined;
	projects: Pick<Projects, "list">;
	events: Pick<Events, "emit">;
	registry: Pick<Registry, "sessions" | "find" | "sessionRoots">;
}

export function filesService(
	deps: FilesServiceDeps,
): Pick<AgentService, "documentText" | "mentionFiles" | "listDirectory" | "fileOperation" | "readFileBytes" | "readFile" | "locateFiles"> {
	const {
		dataDir,
		mediaDir,
		trash,
		projects,
		events: { emit },
		registry: { sessions, find, sessionRoots },
	} = deps;
	return {
		async documentText(name, data) {
			if (typeof name !== "string" || !(data instanceof Uint8Array) || data.byteLength > DOCUMENT_LIMIT) return null;
			return extractDocumentText(name, data);
		},
		async mentionFiles(target, sessionId) {
			const session = sessionId ? find(sessionId).summary : undefined;
			const project = projects.list().find((entry) => entry.id === (session?.project ?? target.project));
			const cwd = session?.cwd ?? project?.path;
			if (!cwd) return [];
			const roots = [...new Set([cwd, ...projectRootsFor(projects.list(), cwd, project?.id)])];
			return (
				await Promise.all(
					roots.map(async (root) =>
						(await listSessionDirectory(cwd, root, roots)).map((entry) => ({
							...entry,
							path: root === cwd ? entry.name : entry.path,
							...(roots.length > 1 ? { origin: basename(root) } : {}),
						})),
					),
				)
			).flat();
		},
		async listDirectory(sessionId, path) {
			const { summary } = find(sessionId);
			return listSessionDirectory(summary.cwd, path, sessionRoots(summary));
		},
		async fileOperation(sessionId, operation) {
			const { summary } = find(sessionId);
			const result = await operateSessionFile(summary.cwd, operation, sessionRoots(summary), trash);
			if (operation.type === "rename" && result.ok && result.path) emit({ type: "fileMoved", from: resolve(summary.cwd, operation.from), to: result.path });
			if ((operation.type === "trash" || operation.type === "remove") && result.paths?.length) emit({ type: "fileRemoved", paths: result.paths });
			return result;
		},
		async readFileBytes(sessionId, path, modifiedAt, call) {
			const session = find(sessionId);
			return readSessionFileBytes(session.summary.cwd, path, modifiedAt, call.signal, sessionRoots(session.summary));
		},
		async readFile(sessionId, path) {
			const session = sessions.get(sessionId);
			if (!session) return null;
			return (await readSessionFile(session.summary.cwd, path, sessionRoots(session.summary))) ?? readManagedMedia(mediaDir, path);
		},
		async locateFiles(sessionId, written) {
			const session = sessions.get(sessionId);
			if (!session) return [];
			const roots = [...new Set([session.summary.cwd, ...projectRootsFor(projects.list(), session.summary.cwd, session.summary.project)])];
			return [...new Set((await Promise.all(roots.map((root) => locateSessionFiles(root, written, dataDir)))).flat())].sort();
		},
	};
}
