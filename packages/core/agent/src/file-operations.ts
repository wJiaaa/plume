/** 文件树修改统一在会话边界内执行，先验证整批路径；替换失败时还原原目标。 */
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileOperation, FileOpResult } from "@plume/contract";
import { text } from "./i18n.ts";

const inside = (root: string, path: string) => {
	const rel = relative(root, path);
	return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function validFileName(name: string, platform = process.platform): boolean {
	if (typeof name !== "string" || !name || name !== name.trim() || name === "." || name === ".." || /[\0/\\]/.test(name) || Buffer.byteLength(name) > 255)
		return false;
	return platform !== "win32" || (!/[\x00-\x1f"*:<>?|]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name));
}

export function uniqueFileName(taken: Iterable<string>, name: string): string {
	const used = new Set(taken);
	if (!used.has(name)) return name;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : "";
	for (let n = 1; ; n++) {
		const candidate = `${stem} copy${n === 1 ? "" : ` ${n}`}${extension}`;
		if (!used.has(candidate)) return candidate;
	}
}

// 两个面板的检查、替换和回滚不能交错，否则后来的请求可能覆盖刚创建的同名文件。
let operations: Promise<unknown> = Promise.resolve();
export function operateSessionFile(
	cwd: string,
	operation: FileOperation,
	projectRoots: readonly string[] = [],
	trash?: (path: string) => Promise<void>,
): Promise<FileOpResult> {
	const next = operations.then(() => operate(cwd, operation, projectRoots, trash));
	operations = next.catch(() => {});
	return next;
}

async function operate(cwd: string, operation: FileOperation, projectRoots: readonly string[], trash?: (path: string) => Promise<void>): Promise<FileOpResult> {
	const completed: string[] = [];
	try {
		const allowed = [cwd, ...projectRoots];
		const roots = (await Promise.all(allowed.map((root) => realpath(root).catch(() => null)))).filter((root): root is string => root !== null);
		const denied = () => {
			throw new Error(text("files.outsideProject"));
		};
		const pathFor = async (raw: string, existing: boolean, protectRoot = false): Promise<string> => {
			if (typeof raw !== "string" || !raw || raw.includes("\0") || /^[\\/]{2}/.test(raw)) return denied();
			const lexical = resolve(cwd, raw);
			if (![...allowed, ...roots].some((root) => inside(resolve(root), lexical))) return denied();
			const parent = await realpath(dirname(lexical));
			const path = allowed.some((root) => resolve(root) === lexical) ? await realpath(lexical) : join(parent, basename(lexical));
			// 根目录本身可以列举和接收新文件，不能被改名、替换或删除。
			if (!roots.some((root) => inside(root, path))) return denied();
			if (protectRoot && roots.some((root) => inside(path, root))) return denied();
			const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return null;
			});
			if (info?.isSymbolicLink() || (existing && !info)) return denied();
			return path;
		};
		const name = (value: string) => {
			if (!validFileName(value)) throw new Error(text("files.badName"));
		};
		const destination = async (raw: string) => {
			name(basename(raw));
			return pathFor(raw, false, true);
		};
		const exists = async (path: string) =>
			lstat(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return null;
			});
		const taken = (): FileOpResult => ({ ok: false, code: "exists", error: text("files.exists") });
		if (operation.type === "create" || operation.type === "unique") {
			name(operation.name);
			const dir = await pathFor(operation.directory, true);
			if (!(await stat(dir)).isDirectory()) return denied();
			if (operation.type === "unique") return { ok: true, path: join(resolve(cwd, operation.directory), uniqueFileName(await readdir(dir), operation.name)) };
			const path = join(dir, operation.name);
			if (await exists(path)) return taken();
			if (operation.kind === "directory") await mkdir(path);
			else if (operation.kind === "file") await writeFile(path, "", { flag: "wx" });
			else throw new Error(text("files.badName"));
			return { ok: true, path: join(resolve(cwd, operation.directory), operation.name) };
		}
		if (operation.type === "trash" || operation.type === "remove") {
			const paths = await Promise.all(operation.paths.map((path) => pathFor(path, true, true)));
			const top = [...new Set(paths)].filter((path) => !paths.some((other) => path !== other && inside(other, path)));
			for (const path of top) {
				if (operation.type === "trash") {
					if (!trash) throw new Error(text("files.trashUnavailable"));
					await trash(path);
				} else await rm(path, { recursive: true });
				completed.push(resolve(cwd, operation.paths[paths.indexOf(path)]!));
			}
			return { ok: true, paths: completed };
		}
		if (operation.type === "import") {
			const dir = await pathFor(operation.directory, true);
			if (!(await stat(dir)).isDirectory()) return denied();
			// 外部拖入只读源；不接收远程设备路径，不沿源目录中的软链读取。
			const sources = await Promise.all(
				operation.sources.map(async (raw) => {
					if (typeof raw !== "string" || !isAbsolute(raw) || raw.includes("\0") || /^[\\/]{2}/.test(raw)) return denied();
					if ((await lstat(raw)).isSymbolicLink()) return denied();
					const source = await realpath(raw);
					if (inside(source, dir)) throw new Error(text("files.copyIntoItself"));
					return source;
				}),
			);
			for (const source of sources) {
				const to = join(dir, uniqueFileName(await readdir(dir), basename(source)));
				await cp(source, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
				completed.push(join(resolve(cwd, operation.directory), basename(to)));
			}
			return { ok: true, path: completed.at(-1), paths: completed };
		}
		if (operation.type !== "rename" && operation.type !== "copy") return denied();
		const from = await pathFor(operation.from, true, operation.type === "rename");
		const to = await destination(operation.to);
		if (from === to && operation.type === "rename") return { ok: true, path: resolve(cwd, operation.to) };
		if (inside(from, to) || inside(to, from))
			return { ok: false, code: "descendant", error: text(operation.type === "copy" ? "files.copyIntoItself" : "files.moveIntoItself") };
		const target = await exists(to);
		const source = await lstat(from);
		if (target && target.ino === source.ino && target.dev === source.dev) {
			if (operation.type === "copy") return { ok: false, code: "descendant", error: text("files.copyIntoItself") };
			await rename(from, to);
			return { ok: true, path: resolve(cwd, operation.to) };
		}
		if (target && !operation.overwrite) return taken();
		let backup: string | undefined;
		try {
			if (target) {
				backup = await mkdtemp(join(dirname(to), ".plume-replace-"));
				await rename(to, join(backup, "original"));
			}
			try {
				if (operation.type === "copy") await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
				else await rename(from, to);
			} catch (error) {
				if (backup) {
					await rm(to, { recursive: true, force: true });
					await rename(join(backup, "original"), to);
				} else if (operation.type === "copy" && (error as NodeJS.ErrnoException).code !== "ERR_FS_CP_EEXIST") await rm(to, { recursive: true, force: true });
				throw error;
			}
		} finally {
			// 回滚失败时保留 original，不能在清理中删除最后一份用户数据。
			if (backup && !(await exists(join(backup, "original")))) await rm(backup, { recursive: true, force: true });
		}
		if (backup) await rm(backup, { recursive: true, force: true });
		return { ok: true, path: resolve(cwd, operation.to) };
	} catch (error) {
		return { ok: false, error: reason(error), paths: completed };
	}
}
