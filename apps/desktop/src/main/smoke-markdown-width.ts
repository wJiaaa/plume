import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import { type BrowserWindow, nativeTheme } from "electron";
import { clickReal } from "./smoke-kit.ts";

/** transcript-scroll 的尺寸回归：流式代码和表格有中间宽度，写完回到自然排版，窄窗与换行仍可用。 */
export async function checkMarkdownWidths({
	window,
	outDir,
	setModel,
}: {
	window: BrowserWindow;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const until = async (code: string, label: string) => {
		const end = Date.now() + 20_000;
		while (!(await page<boolean>(code))) {
			if (Date.now() > end) throw new Error(`Markdown 尺寸等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
	};
	const code = `const a = 1;\nconst longer = "${"abcdefghij".repeat(14)}";`;
	const text = `\`\`\`ts\n${code}\n\`\`\`\n\n| 项 | 说明 |\n| --- | --- |\n| 一 | 短说明 |\n| 第二个比较长的项目 | ${"逐渐增加的详细说明".repeat(6)} |\n\n尺寸验证结束。`;
	const size = window.getSize();
	const theme = nativeTheme.themeSource;
	const reduced = await page<string | null>(`document.documentElement.getAttribute('data-reduce-motion')`);
	try {
		for (const reduce of [false, true]) {
			await page(`document.documentElement.setAttribute('data-reduce-motion', '${reduce ? "on" : "off"}')`);
			setModel(() => ({ text, stream: { chunkSize: 10, delayMs: 40 } }));
			window.webContents.send("plume:command", "new-session");
			await until(`document.querySelector('[data-screen=empty] .cm-content') !== null`, "欢迎页");
			await page(`document.querySelector('[data-screen=empty] .cm-content').focus()`);
			await window.webContents.insertText("验证代码与表格宽度");
			await page(`(() => {
				const probe = window.__widthProbe = { stop: false, samples: [], code: 0, columns: 0 };
				const tick = () => {
					if (probe.stop) return;
					for (const animation of document.getAnimations()) {
						const el = animation.effect?.target;
						const progress = animation.effect?.getComputedTiming().progress;
						if (progress > 0 && progress < 1 && (el?.matches('.markdown-code') || el?.tagName === 'COL')) {
							const keyframes = animation.effect.getKeyframes();
							const from = parseFloat(keyframes[0].width), to = parseFloat(keyframes.at(-1).width);
							const width = el.getBoundingClientRect().width;
							if (width > Math.min(from,to) + .5 && width < Math.max(from,to) - .5) {
								if (el.tagName === 'COL') probe.columns++; else probe.code++;
							}
						}
					}
					probe.samples.push({ t: performance.now(), code: document.querySelector('.markdown-code')?.getBoundingClientRect().width ?? null, columns: [...document.querySelectorAll('.markdown-table th')].map(el => el.getBoundingClientRect().width) });
					requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			})()`);
			await clickReal(window, "[data-composer-send=send]");
			await until(
				`document.querySelector('[data-screen=chat]')?.textContent.includes('尺寸验证结束。') && !document.querySelector('[data-composer-send=stop]')`,
				"回复写完",
			);
			await until(`!document.querySelector('.markdown-fade, [data-growing-width]')`, "淡入和尺寸过渡收尾");
			const result = await page<{ code: number; columns: number; samples: unknown[] }>(`(window.__widthProbe.stop = true, window.__widthProbe)`);
			await writeFile(join(outDir, `markdown-width-${reduce ? "reduced" : "animated"}.json`), JSON.stringify(result));
			if (reduce) {
				assert.equal(result.code + result.columns, 0, "减少动态效果时不播放宽度动画");
			} else {
				assert.ok(result.code > 0, "代码块必须经过中间宽度，不能一步跳到新的自然宽度");
				assert.ok(result.columns > 0, "表格列必须经过中间宽度，不能把后面的列直接推走");
			}
			assert.equal(await page<string>(`document.querySelector('.markdown-code pre').textContent`), code, "尺寸过渡不丢代码文本");
			assert.equal(await page<number>(`document.querySelectorAll('.markdown-table td').length`), 4, "表格单元格齐全");
			assert.equal(
				await page<boolean>(
					`document.querySelector('.markdown-table table').style.tableLayout === '' && document.querySelector('.markdown-code').style.width === ''`,
				),
				true,
				"收尾回到自然布局",
			);
			if (!reduce) {
				for (const mode of ["light", "dark"] as const) {
					nativeTheme.themeSource = mode;
					await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
					await writeFile(join(outDir, `smoke-markdown-width-${mode}.png`), (await window.webContents.capturePage()).toPNG());
				}
				window.setSize(800, 860);
				await until(
					`document.querySelector('.markdown-code').getBoundingClientRect().width <= document.querySelector('.markdown-code').parentElement.getBoundingClientRect().width + 1`,
					"窄窗代码块不撑破正文",
				);
				await clickReal(window, ".markdown-code-head button:first-of-type");
				assert.ok(await page<boolean>(`document.querySelector('.markdown-code').hasAttribute('data-wrap')`), "代码换行开关有效");
				await clickReal(window, ".markdown-table-toggle");
				assert.equal(await page<string>(`document.querySelector('.markdown-table').dataset.wrap`), "true", "表格换行开关有效");
				window.setSize(size[0]!, size[1]!);
			}
			console.log("PLUME_SMOKE_MARKDOWN_WIDTH", JSON.stringify({ reduced: reduce, code: result.code, columns: result.columns }));
		}
		const shortId = await page<string>(`document.querySelector('[data-plume-session]').dataset.plumeSession`);
		setModel(() => ({ text: Array.from({ length: 20 }, (_, index) => `## 第 ${index + 1} 组\n\n${text}`).join("\n\n") }));
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty] .cm-content') !== null`, "长回复欢迎页");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("验证长回复切换后的真实尺寸");
		await clickReal(window, "[data-composer-send=send]");
		await until(
			`document.querySelectorAll('.markdown-table').length === 20 && !document.querySelector('.markdown-fade') && !document.querySelector('[data-composer-send=stop]')`,
			"长回复稳定",
		);
		const longId = await page<string>(`document.querySelector('[data-plume-session]').dataset.plumeSession`);
		await until(`document.querySelectorAll('[data-markdown-measured]').length === 40`, "代码和表格已记下真尺寸");
		await clickReal(window, `[data-plume-row="${shortId}"] > button`);
		await clickReal(window, `[data-plume-row="${longId}"] > button`);
		await until(`document.querySelector('[data-plume-session]')?.dataset.plumeSession === ${JSON.stringify(longId)}`, "切回长回复");
		const geometry = () =>
			page<{ before: number; actual: number; skipped: number }>(`(() => {
			const root = document.querySelector('[data-plume-session]');
			const nodes = [...root.querySelectorAll('[data-markdown-measured]')];
			const styles = nodes.map(node => node.style.cssText);
			const before = root.getBoundingClientRect().height;
			const skipped = nodes.filter(node => !node.firstElementChild.checkVisibility({contentVisibilityAuto:true})).length;
			nodes.forEach(node => { node.style.contentVisibility = ''; node.style.containIntrinsicSize = ''; });
			const actual = root.getBoundingClientRect().height;
			nodes.forEach((node, index) => node.style.cssText = styles[index]);
			return { before, actual, skipped };
		})()`);
		const remembered = await geometry();
		assert.ok(remembered.skipped > 0, "屏外的代码和表格要真正跳过布局");
		assert.ok(Math.abs(remembered.before - remembered.actual) < 1, `占位等于真实高度：${JSON.stringify(remembered)}`);
		window.setSize(800, 860);
		await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
		const narrowed = await geometry();
		assert.ok(Math.abs(narrowed.before - narrowed.actual) < 1, `变窄后不沿用错误尺寸：${JSON.stringify(narrowed)}`);
		// 滚到屏外代码上时，观察器会补量横向溢出，不能因为之前跳过测量而丢掉横向滑块。
		await page(`document.querySelector('.markdown-code').scrollIntoView({block:'center'})`);
		await until(`document.querySelector('.markdown-code .plume-hthumb') !== null`, "代码露面后横向滑块恢复");
		console.log("PLUME_SMOKE_MARKDOWN_LAYOUT", JSON.stringify({ remembered, narrowed }));
	} finally {
		await page(
			`if (window.__widthProbe) window.__widthProbe.stop = true; ${reduced === null ? "document.documentElement.removeAttribute('data-reduce-motion')" : `document.documentElement.setAttribute('data-reduce-motion', ${JSON.stringify(reduced)})`}`,
		);
		window.setSize(size[0]!, size[1]!);
		nativeTheme.themeSource = theme;
		setModel(undefined);
	}
}
