import { randomUUID } from "node:crypto";
import { BrowserWindow, session, type NativeImage } from "electron";
import type { WebInspection, WebPages } from "@plume/contract";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 检查只持有一次页面；超时也销毁进程，死循环脚本不能把工具永远挂住。 */
export async function inspectPage(url: string, raw: unknown): Promise<WebInspection> {
	const address = new URL(url);
	if (!["http:", "https:"].includes(address.protocol) || address.username || address.password)
		throw new Error("Inspection requires an http(s) URL without credentials");
	const options = (raw ?? {}) as NonNullable<Parameters<WebPages["inspect"]>[1]>;
	const width = options.width ?? 720;
	const from = options.from ?? 0;
	if (!Number.isInteger(width) || width < 320 || width > 1600 || !Number.isFinite(from) || from < 0) throw new Error("Invalid inspection dimensions");
	if (options.measure !== undefined && (typeof options.measure !== "string" || options.measure.length > 32_000)) throw new Error("Invalid measurement script");
	const isolated = session.fromPartition(`plume-inspect-${randomUUID()}`);
	isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	isolated.setPermissionCheckHandler(() => false);
	isolated.on("will-download", (event) => event.preventDefault());
	const window = new BrowserWindow({
		show: false,
		width,
		height: 720,
		useContentSize: true,
		webPreferences: {
			session: isolated,
			offscreen: true,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			disableDialogs: true,
			backgroundThrottling: false,
			spellcheck: false,
		},
	});
	const contents = window.webContents;
	const result: WebInspection = { exceptions: [], errors: [], width, height: 720 };
	let frame: NativeImage | undefined;
	const latest = () => frame;
	contents.on("paint", (_event, _dirty, image) => {
		frame = image;
	});
	contents.setAudioMuted(true);
	contents.setWindowOpenHandler(() => ({ action: "deny" }));
	contents.on("will-navigate", (event) => event.preventDefault());
	contents.on("will-redirect", (event) => event.preventDefault());
	contents.on("console-message", (event) => {
		if (event.level !== "error") return;
		const errors = event.message.startsWith("Uncaught") ? result.exceptions : result.errors;
		if (errors.length < 20) errors.push(`${event.message.slice(0, 1000)} (${event.sourceId.split(/[?#]/)[0]?.split("/").pop() ?? ""}:${event.lineNumber})`);
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				await contents.loadURL(address.href);
				await pause(700);
				const height: unknown = await contents.executeJavaScript(
					options.measure ?? "Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)",
				);
				if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) throw new Error("The page did not report a valid height");
				result.height = Math.ceil(height);
				if (options.screenshot) {
					const top = Math.min(Math.round(from), result.height - 1);
					const tall = Math.min(result.height - top, 2160);
					window.setContentSize(width, tall);
					await contents.executeJavaScript(`window.scrollTo(0, ${top})`);
					result.shotTop = (await contents.executeJavaScript("Math.round(window.scrollY)")) as number;
					frame = undefined;
					contents.invalidate();
					const fits = (image: NativeImage) => {
						const size = image.getSize();
						return size.width > 0 && Math.abs((size.height * width) / size.width - tall) < 2;
					};
					for (let elapsed = 0; (!frame || !fits(frame)) && elapsed < 2000; elapsed += 50) await pause(50);
					const shot = latest();
					if (!shot || !fits(shot)) throw new Error("The page did not paint a screenshot");
					result.shotHeight = result.shotTop < top ? result.height - result.shotTop : tall;
					result.screenshot = { data: shot.resize({ width }).toPNG().toString("base64"), mimeType: "image/png" };
				}
				return result;
			})(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Page inspection timed out")), 12_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
		window.destroy();
		await isolated.clearStorageData();
	}
}
