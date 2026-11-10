import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clipboard, type BrowserWindow } from "electron";

/**
 * 文字框的右键菜单：在输入框（CodeMirror）里右键，全选、剪切、粘贴都作用在输入框里；没选中时「剪切」是灰的。
 * 系统剪贴板会被借用，跑完放回原来的文字。
 */
export async function checkInputMenu(options: { window: BrowserWindow; outDir: string }): Promise<void> {
	const { window, outDir } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const deadline = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error(`输入框右键菜单验证等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const menu = `document.querySelector('[data-plume-popover][role=menu]')`;
	const item = (label: string) =>
		`[...${menu}?.querySelectorAll('[role=menuitem]') ?? []].find((element) => element.textContent.includes(${JSON.stringify(label)}))`;
	// 空着时 CodeMirror 在里面画占位文字，读正文要把它去掉。
	const composerText = `[...document.querySelectorAll('.cm-content .cm-line')].map((line) => { const copy = line.cloneNode(true); copy.querySelectorAll('.cm-placeholder').forEach((node) => node.remove()); return copy.textContent; }).join('\\n')`;
	// 在输入框中间右键：派发 contextmenu 就是系统右键交给页面的那一下。
	const rightClick = async (selector = ".cm-content") => {
		await page(`(() => {
			const field = document.querySelector(${JSON.stringify(selector)});
			const box = field.getBoundingClientRect();
			field.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 12, clientY: box.top + box.height / 2 }));
		})()`);
		await until(`${menu} !== null`, "右键菜单弹出");
	};
	const choose = async (label: string) => {
		await until(`${item(label)}?.disabled === false`, `「${label}」可点`);
		await page(`${item(label)}.click()`);
		await until(`${menu} === null`, `点了「${label}」菜单收起`);
	};

	const saved = await clipboard.readText();
	const text = "右键菜单冒烟";
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty] .cm-content') !== null`, "新建对话");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(text);
		await until(`${composerText} === ${JSON.stringify(text)}`, "输入框里有字");

		await rightClick();
		const labels = await page<string[]>(`[...${menu}.querySelectorAll('[role=menuitem]')].map((element) => element.textContent)`);
		if (labels.length !== 4) throw new Error(`右键菜单应有剪切、复制、粘贴、全选四项，实际：${labels.join("、")}`);
		if (!(await page<boolean>(`${item("剪切")}.disabled && ${item("复制")}.disabled`))) throw new Error("没选中文字时「剪切」「复制」应是灰的");
		await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
		await page(
			`Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))`,
		);
		await writeFile(join(outDir, "smoke-input-menu.png"), (await window.webContents.capturePage()).toPNG());
		await choose("全选");
		await until(`window.getSelection().toString() === ${JSON.stringify(text)}`, "全选选中输入框里的字");

		await rightClick();
		await choose("剪切");
		await wait(async () => (await clipboard.readText()) === text, "剪切的字进了剪贴板");
		await until(`${composerText} === ''`, "剪切后输入框空了");

		await rightClick();
		await choose("粘贴");
		await until(`${composerText} === ${JSON.stringify(text)}`, "粘贴回输入框");

		// 普通 <input> 走 execCommand 那条路：临时放一个，全选再剪切，受控与否都要真的空掉。
		await page(`(() => {
			const input = document.createElement('input');
			input.id = 'smoke-input-menu-plain';
			input.value = 'plain';
			input.style.cssText = 'position:fixed;left:40px;top:40px;width:200px;z-index:99999';
			document.body.append(input);
		})()`);
		await rightClick("#smoke-input-menu-plain");
		await choose("全选");
		await rightClick("#smoke-input-menu-plain");
		await choose("剪切");
		await until(`document.querySelector('#smoke-input-menu-plain').value === ''`, "普通输入框剪切后空了");
		await wait(async () => (await clipboard.readText()) === "plain", "普通输入框剪切的字进了剪贴板");
		await page(`document.querySelector('#smoke-input-menu-plain').remove()`);
	} finally {
		await clipboard.writeText(saved);
	}
}
