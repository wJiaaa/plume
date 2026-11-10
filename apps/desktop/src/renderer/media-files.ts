/** 生成图仍在它所属会话的文件标签打开，媒体目录路径由主进程校验。 */
import { translate } from "@plume/ui";
import { openFile } from "./files/open-file.ts";
export { revealLabel as revealMediaLabel } from "./files/open-targets.ts";

export async function openMediaFile(name: string, sessionId: string): Promise<void> {
	const path = await window.plume.media.path(name);
	if (!path) throw new Error(translate("filePanel.unreadable"));
	await openFile(path, undefined, sessionId);
}

export async function revealMediaFile(name: string): Promise<void> {
	if (!(await window.plume.media.reveal(name))) throw new Error(translate("filePanel.unreadable"));
}
