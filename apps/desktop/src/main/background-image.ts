/** 会话背景图的安全校验和串行存储；渲染进程只上传字节，不把路径交给插件。 */
import { readdir, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { renameWithRetry } from "./rename-retry.ts";

const EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const NAME = /^chat-\d+(?:-\d+)*\.(?:png|jpe?g|gif|webp)$/;

type BackgroundImportError = "too-large" | "invalid" | "failed";
export type BackgroundImportResult = { name: string } | { error: BackgroundImportError };

/** 只接受支持的真实图片签名；能不能真的解码由 appearance.ts 用浏览器的解码器再确认（nativeImage 不支持 GIF）。 */
export function imageExtension(name: string, bytes: Uint8Array): "png" | "jpg" | "gif" | "webp" | null {
	const requested = extname(name).slice(1).toLowerCase();
	if (!EXTENSIONS.has(requested) || bytes.length < 4) return null;
	const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
	if (bytes.length >= 8 && png) return "png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
	const webp =
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50;
	if (webp) return "webp";
	return null;
}

function isBackgroundName(name: string): boolean {
	return NAME.test(name);
}

/** 文件写入、pending 保护和清理共用一条队列，避免同毫秒导入互相覆盖。 */
export class BackgroundImageStore {
	private serial: Promise<void> = Promise.resolve();
	private sequence = 0;
	private pending = new Set<string>();

	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.serial.then(work);
		this.serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	import(bytes: Uint8Array, extension: "png" | "jpg" | "gif" | "webp"): Promise<BackgroundImportResult> {
		return this.enqueue(async () => {
			await mkdir(this.directory, { recursive: true });
			const name = `chat-${Date.now()}-${process.pid}-${++this.sequence}.${extension}`;
			const temporary = join(this.directory, `.${name}.${process.pid}.${this.sequence}.part`);
			this.pending.add(name);
			try {
				await writeFile(temporary, bytes);
				// 刚写完的文件 Windows 上可能还被杀毒软件开着，改名要等一等（见 rename-retry.ts）。
				await renameWithRetry(temporary, join(this.directory, name));
				return { name };
			} catch {
				this.pending.delete(name);
				await rm(temporary, { force: true }).catch(() => undefined);
				return { error: "failed" };
			}
		});
	}

	read(name: string): Promise<Buffer | null> {
		return this.serial.then(() => readFile(join(this.directory, name)).catch(() => null));
	}

	/** 成功写入外观引用后提交新图，并只清理此刻未引用且非 pending 的旧图。 */
	commit(keep?: string): Promise<void> {
		return this.enqueue(async () => {
			if (keep) this.pending.delete(keep);
			const names = await readdir(this.directory).catch(() => [] as string[]);
			await Promise.all(
				names
					.filter((name) => isBackgroundName(name) && name !== keep && !this.pending.has(name))
					.map((name) => rm(join(this.directory, name), { force: true })),
			);
		});
	}

	/** 仅清理未引用文件；当前引用和仍待提交的导入都保留。 */
	cleanup(keep?: string): Promise<void> {
		return this.commit(keep);
	}
}
