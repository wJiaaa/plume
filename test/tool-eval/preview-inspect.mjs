/*
 * preview-eval 的页面检查：在 Electron 里调桌面应用主进程的那份检查（`apps/desktop/src/main/web-inspect.ts` 的 `inspectPage`），
 * 把 `WebInspection` 打成一行 JSON 到 stdout。
 *
 *   electron test/tool-eval/preview-inspect.mjs <网址> <选项 JSON>
 *
 * 直接用产品的实现而不是另写一份：评测量的是模型看着产品给它的截图和报错怎么做，检查自己换了样，量到的就不是那回事。
 * Electron 自带的 Node 默认剥类型，可以直接引入 .ts。
 */

import { app } from "electron";

const [url, options] = process.argv.slice(-2);

app.dock?.hide();
// 检查收尾时销毁它的窗口：不接这个事件，Electron 会在关掉最后一个窗口时自己退出，结果还没写出来。
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
	try {
		const { inspectPage } = await import("../../apps/desktop/src/main/web-inspect.ts");
		const result = await inspectPage(url, JSON.parse(options));
		// 等写完再退：stdout 是管道时写是异步的，截图有几百 KB，`app.exit` 抢在前面就只剩空输出。
		process.stdout.write(`${JSON.stringify(result)}\n`, () => app.exit(0));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		app.exit(1);
	}
});
