import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { waitFor } from "./smoke-kit.ts";

/** 正常重载，不拦截连接，也不为取图延长产品里的启动动画。 */
export async function checkBootScreen({
	window,
	outDir,
	capture,
}: {
	window: BrowserWindow;
	outDir: string;
	capture(window: BrowserWindow, file: string): Promise<void>;
}): Promise<void> {
	const contents = window.webContents;
	const page = <T>(code: string) => contents.executeJavaScript(code) as Promise<T>;
	const ready = () => page<boolean>(`!document.querySelector('[data-boot-screen]') && !!document.querySelector('[data-screen=empty] .cm-content')`);
	await waitFor(ready, "workspace ready");
	for (const theme of ["light", "dark"]) {
		await page(`window.plume.saveAppearance({theme:'${theme}'})`);
		await new Promise<void>((resolve) => {
			contents.once("did-finish-load", () => resolve());
			contents.reload();
		});
		await waitFor(
			() =>
				page<boolean>(`(() => {
			const boot = document.querySelector('[data-boot-screen]'), img = boot?.querySelector('img'), rail = boot?.querySelector('.plume-boot-rail');
			return img?.naturalWidth === 768 && img.naturalHeight === 768 && rail?.getBoundingClientRect().width === 128 && getComputedStyle(img.parentElement).opacity >= 0.8;
		})()`),
			`${theme} startup mark and rail`,
		);
		const src = await page<string>(`document.querySelector('[data-boot-screen] img').currentSrc`);
		assert.equal(
			createHash("sha256")
				.update(await readFile(fileURLToPath(src)))
				.digest("hex"),
			"f81e13392c36f2beb2f3eb1cc4687834aa534541f8282018ec7c9d7720f5f32d",
		);
		assert.equal(await page<boolean>(`matchMedia('(prefers-color-scheme: dark)').matches`), theme === "dark");
		await capture(window, join(outDir, `smoke-boot-${theme}.png`));
		await waitFor(ready, `${theme} workspace ready after startup`);
		await page(`document.querySelector('[data-screen=empty] .cm-content').focus()`);
		assert.equal(await page<boolean>(`document.activeElement.matches('.cm-content')`), true);
		await capture(window, join(outDir, `smoke-boot-ready-${theme}.png`));
	}
}
