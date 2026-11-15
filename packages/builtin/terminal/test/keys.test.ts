/**
 * 终端里的按键在 Windows 和 Linux 上归谁：xterm 把每个 Ctrl+字母都变成控制字符发给 shell，这两个平台上 Chromium
 * 又没有自己的复制可以兜底，选中一段按 Ctrl+C 发出去的是中断。
 */

import { expect, it, vi } from "vitest";

// @plume/ui 的运行时由宿主给，测试里换成照公开说明写的替身：Mac 键盘按平台名认，字母键按 key 或物理按键认，
// 组字中（输入法、keyCode 229、带 AltGraph）的键算组字。
vi.mock("@plume/ui", () => ({
	macKeyboard: (platform: string) => /Mac|iPhone|iPad|iPod|darwin/i.test(platform),
	shortcutLetter: (event: Pick<KeyboardEvent, "key" | "code">) =>
		/^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : null,
	composingKey: (event: KeyboardEvent) => event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph"),
}));

const { terminalKey } = await import("../src/keys.ts");

/** Chromium 发来的 keydown：除非说了，没有 AltGraph。 */
function key(keyName: string, code: string, init: Partial<KeyboardEvent> = {}, altGraph = false): KeyboardEvent {
	return {
		key: keyName,
		code,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		isComposing: false,
		keyCode: 0,
		target: null,
		getModifierState: (modifier: string) => altGraph && modifier === "AltGraph",
		...init,
	} as KeyboardEvent;
}

it("Windows/Linux：有选区时 Ctrl+C 是复制，没选区时仍是 ^C", () => {
	const ctrlC = key("c", "KeyC", { ctrlKey: true });
	expect(terminalKey(ctrlC, true, "Win32")).toBe("copy");
	expect(terminalKey(ctrlC, false, "Win32")).toBe("shell");
	expect(terminalKey(key("C", "KeyC", { ctrlKey: true, shiftKey: true }), false, "Linux x86_64")).toBe("copy");
	expect(terminalKey(key("V", "KeyV", { ctrlKey: true, shiftKey: true }), false, "Win32")).toBe("paste");
	// Windows：单按 Ctrl+V 也是粘贴；cmd、Git Bash 收到 ^V 只会打出 ^V。
	expect(terminalKey(key("v", "KeyV", { ctrlKey: true }), false, "Win32")).toBe("paste");
	// Linux 的 Ctrl+V 是 readline 的原样插入，粘贴是 Ctrl+Shift+V。
	expect(terminalKey(key("v", "KeyV", { ctrlKey: true }), false, "Linux x86_64")).toBe("shell");
	// 俄文布局：C 键打出西里尔字母「с」，仍是 Ctrl+C。
	expect(terminalKey(key("с", "KeyC", { ctrlKey: true }), true, "Win32")).toBe("copy");
});

it("AltGr 在 Windows 上就是 Ctrl+Alt，用来打字：归 shell", () => {
	expect(terminalKey(key("ś", "KeyS", { ctrlKey: true, altKey: true }, true), false, "Win32")).toBe("shell");
	expect(terminalKey(key("b", "KeyB", { ctrlKey: true }), false, "Win32")).toBe("shell");
});

it("Mac 上一切照旧：⌘ 不进 shell，复制粘贴走编辑菜单", () => {
	expect(terminalKey(key("c", "KeyC", { ctrlKey: true }), true, "MacIntel")).toBe("shell");
	expect(terminalKey(key("c", "KeyC", { metaKey: true }), true, "MacIntel")).toBe("shell");
});

it("查找：Mac 上是 ⌘F，别处是 Ctrl+Shift+F；单按 Ctrl+F 仍是 readline 的光标右移", () => {
	expect(terminalKey(key("f", "KeyF", { metaKey: true }), false, "MacIntel")).toBe("find");
	expect(terminalKey(key("f", "KeyF", { metaKey: true, shiftKey: true }), false, "MacIntel")).toBe("shell");
	expect(terminalKey(key("f", "KeyF", { ctrlKey: true }), false, "MacIntel")).toBe("shell");
	expect(terminalKey(key("F", "KeyF", { ctrlKey: true, shiftKey: true }), false, "Win32")).toBe("find");
	expect(terminalKey(key("f", "KeyF", { ctrlKey: true }), false, "Win32")).toBe("shell");
	expect(terminalKey(key("F", "KeyF", { ctrlKey: true, shiftKey: true }), false, "Linux x86_64")).toBe("find");
});

/*
 * Ctrl+Alt+S/P/U 是侧边聊天、文件、子 Agent 面板的快捷键，焦点在终端里也要能用。主窗口里宿主在捕获阶段先接走；
 * 弹出的面板窗口里宿主不接，终端也不交给 xterm，不会变成 ESC 加控制字符打进 shell。AltGr 组字的键两边都放过，照常打字。
 */
it("Windows/Linux：Ctrl+Alt+S/P/U 归应用，AltGr 组字和别的字母仍归 shell", () => {
	for (const platform of ["Win32", "Linux x86_64"]) {
		for (const letter of ["s", "p", "u"]) {
			const ctrlAlt = key(letter, `Key${letter.toUpperCase()}`, { ctrlKey: true, altKey: true });
			expect(terminalKey(ctrlAlt, false, platform)).toBe("app");
		}
		expect(terminalKey(key("a", "KeyA", { ctrlKey: true, altKey: true }), false, platform)).toBe("shell");
		expect(terminalKey(key("S", "KeyS", { ctrlKey: true, altKey: true, shiftKey: true }), false, platform)).toBe("shell");
	}
	// 波兰语布局 AltGr+S 打 ś：Windows 上到达时是 Ctrl+Alt，带 AltGraph。
	const altGr = key("ś", "KeyS", { ctrlKey: true, altKey: true }, true);
	expect(terminalKey(altGr, false, "Win32")).toBe("shell");
	// Mac 上应用的快捷键是 ⌘，xterm 不碰：Ctrl+Option 仍归 shell。
	expect(terminalKey(key("s", "KeyS", { ctrlKey: true, altKey: true }), false, "MacIntel")).toBe("shell");
});
