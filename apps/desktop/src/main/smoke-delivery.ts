import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

interface DeliverySmoke {
	window: BrowserWindow;
	workspace: string;
	outDir: string;
	page(code: string): Promise<unknown>;
	until(code: string, label: string): Promise<void>;
	click(selector: string, text?: string): Promise<void>;
	capture(window: BrowserWindow, path: string): Promise<void>;
}

/** 只操作假模型创建的文件；完整流程留下独立截图和动效采样结果。 */
export async function checkDelivery({ window, workspace, outDir, page, until, click, capture }: DeliverySmoke): Promise<void> {
	const card = "[data-turn-delivery]";
	const preview = '[role="group"][aria-label="文件变更预览"]';
	const visibleRows = `([...document.querySelectorAll('${card} [data-delivery-file]')].filter(row => !row.closest('[inert]')))`;
	await until(`document.querySelector('${card}')?.textContent.includes('已编辑 4 个文件')`, "交付卡按文件汇总这一轮");
	await until(`${visibleRows}.length === 3`, "交付卡默认仅显示三个文件");
	await page(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`);
	await capture(window, join(outDir, "smoke-delivery-light.png"));
	await click(`${card} button`, "再显示 1 个文件");
	const animation = await page(`(async () => {
		await new Promise(resolve => requestAnimationFrame(resolve));
		const reveal = document.querySelector('${card} .plume-reveal');
		if (!reveal) return { error: '没有展开过渡' };
		const transition = reveal.getAnimations().find(item => item.transitionProperty === 'grid-template-rows');
		if (!transition) return { error: '没有高度过渡时间轴' };
		const duration = transition.effect.getTiming().duration;
		transition.pause();
		transition.currentTime = 0;
		const start = reveal.getBoundingClientRect().height;
		transition.currentTime = duration / 2;
		const middle = reveal.getBoundingClientRect().height;
		transition.finish();
		const end = reveal.getBoundingClientRect().height;
		return { duration, start, middle, end, ok: duration === 340 && start < middle && middle < end && end >= 35, open: reveal.dataset.open, inert: reveal.inert };
	})()`);
	if (!(animation as { ok?: boolean }).ok) throw new Error(`交付卡展开动画中间帧不正确：${JSON.stringify(animation)}`);
	await until(`${visibleRows}.length === 4 && document.querySelector('${card} .plume-reveal').getBoundingClientRect().height >= 35`, "剩余文件展开到完整行高");
	await click(`${card} button`, "收起文件");
	await until(`document.querySelector('${card} .plume-reveal').getBoundingClientRect().height < 1`, "收起文件过渡完成");

	// 悬停必须等待意图，不在掠过文件行时遮住标题按钮。
	await page(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`);
	const point = (await page(
		`(() => { const r = document.querySelector('${card} [data-delivery-file]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
	)) as { x: number; y: number };
	window.webContents.sendInputEvent({ type: "mouseMove", x: 0, y: 0 });
	window.webContents.sendInputEvent({ type: "mouseMove", ...point });
	if (await page(`document.querySelector(${JSON.stringify(preview)}) !== null`)) throw new Error("悬停预览没有等待指针停留");
	await until(`document.querySelector(${JSON.stringify(preview)}) !== null`, "停留后打开文件 diff 预览");
	await capture(window, join(outDir, "smoke-delivery-hover.png"));
	window.webContents.sendInputEvent({ type: "mouseMove", x: 0, y: 0 });
	await until(`document.querySelector(${JSON.stringify(preview)}) === null`, "离开预览后浮层延迟关闭");
	const header = (await page(
		`(() => { const r = document.querySelector('${card} button[data-plume-tip="审核全部文件改动"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
	)) as { x: number; y: number };
	window.webContents.sendInputEvent({ type: "mouseMove", ...header });
	await until(`document.querySelector(${JSON.stringify(preview)}) === null`, "移向标题操作时预览让开");

	await page(`document.querySelector('${card} button[data-plume-tip="审核全部文件改动"]').focus()`);
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
	window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
	await until(
		`document.activeElement?.hasAttribute('data-delivery-file') && document.querySelector(${JSON.stringify(preview)}) !== null`,
		"键盘聚焦文件行立即预览",
	);
	await page(
		`(() => { const row = document.querySelector('${card} [data-delivery-file]'); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 18 })); })()`,
	);
	await until(
		`document.querySelector('[role=menu]')?.textContent.includes('复制相对路径') && !document.querySelector(${JSON.stringify(preview)})`,
		"文件右键菜单出现且预览让开",
	);
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
	window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
	await until(`!document.querySelector('[role=menu]')`, "关闭文件右键菜单");

	// 只从卡片进入的辅助面板，不污染面板起始页。
	await click(`${card} button`, "审核");
	await until(`document.querySelectorAll('[data-delivery-diff]').length === 4`, "审核面板显示本轮全部四个文件");
	await capture(window, join(outDir, "smoke-delivery-review.png"));
	await click(`${card} button`, "报告");
	await until(`document.querySelector('[data-panel]:not([inert])')?.textContent.includes('本轮实现与验证记录')`, "报告复用文件预览显示实际记录");
	await capture(window, join(outDir, "smoke-delivery-report.png"));

	// 清掉本次打开的辅助标签，后面的终端验证仍从空面板开始。
	await page(`document.querySelectorAll('[data-panel-tab] button[aria-label^="关闭"]').forEach(button => button.click())`);
	await until(`document.querySelector('[data-panel-area]')?.inert === true`, "关闭报告和审核后面板收起");
	await page(`window.plume.saveAppearance({ theme: 'dark' })`);
	await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "交付卡切到深色");
	await capture(window, join(outDir, "smoke-delivery-dark.png"));
	const size = window.getSize();
	window.setSize(600, size[1]!);
	await until(
		`innerWidth === 600 && (() => { const r = document.querySelector('${card}').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`,
		"窄窗口交付卡没有横向溢出",
	);
	await capture(window, join(outDir, "smoke-delivery-compact.png"));
	window.setSize(size[0]!, size[1]!);
	await page(`window.plume.saveAppearance({ theme: 'light' })`);
	await until(`!matchMedia('(prefers-color-scheme: dark)').matches && innerWidth === ${size[0]}`, "恢复交付测试窗口");

	await click(`${card} button`, "撤销");
	await until(`document.querySelector('[role=dialog]')?.textContent.includes('仅撤销已记录的改动')`, "整轮撤销先确认保护范围");
	await click("[role=dialog] button", "取消");
	await until(`document.querySelector('[role=dialog]') === null`, "取消撤销关闭确认框");
	if (!(await readFile(join(workspace, "hello.txt"), "utf8")).startsWith("hi\n")) throw new Error("取消撤销仍修改了文件");

	const path = join(workspace, "delivery-a.ts");
	await click(`${card} [data-delivery-file=${JSON.stringify(path)}]`);
	await until(`document.querySelectorAll('[data-delivery-diff]').length === 1`, "点文件只审核所选文件");
	await click('[data-delivery-diff] button[aria-label="撤销此文件的改动"]');
	await until(`document.querySelector('[role=dialog]') !== null`, "单文件撤销先确认");
	await click("[role=dialog] button", "撤销改动");
	await until(
		`document.querySelector('[role=dialog]') === null && !document.querySelector('${card} button[data-plume-tip="撤销这次文件改动"]')`,
		"撤销后卡片和审核面板共享最新状态",
	);
	if (
		await stat(path).then(
			() => true,
			() => false,
		)
	)
		throw new Error("撤销新建文件后文件仍存在");
	await page(`document.querySelectorAll('[data-panel-tab] button[aria-label^="关闭"]').forEach(button => button.click())`);
	await until(`document.querySelector('[data-panel-area]')?.inert === true`, "结束交付面板验证");
	console.log(`PLUME_DELIVERY_SMOKE ${JSON.stringify({ ok: true, files: 4, animation, report: true, review: true, undo: true, themes: ["light", "dark"] })}`);
}
