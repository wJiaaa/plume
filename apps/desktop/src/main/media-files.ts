/** 媒体菜单只接受托管图片名；定位与打开复用同一条边界。 */
import { mediaFilePath } from "@plume/agent";
import { ipcMain, shell } from "electron";

export function registerMediaFilesIpc(mediaDir: string): void {
	ipcMain.handle("plume:media:path", (_event, name: string) => mediaFilePath(mediaDir, name));
	ipcMain.handle("plume:media:reveal", async (_event, name: string) => {
		const path = await mediaFilePath(mediaDir, name);
		if (!path) return false;
		shell.showItemInFolder(path);
		return true;
	});
}
