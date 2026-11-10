/** 快捷键的写法按本机键盘来。 */
export function macKeyboard(platform = navigator.platform): boolean {
	return /Mac|iPhone|iPad|iPod|darwin/i.test(platform);
}

/** Mac 上印成符号、PC 键盘上印成单词的那几个键。 */
const KEY_NAMES: Record<string, string> = { "⌫": "Backspace", "↩": "Enter" };

/** 界面文案一律用紧凑的 Mac 写法；别的键盘要把修饰键写成名字。 */
export function shortcutLabel(text: string, platform = navigator.platform): string {
	if (macKeyboard(platform)) return text;
	return (
		text
			.replace(/([⌘⌃⌥⇧]+)(\S?)/g, (_match: string, modifiers: string, key: string) => {
				const parts: string[] = [];
				if (/[⌘⌃]/.test(modifiers)) parts.push("Ctrl");
				if (modifiers.includes("⌥")) parts.push("Alt");
				if (modifiers.includes("⇧")) parts.push("Shift");
				if (key) parts.push(KEY_NAMES[key] ?? key);
				return parts.join("+");
			})
			// 不带修饰键的按键符号（「删除选中 ⌫」）在 PC 键盘上和 ⌘ 一样陌生。
			.replace(/[⌫↩]/g, (glyph) => KEY_NAMES[glyph] ?? glyph)
	);
}

/**
 * 快捷键按的是哪个字母：键帽上印的那个。
 *
 * `key` 是拉丁字母时用 `key`。QWERTY、AZERTY、QWERTZ、Dvorak 上它就是键帽上的字母，也就是快捷键的
 * 写法；改用 `code` 匹配的话，AZERTY 的 Ctrl+Alt+A 会变成印着 Q 的那个键，Dvorak 的 Ctrl+B 变成印着 X 的。
 *
 * 否则用 `code`。没有拉丁字母的布局（俄语、希腊语、希伯来语）没有印着 A 的键可按，用户会去按 A 所在
 * 位置的那个键——浏览器自己的快捷键和 CodeMirror 的键位表都是这样兜底的。macOS 的 Option 也落到这里：
 * 它是死键修饰，⌥S 到达时是「ß」，只有位置还说明它是 S。
 */
export function shortcutLetter(event: Pick<KeyboardEvent, "key" | "code">): string | null {
	if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
	return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : null;
}

/** 把 Electron 的 accelerator 写成按键文字，不把 Control、Command 和 Windows 键混为一谈。 */
export function acceleratorLabel(accelerator: string, platform = navigator.platform): string {
	const mac = macKeyboard(platform);
	const names: Record<string, string> = {
		commandorcontrol: mac ? "⌘" : "Ctrl",
		cmdorctrl: mac ? "⌘" : "Ctrl",
		command: mac ? "⌘" : "Win",
		cmd: mac ? "⌘" : "Win",
		meta: mac ? "⌘" : "Win",
		super: mac ? "⌘" : "Win",
		control: mac ? "⌃" : "Ctrl",
		ctrl: mac ? "⌃" : "Ctrl",
		alt: mac ? "⌥" : "Alt",
		option: mac ? "⌥" : "Alt",
		shift: mac ? "⇧" : "Shift",
	};
	return accelerator
		.split("+")
		.map((part) => names[part.toLowerCase()] ?? part)
		.join(mac ? " " : "+");
}

const composingTargets = new WeakSet<EventTarget>();
export function markComposition(target: EventTarget, active: boolean): void {
	if (active) composingTargets.add(target);
	else composingTargets.delete(target);
}

/** 这些键归输入法和 AltGr；当成命令处理的话，打字打到一半就切了窗格。 */
export function composingKey(event: KeyboardEvent): boolean {
	return (event.target !== null && composingTargets.has(event.target)) || event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph");
}

export function recordAccelerator(event: KeyboardEvent, platform = navigator.platform): string | null {
	if (composingKey(event) || ["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
	const mac = macKeyboard(platform);
	const parts: string[] = [];
	if (event.metaKey) parts.push(mac ? "CommandOrControl" : "Super");
	if (event.ctrlKey) parts.push(mac ? "Control" : "CommandOrControl");
	if (event.altKey) parts.push("Alt");
	if (event.shiftKey) parts.push("Shift");
	// Option 会改掉 `key`（S 变成 ß）；Electron 的 accelerator 写的是物理按键的字母。
	let key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.key;
	const names: Record<string, string> = {
		" ": "Space",
		"+": "Plus",
		ArrowUp: "Up",
		ArrowDown: "Down",
		ArrowLeft: "Left",
		ArrowRight: "Right",
	};
	key = names[key] ?? key.toUpperCase();
	return [...parts, key].join("+");
}
