/**
 * 主窗口下次照什么样子打开：该往 window.json 里写什么、要不要最大化着打开。纯规则，不碰 Electron，读写在 window-state.ts。
 *
 * 两样毛病都只在 Windows 上看得见：
 *   - 最大化着关掉的窗口，下次是普通窗口。最大化时的边界是屏幕的，不是谁挑的大小，所以从来不写，「最大化过」
 *     这件事也跟着丢了。现在照旧写普通状态的边界，旁边再记一个 `maximized`。
 *   - 窗口每启动一次就大一圈（125% 缩放下 1202×802、1206×807、1210×813……）。写下的是窗口读回来的大小，而
 *     125% 下建出来的窗口不正好是要的大小：物理像素取整，系统建窗时还加了几像素边框。于是每次读到的都成了下次
 *     要的。所以在有人真动过窗口之前，写回去的是当初要的那个大小。
 */

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WindowState {
	x?: number;
	y?: number;
	width: number;
	height: number;
	/** 上次关时是最大化的。只有 Windows、Linux 照此打开，见 `reopenMaximized`。 */
	maximized?: boolean;
}

/** 窗口打开时要的边界和实际出来的边界。 */
export interface Opened {
	asked: Box;
	got: Box;
}

const same = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * 此刻该写的状态，null 表示文件不动。`normal` 是窗口普通状态下的边界（`getNormalBounds`），最大化时它仍是人挑的那个大小。
 */
export function stateToSave(input: { normal: Box; maximized: boolean; fullScreen: boolean; minimized: boolean; opened: Opened | null }): WindowState | null {
	// 全屏是一种模式，最小化马上就不是这个样子了，这两种都不是要记住的选择。
	if (input.fullScreen || input.minimized) return null;
	const untouched = input.opened !== null && same(input.normal, input.opened.got);
	const box = untouched ? input.opened!.asked : input.normal;
	return { width: box.width, height: box.height, x: box.x, y: box.y, ...(input.maximized ? { maximized: true } : {}) };
}

/**
 * 要不要最大化着打开。macOS 不要：那里的「最大化」是绿灯的缩放，铺满屏幕但不是一种模式，系统惯例是下次以缩放前的
 * 大小打开，存下的普通边界正好是它。
 */
export function reopenMaximized(state: WindowState | undefined, platform: string): boolean {
	return platform !== "darwin" && state?.maximized === true;
}
