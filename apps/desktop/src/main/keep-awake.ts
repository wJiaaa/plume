/**
 * 「运行期间不让电脑休眠」：开着时持有一个系统级的「别休眠」声明，关掉就放掉。
 *
 * 取 `prevent-display-sleep` 而不是 `prevent-app-suspension`：后者只保证应用的 JS 继续跑，屏幕黑了系统照样会跟着睡，
 * 「离开一会儿回来它还在跑」就不成立。合盖拦不住：两个平台的合盖动作都由系统电源策略决定，要特权才能改，
 * 一个开关不该替人改那种退出应用后还留在机器上的东西，设置页的说明如实写着。
 *
 * 设置存在数据目录（见 home.ts）的 keep-awake.json。
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcMain, powerSaveBlocker } from "electron";
import { plumeHome } from "./home.ts";

const file = () => join(plumeHome(), "keep-awake.json");

let on = false;
let held: number | null = null;
/** 存盘排队，后选的不会被先选的盖掉。 */
let saving: Promise<void> = Promise.resolve();

/** 最多持有一个声明：powerSaveBlocker 的效果是叠加的，多 start 一个，开关关掉后电脑仍然不睡。 */
function apply(): void {
	const holding = held !== null && powerSaveBlocker.isStarted(held);
	if (on === holding) return;
	// 问过再停：系统可能已经自己收走了它。
	if (held !== null && holding) powerSaveBlocker.stop(held);
	held = on ? powerSaveBlocker.start("prevent-display-sleep") : null;
}

/** 在 app ready 之后调：按存下的设置摆好，之后跟着设置页走。 */
export function registerKeepAwake(): void {
	try {
		on = (JSON.parse(readFileSync(file(), "utf8")) as { keepAwake?: unknown }).keepAwake === true;
	} catch {
		// 没存过，或者文件坏了：不拦。
	}
	apply();
	ipcMain.on("plume:keep-awake", (event) => {
		event.returnValue = on;
	});
	ipcMain.handle("plume:keep-awake:save", (_event, value: unknown) => {
		if (typeof value !== "boolean") return;
		on = value;
		apply();
		const snapshot = JSON.stringify({ keepAwake: value }, null, "\t");
		saving = saving.then(() => writeFile(file(), snapshot)).catch((error: unknown) => console.error("「不让电脑休眠」没存上：", error));
		return saving;
	});
}
