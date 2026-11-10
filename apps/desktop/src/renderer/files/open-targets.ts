/**
 * 「默认文件打开目标」在渲染进程这一头：这台机器能选什么（主进程列，见 main/open-targets.ts）、选了哪个。
 * 选的值只在界面里用，记在 localStorage 里，和别的显示偏好一样。
 */

import { type MessageKey, translate } from "@plume/ui";
import { useSyncExternalStore } from "react";
import type { OpenTarget } from "../../shared/open-targets.ts";

const KEY = "plume.openTarget";
/** 默认 Zed；这台机器没有时，打开交给系统默认的应用。 */
const DEFAULT_TARGET = "zed";

const listeners = new Set<() => void>();
const notify = () => {
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

let stored = read();
/** 列表在模块里只取一次：装应用的频率和重启应用差不多。没取到之前只有 reveal。 */
let loaded: OpenTarget[] | null = null;
let pending: Promise<void> | null = null;

function read(): string {
	try {
		return localStorage.getItem(KEY) ?? DEFAULT_TARGET;
	} catch {
		return DEFAULT_TARGET;
	}
}

const reveal = (): OpenTarget => ({ id: "reveal", label: "" });

function load(): void {
	pending ??= window.plume.files
		.targets()
		.then((targets) => {
			loaded = targets.length > 0 ? targets : [reveal()];
		})
		.catch(() => {
			loaded = [reveal()];
		})
		.finally(notify);
}

export function useOpenTargets(): OpenTarget[] {
	load();
	return useSyncExternalStore(subscribe, () => loaded ?? FIRST_FRAME);
}
const FIRST_FRAME = [reveal()];

/**
 * 存的值对应哪一项。按 id 找；认不出的留着自己的字当名字：那是在另一台装了那个应用的机器上选的，
 * 这台只是没有，悄悄改掉它不对。
 */
function matchTarget(targets: OpenTarget[], value: string): OpenTarget {
	const id = value.trim();
	if (!id) return targets[0] ?? reveal();
	return targets.find((target) => target.id === id) ?? { id, label: id };
}

export function useOpenTarget(): OpenTarget {
	const targets = useOpenTargets();
	return matchTarget(
		targets,
		useSyncExternalStore(subscribe, () => stored),
	);
}

/** 现在选的目标的 id，给不在组件里的动作用（附件的「打开」）。 */
export function openTargetId(): string {
	return stored;
}

export function setOpenTarget(id: string): void {
	stored = id;
	try {
		localStorage.setItem(KEY, id);
	} catch {
		// 存不下只是下次不记得，这一次照样生效。
	}
	notify();
}

/** 「在访达中显示」按这个平台自己的说法。 */
export function revealKey(): MessageKey {
	const platform = window.plume.platform;
	return platform === "darwin" ? "openTarget.revealFinder" : platform === "win32" ? "openTarget.revealExplorer" : "openTarget.reveal";
}

/** 每次调用时现译，跟着界面语言走。 */
export function revealLabel(): string {
	return translate(revealKey());
}

/** 系统自带、名字随界面语言变的应用（中文系统里叫「终端」「Windows 终端」「记事本」），按 id 翻译。 */
const SYSTEM_APPS: Record<string, MessageKey> = {
	terminal: "openTarget.terminal",
	"windows-terminal": "openTarget.windowsTerminal",
	notepad: "openTarget.notepad",
};

/** 目标在菜单里叫什么：reveal 按平台的说法，系统自带的应用按界面语言，其余是应用自己的名字。 */
export function targetLabel(target: OpenTarget): string {
	if (target.id === "reveal") return revealLabel();
	const key = SYSTEM_APPS[target.id];
	return key ? translate(key) : target.label;
}

/**
 * 按下去做什么，用话说：「在 Zed 中打开」或「在访达中显示」。reveal 自己的名字已经是整句，
 * 塞进同一句里会变成「在 在访达中显示 中打开」。
 */
export function openLabel(target: OpenTarget): string {
	return target.id === "reveal" ? revealLabel() : translate("openTarget.openIn", { app: targetLabel(target) });
}
