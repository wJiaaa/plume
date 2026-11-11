/**
 * Windows 上，用户装的插件的原生模块（`.node`）复制一份再加载。
 *
 * Windows 把加载着的 DLL（`.node` 就是）锁住：进程活着就删不掉、改不了名，连它所在的目录也挪不动。终端插件的
 * node-pty 一加载，插件市场更新、卸载这个插件就整个被拒，只能退出 Plume 再来。所以 agent 进程加载
 * 插件目录里的 `.node` 时，先按内容的 sha256 复制到数据目录的 `native-cache/<sha256>/` 下，加载那一份：插件目录里的
 * 文件谁都没开着，换版本就是换目录；内容一样的不重复复制，内容变了（插件更新）就是另一个目录，旧的那份照常被锁着、不碍事。
 *
 * 只管用户的插件（市场的安装目录、本地上传的目录，由主进程经 `PLUME_NATIVE_ROOTS` 传来）：随应用发的内置插件
 * 在资源目录里，不会在 Plume 开着时被换掉。macOS、Linux 不锁加载着的文件，不用复制。
 *
 * 同目录的 `.dll`、`.exe` 一起复制：原生模块会从自己旁边加载 DLL、起程序（node-pty 的 pty.node 链接着 winpty.dll，
 * winpty.dll 再从自己旁边起 winpty-agent.exe），只复制 `.node` 的话那一份在新目录里找不到它们。子目录和调试符号（`.pdb`）
 * 不复制：用不到（node-pty 只在显式开 `useConptyDll` 时才读 `conpty/`），平白多几十 MB。
 *
 * 旧版本的副本不清理：被锁着的删不掉，不锁的也不知道还有没有进程要用。插件更新多了以后它会越积越多，到时按最后使用时间
 * 在启动时清。
 *
 * 不引用 electron，测试才能直接加载它。
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync } from "node:fs";
import { win32 } from "node:path";

/** 读文件、复制文件的几步，测试里换掉。 */
export interface NativeCacheIo {
	/** 文件内容的 sha256（十六进制）。 */
	hash(file: string): string;
	exists(path: string): boolean;
	/** 和 file 在同一个目录、要跟它一起复制的文件（不含它自己）。 */
	siblings(file: string): string[];
	/** 把这些文件放进 dir：做好之前别人看不到 dir。 */
	place(files: string[], dir: string): void;
}

export interface NativeCacheOptions {
	platform: string;
	/** 里面的 `.node` 要复制再加载的目录。 */
	roots: string[];
	/** 副本放在哪：`<数据目录>/native-cache`。 */
	cacheDir: string;
	io?: NativeCacheIo;
	warn?: (message: string) => void;
}

/** 跟着 `.node` 一起复制的同目录文件。 */
const COMPANION = /\.(dll|exe)$/i;

const realIo: NativeCacheIo = {
	hash(file) {
		// 一块一块读：原生模块的 `.node` 可能有几百 MB，不整个读进内存。
		const digest = createHash("sha256");
		const buffer = Buffer.alloc(1 << 20);
		const fd = openSync(file, "r");
		try {
			for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) digest.update(buffer.subarray(0, read));
		} finally {
			closeSync(fd);
		}
		return digest.digest("hex");
	},
	exists: existsSync,
	siblings(file) {
		const dir = win32.dirname(file);
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && COMPANION.test(entry.name))
			.map((entry) => win32.join(dir, entry.name));
	},
	place(files, dir) {
		// 先复制进旁边的临时目录再整个改名过去：两个进程同时加载时，谁都不会拿到复制到一半的。
		const staging = `${dir}.${randomUUID()}.tmp`;
		mkdirSync(staging, { recursive: true });
		try {
			for (const file of files) copyFileSync(file, win32.join(staging, win32.basename(file)));
			renameSync(staging, dir);
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			// 别的进程抢先放好了，用它的。
			if (!existsSync(dir)) throw error;
		}
	},
};

/** Node 传给 dlopen 的是 `\\?\C:\…` 这种带命名空间前缀的路径，比较之前去掉。 */
function plainPath(file: string): string {
	if (file.startsWith("\\\\?\\UNC\\")) return `\\\\${file.slice(8)}`;
	if (file.startsWith("\\\\?\\")) return file.slice(4);
	return file;
}

function inside(root: string, file: string): boolean {
	const rel = win32.relative(root, file);
	return rel !== "" && !rel.startsWith("..") && !win32.isAbsolute(rel);
}

/** 这个 `.node` 实际该加载哪个文件：不用复制的原样返回，要复制的返回副本。 */
export function nativeLoadPath(filename: string, options: NativeCacheOptions): string {
	if (options.platform !== "win32" || !filename.toLowerCase().endsWith(".node")) return filename;
	const file = plainPath(filename);
	if (!options.roots.some((root) => inside(root, file))) return filename;
	const io = options.io ?? realIo;
	try {
		const dir = win32.join(options.cacheDir, io.hash(file));
		const copy = win32.join(dir, win32.basename(file));
		if (!io.exists(copy)) io.place([file, ...io.siblings(file)], dir);
		return win32.toNamespacedPath(copy);
	} catch (error) {
		// 复制不了（磁盘满、没权限）就加载原来那份：插件照常能用，只是更新、卸载它要等退出 Plume。
		// i18n-exempt：只进日志。
		(options.warn ?? console.warn)(`原生模块没能复制到 ${options.cacheDir}，直接加载原文件：${String(error)}`);
		return filename;
	}
}

type Dlopen = (module: object, filename: string, ...rest: number[]) => void;

/** 让 target（就是 `process`）之后加载的 `.node` 都先经过 nativeLoadPath。只在 Windows 上换。 */
export function redirectNativeLoads(target: { dlopen: Dlopen }, options: NativeCacheOptions): void {
	if (options.platform !== "win32") return;
	const dlopen = target.dlopen.bind(target);
	// flags 原样转过去：没传和传 undefined 对 dlopen 不一样。
	target.dlopen = (module, filename, ...rest) => dlopen(module, nativeLoadPath(filename, options), ...rest);
}
