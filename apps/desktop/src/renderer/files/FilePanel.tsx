/**
 * 文件面板：只读地看一个文件，回复里的文件签点过来就停在那几行。
 *
 * 一个标签看一个文件，看哪个由 `open-file.ts` 按标签记；这里只画四种样子：还没选文件、第一次读还没到、读不到、在看。
 */

import type { PanelProps } from "@plume/contract/ui";
import type { ProjectEntry } from "@plume/contract";
import { PanelEmpty, translate } from "@plume/ui";
import { FileText } from "@plume/ui/icons";
import { useEffect } from "react";

import { FileHeader } from "./FileHeader.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { dropFile, useOpenFile } from "./open-file.ts";

export function FilePanel({ tab, setTitle, onClose, cwd, session, projects }: PanelProps & { projects?: readonly ProjectEntry[] }) {
	const path = useOpenFile(tab, (file) => file.path);
	const sessionId = useOpenFile(tab, (file) => file.sessionId);
	const name = useOpenFile(tab, (file) => file.name);
	const contents = useOpenFile(tab, (file) => file.contents);
	const loading = useOpenFile(tab, (file) => file.loading);
	const opening = useOpenFile(tab, (file) => file.opening);
	const reveal = useOpenFile(tab, (file) => file.reveal);

	// 标签关了，它看着的文件一起放下；组件只是被卸掉（换会话、去设置页）时不放，回来还在。
	useEffect(
		() =>
			onClose(() => {
				dropFile(tab);
				return true;
			}),
		[tab, onClose],
	);

	useEffect(() => setTitle(name ?? undefined), [name, setTitle]);

	if (!path && !opening) {
		return (
			<PanelEmpty icon={FileText} title={translate("dock.fileContents")}>
				{translate("filePanel.pickOne")}
			</PanelEmpty>
		);
	}
	// 换文件时旧的留在屏幕上，新的读到了一起换（见 `OpenFile.opening`），只有第一次读才说「读取中」。
	if (loading && !contents) return <p className="p-6 text-center text-detail text-ink-faint">{translate("common.loadingShort")}</p>;
	if (!contents || !path || !sessionId) return <p className="p-6 text-center text-detail text-ink-faint">{translate("filePanel.unreadable")}</p>;

	const project = projects?.find((entry) => entry.id === session?.summary.project);
	const sources = project ? [...new Set([project.path, ...(project.folders ?? [])])] : [];
	const roots = cwd && sources.some((root) => cwd === root || cwd.startsWith(root + "/") || cwd.startsWith(root + "\\")) ? sources : cwd ? [cwd] : undefined;

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col">
			<FileHeader sessionId={sessionId} cwd={cwd} roots={roots} running={session?.summary.running} path={path} name={name ?? path} contents={contents} />
			<FileViewer sessionId={sessionId} path={path} name={name ?? path} contents={contents} reveal={reveal} />
		</div>
	);
}
