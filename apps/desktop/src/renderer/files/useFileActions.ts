import { useI18n, useConfirmGate } from "@plume/ui";
import { useCallback, useState } from "react";

import type { FileOpResult } from "@plume/contract";
import { notify } from "../toast/store.ts";
import { fileOperation } from "./open-file.ts";

import { baseName, joinPath, parentOf, relativeTo, rootOf } from "./paths.ts";

type ClipMode = "copy" | "cut";

interface FileActionDeps {
	/** 会话的几个源文件夹：复制相对路径时相对装着它的那一个。 */
	roots: readonly string[];
	sessionId: string;
	refresh(dirs: Iterable<string>): Promise<void>;
}

export function useFileActions({ sessionId, roots, refresh }: FileActionDeps) {
	const { t } = useI18n();

	const [clipboard, setClipboard] = useState<{ paths: string[]; mode: ClipMode } | null>(null);

	const gate = useConfirmGate();
	const ask = gate.ask;

	const report = useCallback((result: FileOpResult): boolean => {
		if (!result.ok && result.error) notify(result.error, "error");
		return result.ok;
	}, []);

	const withReplace = useCallback(
		async (target: string, attempt: (overwrite: boolean) => Promise<FileOpResult>): Promise<FileOpResult> => {
			const first = await attempt(false);
			if (first.ok || first.code !== "exists") return first;

			const replace = await ask({
				title: t("fileAction.exists", { name: baseName(target) }),
				detail: t("fileAction.replaceDetail"),
				confirmLabel: t("common.replace"),
			});
			return replace ? attempt(true) : { ok: false };
		},
		[ask, t],
	);

	const create = useCallback(
		async (dir: string, name: string, kind: "file" | "directory"): Promise<string | null> => {
			const result = await fileOperation(sessionId, { type: "create", directory: dir, name, kind });
			if (!report(result)) return null;
			await refresh([dir]);
			return result.path ?? null;
		},
		[sessionId, refresh, report],
	);

	const rename = useCallback(
		async (path: string, name: string): Promise<string | null> => {
			const dir = parentOf(path);
			const to = joinPath(dir, name);
			if (to === path) return path;

			const result = await withReplace(to, (overwrite) => fileOperation(sessionId, { type: "rename", from: path, to, overwrite }));
			if (!report(result)) return null;
			await refresh([dir]);
			return result.path ?? to;
		},
		[sessionId, refresh, report, withReplace],
	);

	const duplicate = useCallback(
		async (path: string): Promise<string | null> => {
			const dir = parentOf(path);
			const free = await fileOperation(sessionId, { type: "unique", directory: dir, name: baseName(path) });
			if (!report(free) || !free.path) return null;

			const result = await fileOperation(sessionId, { type: "copy", from: path, to: free.path });
			if (!report(result)) return null;
			await refresh([dir]);
			return result.path ?? free.path;
		},
		[sessionId, refresh, report],
	);

	const transfer = useCallback(
		async (paths: string[], dir: string, mode: ClipMode | "copy-into"): Promise<void> => {
			const copying = mode !== "cut";
			const touched = new Set<string>([dir]);

			for (const path of paths) {
				const from = parentOf(path);
				touched.add(from);
				if (!copying && from === dir) continue;

				let to = joinPath(dir, baseName(path));
				if (copying && from === dir) {
					const free = await fileOperation(sessionId, { type: "unique", directory: dir, name: baseName(path) });
					if (!report(free) || !free.path) continue;
					to = free.path;
				}

				const result = await withReplace(to, (overwrite) =>
					copying
						? fileOperation(sessionId, { type: "copy", from: path, to, overwrite })
						: fileOperation(sessionId, { type: "rename", from: path, to, overwrite }),
				);
				if (!report(result)) continue;
			}
			await refresh(touched);
		},
		[sessionId, refresh, report, withReplace],
	);

	const paste = useCallback(
		async (dir: string): Promise<void> => {
			if (!clipboard) return;
			await transfer(clipboard.paths, dir, clipboard.mode);
			if (clipboard.mode === "cut") setClipboard(null);
		},
		[clipboard, transfer],
	);

	const remove = useCallback(
		async (paths: string[], permanent: boolean): Promise<boolean> => {
			if (paths.length === 0) return false;
			const what = paths.length === 1 ? t("fileAction.one", { name: baseName(paths[0]!) }) : t("fileMenu.theseN", { n: paths.length });
			const platform = window.plume.platform;
			const agreed = await ask({
				title: t(permanent ? "fileAction.deleteForeverConfirm" : "fileAction.deleteConfirm", { what }),
				detail: t(
					permanent
						? "fileAction.noUndo"
						: platform === "darwin"
							? "fileAction.toTrash"
							: platform === "win32"
								? "fileAction.toTrashWin"
								: "fileAction.toTrashLinux",
				),
				confirmLabel: t(
					permanent
						? "fileAction.deleteForever"
						: platform === "darwin"
							? "fileAction.moveToTrash"
							: platform === "win32"
								? "fileAction.moveToTrashWin"
								: "fileAction.moveToTrashLinux",
				),
			});
			if (!agreed) return false;

			const result = permanent ? await fileOperation(sessionId, { type: "remove", paths }) : await fileOperation(sessionId, { type: "trash", paths });
			await refresh(paths.map(parentOf));
			return report(result);
		},
		[sessionId, ask, refresh, report, t],
	);

	const importInto = useCallback(
		async (sources: string[], dir: string): Promise<void> => {
			if (sources.length === 0) return;
			const result = await fileOperation(sessionId, { type: "import", sources, directory: dir });
			await refresh([dir]);
			report(result);
		},
		[sessionId, refresh, report],
	);

	const copyPath = useCallback(
		async (paths: string[], relative: boolean): Promise<void> => {
			const text = paths
				.map((path) => {
					const root = relative ? rootOf(roots, path) : undefined;
					return root ? relativeTo(root, path) : path;
				})
				.join("\n");
			await window.plume.files.copyText(text);
			notify(t(relative ? "fileAction.relativePathCopied" : "fileAction.pathCopied"));
		},
		[roots, t],
	);

	return {
		clipboard,
		copy: useCallback((paths: string[]) => setClipboard({ paths, mode: "copy" as const }), []),
		cut: useCallback((paths: string[]) => setClipboard({ paths, mode: "cut" as const }), []),
		paste,
		create,
		rename,
		duplicate,
		transfer,
		remove,
		importInto,
		copyPath,

		prompt: gate.element,
	};
}
