import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

/**
 * 应用更新的界面：菜单栏图标的「检查更新…」到设置 › 关于并查一次（冒烟不联网，答「查不了」），自动检查的间隔记得住；
 * 再经 `__plumeUpdatePreview` 放进一个新版本，看侧栏底行的圆点、悬停展开的字、下载中的进度环和对话框的进度、失败和下好之后的按钮。
 */
export async function checkUpdate(options: { window: BrowserWindow; outDir: string }): Promise<void> {
	const { window, outDir } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const until = async (code: string, label: string) => {
		const deadline = Date.now() + 15_000;
		while (!(await page<boolean>(code))) {
			if (Date.now() > deadline) throw new Error(`更新界面验证等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const settled = async () => {
		await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
		await page(
			`Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))`,
		);
	};
	const shot = async (name: string) => {
		await settled();
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const buttonWith = (text: string, scope = "document") =>
		`[...${scope}.querySelectorAll('button')].find((button) => button.textContent.includes(${JSON.stringify(text)}))`;
	const preview = (state: unknown) => page(`window.__plumeUpdatePreview(${JSON.stringify(state)})`);

	window.webContents.send("plume:command", "updates");
	await until(`document.querySelector('[data-plume-version-status]')?.textContent.includes('暂时查不到新版本')`, "「检查更新…」打开关于页、查完说查不了");
	await until(`document.body.textContent.includes(${JSON.stringify(`v${await page<string>("window.plume.version")}`)})`, "关于页写着当前版本");
	await until(`${buttonWith("检查更新")} && !${buttonWith("检查更新")}.disabled`, "检查更新按钮可点");
	await until(`document.body.textContent.includes('打开发布页')`, "查不了时也给发布页");

	// 间隔：改成每 12 小时，存在 localStorage 里。
	await page(`${buttonWith("每 6 小时（默认）")}.click()`);
	await until(`[...document.querySelectorAll('[role=menuitem]')].some((option) => option.textContent.includes('每 12 小时'))`, "间隔选项弹出");
	await page(`[...document.querySelectorAll('[role=menuitem]')].find((option) => option.textContent.includes('每 12 小时')).click()`);
	await until(`localStorage.getItem('plume.update.intervalHours') === '12' && Boolean(${buttonWith("每 12 小时")})`, "间隔记住了");
	await shot("smoke-update-about.png");

	const info = {
		current: "0.1.0",
		latest: "9.9.9",
		available: true,
		checked: true,
		notes: "<!-- plume:notes en -->\n### New\n- English only\n<!-- plume:notes zh-CN -->\n### 新功能\n- 更新圆点和对话框",
		url: "https://github.com/example/plume/releases/tag/v9.9.9",
		publishedAt: Date.UTC(2026, 10, 1),
		asset: { name: "Plume-9.9.9-arm64.zip", url: "https://example.com/Plume-9.9.9-arm64.zip", size: 140_000_000 },
		checksums: "https://example.com/SHA256SUMS",
	};
	await preview({ info, phase: { at: "idle" } });
	await until(
		`document.body.textContent.includes('立即更新到 v9.9.9') && document.body.textContent.includes('v9.9.9 更新详情')`,
		"关于页给出立即更新和更新详情",
	);
	await until(`document.body.textContent.includes('更新圆点和对话框') && !document.body.textContent.includes('English only')`, "更新内容只出中文那段");
	await shot("smoke-update-about-available.png");

	// 设置页的侧栏是章节列表，圆点在别的页的侧栏底行。
	window.webContents.send("plume:command", "new-session");
	await until(`document.querySelector('[data-plume-update-dot][data-phase=idle]') !== null`, "侧栏底行出现更新圆点");
	await preview({ phase: { at: "downloading", received: 63_000_000, total: 140_000_000 } });
	await until(`document.querySelector('[data-plume-update-dot][data-phase=downloading] [data-ring]') !== null`, "下载中圆点套上进度环");
	await page(`document.querySelector('[data-plume-update-dot]').focus()`);
	await until(
		`document.querySelector('[data-plume-update-dot] .update-dot-label').getBoundingClientRect().width > 40 && document.querySelector('[data-plume-update-dot]').textContent.includes('下载中 45%')`,
		"键盘聚焦时圆点展开写出进度",
	);
	await shot("smoke-update-badge.png");

	await page(`document.querySelector('[data-plume-update-dot]').click()`);
	await until(`document.querySelector('[data-plume-update-dialog] [data-plume-update-progress]')?.textContent.includes('45%')`, "对话框里是进度");
	await until(
		`Boolean(${buttonWith("暂停", "document.querySelector('[data-plume-update-dialog]')")}) && Boolean(${buttonWith("取消下载", "document.querySelector('[data-plume-update-dialog]')")})`,
		"下载中给暂停和取消下载",
	);
	await shot("smoke-update-dialog.png");

	await preview({
		phase: { at: "failed", error: "EPERM: operation not permitted, open 'C:\\\\x\\\\download.part'", received: 63_000_000, total: 140_000_000 },
	});
	await until(
		`(() => { const dialog = document.querySelector('[data-plume-update-dialog]'); return dialog.textContent.includes('这次没能写完') && !dialog.textContent.includes('download.part') && Boolean(${buttonWith("重试", "dialog")}); })()`,
		"失败时说原因、不露路径、给重试",
	);
	await preview({ phase: { at: "ready", relaunch: true } });
	await until(
		`document.querySelector('[data-plume-update-dialog]').textContent.includes('重启 Plume 即可用上新版本') && Boolean(${buttonWith("立即重启", "document.querySelector('[data-plume-update-dialog]')")})`,
		"下好后给立即重启",
	);
	await shot("smoke-update-ready.png");
	await page(`${buttonWith("关闭", "document.querySelector('[data-plume-update-dialog]')")}.click()`);
	await until(
		`document.querySelector('[data-plume-update-dialog]') === null && document.querySelector('[data-plume-update-dot][data-phase=ready]') !== null`,
		"关掉对话框，圆点还在",
	);
	await preview({ info: null, phase: { at: "idle" } });
	await page(`localStorage.removeItem('plume.update.intervalHours')`);
}
