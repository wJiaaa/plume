import type { ProjectEntry } from "@plume/contract";
import type { PanelProps } from "@plume/contract/ui";
import { PanelEmpty, translate } from "@plume/ui";
import { Folder } from "@plume/ui/icons";
import { FileTree } from "./FileTree.tsx";

export function FileBrowser({ session, cwd, projects }: PanelProps & { projects: readonly ProjectEntry[] }) {
	if (!session || !cwd)
		return (
			<PanelEmpty icon={Folder} title={translate("fileTree.projectFiles")}>
				{translate("filePanel.pickOne")}
			</PanelEmpty>
		);
	const project = projects.find((entry) => entry.id === session.summary.project);
	const sources = project ? [...new Set([project.path, ...(project.folders ?? [])])] : [];
	const roots = sources.some((root) => cwd === root || cwd.startsWith(root + "/") || cwd.startsWith(root + "\\")) ? sources : [cwd];
	return <FileTree key={`${session.summary.id}:${cwd}`} sessionId={session.summary.id} root={cwd} roots={roots} running={session.summary.running} />;
}
