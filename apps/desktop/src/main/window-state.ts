/**
 * 主窗口记住自己的位置和大小，下次照原样打开。存在数据目录（见 home.ts）的 window.json。
 *
 * 只记普通状态下的窗口（getNormalBounds），最大化另记一笔；全屏、最小化时不写。写什么、要不要最大化着打开见 window-bounds.ts。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserWindow, screen } from "electron";
import { plumeHome } from "./home.ts";
import { type Opened, stateToSave, type WindowState } from "./window-bounds.ts";

/** 拖动、缩放时每帧都有事件，停下来这么久再写。 */
const SAVE_DELAY_MS = 400;

function statePath(): string {
	return join(plumeHome(), "window.json");
}

/**
 * 读上次的位置和大小，读不到返回 undefined。大小不小于窗口的最小尺寸；
 * 位置只在还落在某块现存的屏幕上时才用，拔掉的外接屏会把窗口放到够不着的地方。
 */
export function readWindowState(min: { width: number; height: number }): WindowState | undefined {
	try {
		const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<WindowState>;
		if (typeof raw.width !== "number" || typeof raw.height !== "number") return undefined;
		const state: WindowState = {
			width: Math.max(min.width, raw.width),
			height: Math.max(min.height, raw.height),
			...(raw.maximized === true ? { maximized: true } : {}),
		};
		const { x, y } = raw;
		if (typeof x === "number" && typeof y === "number") {
			// 标题栏那一条（顶上 40px）要在屏幕里，才拖得回来。
			const visible = screen
				.getAllDisplays()
				.some(({ workArea: area }) => x < area.x + area.width && x + state.width > area.x && y < area.y + area.height && y + 40 > area.y);
			if (visible) Object.assign(state, { x, y });
		}
		return state;
	} catch {
		return undefined;
	}
}

/**
 * 窗口移动、缩放停下后和关闭时写一次。`asked` 是打开时要的边界（没有存档时是默认大小）：建窗后立刻和显示前各量一次
 * 实际出来的边界，还没人动过时写回要的那个，见 window-bounds.ts。
 */
export function rememberWindowState(window: BrowserWindow, asked: { x?: number; y?: number; width: number; height: number }): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let opened: Opened | null = null;
	// 窗口还没显示，人动不了它，到这一刻为止的变化都是系统做的。
	const noteOpened = () => {
		const got = window.getNormalBounds();
		opened = { asked: { x: asked.x ?? got.x, y: asked.y ?? got.y, width: asked.width, height: asked.height }, got };
	};
	noteOpened();
	window.once("ready-to-show", noteOpened);
	const save = () => {
		clearTimeout(timer);
		if (window.isDestroyed()) return;
		const state = stateToSave({
			normal: window.getNormalBounds(),
			maximized: window.isMaximized(),
			fullScreen: window.isFullScreen(),
			minimized: window.isMinimized(),
			opened,
		});
		if (!state) return;
		try {
			writeFileSync(statePath(), JSON.stringify(state));
		} catch {
			// 记不住大小不值得让窗口出错。
		}
	};
	const later = () => {
		clearTimeout(timer);
		timer = setTimeout(save, SAVE_DELAY_MS);
	};
	window.on("resize", later);
	window.on("move", later);
	window.on("close", save);
}
