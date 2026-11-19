import assert from "node:assert/strict";
import { BrowserWindow } from "electron";
import { isOverlay } from "./screenshot/overlay.ts";
import { waitFor } from "./smoke-kit.ts";

export async function checkScreenshotLifetime(main: BrowserWindow): Promise<void> {
	const set = (plugin: string, shortcut: string | null): Promise<unknown> =>
		main.webContents.executeJavaScript(`window.plume.screen.setShortcut(${JSON.stringify(plugin)}, ${JSON.stringify(shortcut)})`);
	const overlay = () => BrowserWindow.getAllWindows().find(isOverlay);
	const first = "Control+Shift+Alt+F9";
	const second = "Control+Shift+Alt+F10";
	const warm = async () => {
		await waitFor(async () => Boolean(overlay()?.webContents.getOSProcessId()), "screenshot overlay prewarmed");
		return overlay()!;
	};
	try {
		assert.equal(await set("example.screen-first", first), "ok");
		const original = await warm();
		assert.equal(await set("example.screen-second", second), "ok");
		assert.equal(await set("example.screen-first", second), "taken");
		assert.equal(overlay(), original, "another registered shortcut keeps the overlay warm");
		assert.equal(await set("example.screen-second", null), "ok");
		await waitFor(async () => original.isDestroyed(), "overlay destroyed after the last shortcut is released");
		assert.equal(overlay(), undefined);
		assert.equal(await set("example.screen-first", first), "ok");
		assert.notEqual(await warm(), original, "registering again prewarms a new overlay");
	} finally {
		await set("example.screen-first", null);
		await set("example.screen-second", null);
	}
}
