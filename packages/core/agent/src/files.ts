/**
 * 文件面板要的两件事：读会话工作目录或项目源目录里的一个文件，以及把回复里写得不全的路径找成真实的文件。
 *
 * 放在 agent 进程而不是渲染进程：渲染进程能写出任何路径，这里先问它在不在会话的工作目录里，过了检查
 * 才读，读的就是检查过的那个路径——检查和打开之间不换字符串。
 */

import { execFile } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { tmpdir } from "node:os";
import { backup, DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { text } from "./i18n.ts";
import type { FileContents, FileEntry } from "@plume/contract";

/** 够看源码和文本文件，又不至于把生成出来的大文件整个塞进界面。 */
const FILE_READ_CAP = 512 * 1024;

/** 看开头这么多字节里有没有 NUL，有就当二进制。 */
const BINARY_SNIFF = 8000;

/** 同名文件再多也只列这么几个：调用方只认唯一的那一个，多出来的数目没有用处。 */
const LOCATE_LIMIT = 8;

/**
 * 不是 git 仓库时最多走这么多个文件。两万个文件的工程走一遍几十毫秒；这道上限防的是把整个家目录当工作
 * 目录，那样一走就是好几秒，找到的也多半不是那一个。
 */
const WALK_CAP = 50_000;

/** 自己走目录时跳过的：依赖、构建产物、缓存。里面同名的文件不是回复说的那一个。 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".turbo",
	".cache",
	"Pods",
	".gradle",
	".expo",
]);

/** 会把 git 指到别的仓库去的环境变量：从别处继承来的 `GIT_DIR` 会让它列出另一个仓库的文件。 */
const REDIRECTING = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_PREFIX",
];

const execFileAsync = promisify(execFile);

/** 网络共享和设备路径：`\\server\…`、`//server/…`、`\\?\…`。 */
const isRemoteOrDevicePath = (path: string) => /^[\\/]{2}/.test(path);
const isDevicePath = (path: string) => /^[\\/]{2}[?.][\\/]/.test(path);

/**
 * 另一台机器上的路径能不能碰，在任何 IO 之前按字面决定。
 *
 * 下面的 `realpath` 已经是 IO：在 Windows 上解析 `\\host\share\a.png` 会连上那台主机、把用户的 NTLM 凭据
 * 递过去，回复里写一个 `\\evil\s\a.png` 就能在边界检查之前漏出去。只有工作目录自己就在那个共享上时才放行；
 * 设备路径一律不放。
 */
function remotePathAllowed(target: string, root: string): boolean {
	if (!isRemoteOrDevicePath(target)) return true;
	if (isDevicePath(target) || !isRemoteOrDevicePath(root) || isDevicePath(root)) return false;
	const rel = win32.relative(win32.resolve(root), win32.resolve(target));
	return rel === "" || (rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel));
}

/** `child` 在不在 `parent` 之下（含它自己）。按 `relative` 判断，`/a/bc` 不算在 `/a/b` 下面。 */
export function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 允许读取的目录里的这个路径，解析过软链的真实路径；出了这些目录时是 null。
 *
 * 两边都先解析软链再比：目录里一个指向 `/etc` 的软链不能借道出去，`..` 也在这一步被解掉。
 */
async function resolveInsideCwd(cwd: string, target: string, projectRoots: readonly string[] = []): Promise<string | null> {
	if (typeof target !== "string" || !target || target.includes("\0")) return null;
	const full = isAbsolute(target) || isRemoteOrDevicePath(target) ? target : join(cwd, target);
	const allowed = [cwd, ...projectRoots];
	if (!allowed.some((root) => remotePathAllowed(full, root))) return null;
	const [real, roots] = await Promise.all([realpath(full).catch(() => null), Promise.all(allowed.map((root) => realpath(root).catch(() => null)))]);
	if (!real || !roots.some((root) => root && isInside(root, real))) return null;
	return resolve(real);
}

/** 读工作目录里的一个文件给界面看。不在目录里、不存在、不是文件都返回 null。 */
export async function readSessionFile(cwd: string, target: string, projectRoots: readonly string[] = []): Promise<FileContents | null> {
	const path = await resolveInsideCwd(cwd, target, projectRoots);
	return path ? readContents(path) : null;
}

/**
 * 会话最近一次请求的提示词里标出来源的文件（`PromptSection.files`，「记忆文件」列的那几个），在会话边界外也给界面只读看：
 * 工作目录上层的指令文件、插件数据目录里的项目记忆。它们已经整段发给了模型，打开看不多暴露什么。不放宽别处：只认 `listed`
 * 里的路径，两边解析软链后比；`listed` 是宿主从那次请求记下的，界面编一个路径进来也只能读到这几个。只读：写、改名、列目录都不经这里。
 */
export async function readListedFile(listed: readonly string[], target: string): Promise<FileContents | null> {
	const absolute = (path: string) => typeof path === "string" && isAbsolute(path) && !isRemoteOrDevicePath(path) && !path.includes("\0");
	if (!absolute(target) || !listed.some((path) => resolve(path) === resolve(target))) return null;
	const [real, allowed] = await Promise.all([
		realpath(target).catch(() => null),
		Promise.all(listed.filter(absolute).map((path) => realpath(path).catch(() => null))),
	]);
	return real && allowed.includes(real) ? readContents(real) : null;
}

async function readContents(path: string): Promise<FileContents | null> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) return null;

	// 只读要显示的那一段。整个读进来再截，打开一个几个 G 的日志会先把它全部拉进内存。
	const buffer = await readHead(path, FILE_READ_CAP);
	if (!buffer) return null;
	if (buffer.subarray(0, BINARY_SNIFF).includes(0)) {
		return { text: "", truncated: false, bytes: info.size, binary: true, modifiedAt: info.mtimeMs };
	}
	return { text: buffer.toString("utf8"), truncated: info.size > FILE_READ_CAP, bytes: info.size, modifiedAt: info.mtimeMs };
}

/** 文档解析需要完整数据；读取前后都核对同一个打开的文件，防止预览拼出两个版本。 */
export async function readSessionFileBytes(
	cwd: string,
	target: string,
	modifiedAt: number | undefined,
	signal: AbortSignal,
	projectRoots: readonly string[] = [],
): Promise<Uint8Array> {
	signal.throwIfAborted();
	const path = await sessionFilePath(cwd, target, projectRoots);
	if (!path) throw new Error(text("files.unreadable"));
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(text("files.unreadable"));
		if (before.size > 64 * 1024 * 1024) throw new Error(text("files.tooLarge"));
		if (modifiedAt !== undefined && before.mtimeMs !== modifiedAt) throw new Error(text("files.changed"));
		const data = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < data.length) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(data, offset, Math.min(1024 * 1024, data.length - offset), offset);
			if (!bytesRead) throw new Error(text("files.changed"));
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(text("files.changed"));
		signal.throwIfAborted();
		// SQLite 的最新提交可能还在 WAL，不能把主文件的旧字节当成当前数据库。
		if (data.subarray(0, 16).toString() === "SQLite format 3\0") {
			const directory = await mkdtemp(join(tmpdir(), "plume-database-preview-"));
			let database: DatabaseSync | undefined;
			try {
				database = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
				const snapshot = join(directory, "snapshot.db");
				const copying = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
				await backup(database, snapshot, { progress: () => copying.throwIfAborted() });
				signal.throwIfAborted();
				if ((await stat(snapshot)).size > 64 * 1024 * 1024) throw new Error(text("files.tooLarge"));
				return await readFile(snapshot, { signal });
			} finally {
				database?.close();
				await rm(directory, { recursive: true, force: true });
			}
		}
		return data;
	} finally {
		await handle.close();
	}
}

/**
 * 工作目录里这个文件的真实路径，给主进程按路径发图片、PDF、音视频（`plume-media://f/…`）。
 *
 * 和 `readSessionFile` 是同一道检查：不在目录里、不存在、不是文件都返回 null。主进程拿到的是解析过软链的
 * 路径，直接读它，不再拿界面给的字符串去打开。
 */
export async function sessionFilePath(cwd: string, target: string, projectRoots: readonly string[] = []): Promise<string | null> {
	const path = await resolveInsideCwd(cwd, target, projectRoots);
	if (!path) return null;
	const info = await stat(path).catch(() => null);
	return info?.isFile() ? path : null;
}

/** 文件开头的 `limit` 个字节；打不开时是 null。 */
async function readHead(path: string, limit: number): Promise<Buffer | null> {
	const handle = await open(path, "r").catch(() => null);
	if (!handle) return null;
	try {
		const buffer = Buffer.allocUnsafe(limit);
		// 一次 `read` 可能读不满（网络文件系统会这样），一直读到文件尾或上限。
		let filled = 0;
		while (filled < limit) {
			const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		return buffer.subarray(0, filled);
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => {});
	}
}

/**
 * 回复里写的一条相对路径，在工作目录里实际指的是哪个文件，返回绝对路径。
 *
 * 模型常把文件写成 `approvals.ts:125`、`scripts/check.mjs`——前者只有名字，后者相对的是某个子包而不是
 * 工作目录。按工作目录直接拼，点开的是一个不存在的文件。这里先按原样找，找不到再在目录的文件里按结尾
 * 匹配，由调用方决定只有一个匹配时才认。文件夹带着结尾的 `/` 交回去，界面凭它画文件夹图标。
 */
export async function locateSessionFiles(cwd: string, written: string): Promise<string[]> {
	if (typeof written !== "string") return [];
	const clean = written.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
	// 通配符、走出目录的 `..`，都不是「回复里提到的一个文件」。
	if (!clean || isAbsolute(clean) || /[*?[\]]/.test(clean) || clean.split("/").includes("..")) return [];
	// 在解析过软链的真实目录里找，拼回会话自己写的那个目录：界面拿它和工作目录比对。
	const root = await realpath(cwd).catch(() => null);
	if (!root) return [];
	// `join` 保留结尾的分隔符，文件夹的 `/` 跟着回去。
	const back = (found: readonly string[]) => found.map((path) => join(cwd, path));

	const there = await stat(join(root, clean)).catch(() => null);
	if (there?.isFile()) return back([clean]);
	if (there?.isDirectory()) return back([`${clean}/`]);

	const files = await projectFiles(root);
	if (files === null) {
		// 仓库大到列不完：只问这一个名字，让 git 按 pathspec 找，仍然认 .gitignore。文件夹这时只认按原样拼得上的。
		const listed = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `:(glob)**/${clean}`]).catch(() => "");
		return back([...new Set(listed.split("\0").filter(Boolean))].sort().slice(0, LOCATE_LIMIT));
	}
	const named = files.filter((path) => path === clean || path.endsWith(`/${clean}`));
	return back([...new Set(named.length ? named : foldersNamed(files, clean))].sort().slice(0, LOCATE_LIMIT));
}

/** 清单里只有文件，文件夹从路径里认：`a/packages/ui/src/x.ts` 里有一个叫 `packages/ui` 的文件夹。 */
function foldersNamed(files: readonly string[], name: string): string[] {
	const folders: string[] = [];
	for (const path of files) {
		const inner = path.indexOf(`/${name}/`);
		const at = path.startsWith(`${name}/`) ? 0 : inner < 0 ? -1 : inner + 1;
		if (at >= 0) folders.push(`${path.slice(0, at + name.length)}/`);
	}
	return folders;
}

/*
 * 同一个目录同时只列一遍：一段长对话里几十个只写了名字的链接是一起挂上来的。走完就丢，不留缓存：文件
 * 可能是回复提到之后才写出来的，记住旧清单就再也找不到它。
 */
const listing = new Map<string, Promise<string[] | null>>();

function projectFiles(root: string): Promise<string[] | null> {
	let list = listing.get(root);
	if (!list) {
		list = listFiles(root).finally(() => listing.delete(root));
		listing.set(root, list);
	}
	return list;
}

/**
 * 交给 git 列：它认 .gitignore，依赖和构建产物里的同名文件不会混进来。不是 git 仓库、没装 git 时自己走目录。
 *
 * `null`：清单超出了输出上限（几十万个文件）。这时不退回走目录——那不认 .gitignore——由调用方逐个名字去问 git。
 */
async function listFiles(root: string): Promise<string[] | null> {
	try {
		return (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
	} catch (error) {
		return (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? null : walkFiles(root);
	}
}

/**
 * 宿主进程里对工作区仓库跑 git。工作区是沙箱可写的，`.git/config` 里写的程序 git 会替它在宿主上执行，而这里
 * 是回复一画出来就自动调的，不用人点。
 *
 * 临时做法：只压住这里用到的两条命令（`ls-files --cached --others --exclude-standard`，带或不带 pathspec）
 * 碰得到的执行点。完整的办法是 plume.tools 的 `host-git.ts` 那种隔离视图（git 读不到仓库配置），等它收进本体后换掉这里。
 *
 * - `core.fsmonitor`：任何一次读 index 都会执行，这两条命令都读 index。`-c` 的优先级高于仓库配置和它 include 的文件。
 * - 钩子：`ls-files` 不写 index，不触发 `post-index-change`；`core.hooksPath` 指空仍然压上，防以后改了命令。
 * - 惰性拉取（partial clone 的 promisor 远端，会经 `core.sshCommand`、`remote.*.uploadpack` 起程序）：
 *   `--exclude-standard` 遇到 skip-worktree 的 `.gitignore` 会从 index 里的 blob 读，sparse index 展开要读树，
 *   对象缺了就去拉。`GIT_NO_LAZY_FETCH`（git 2.44 起）关掉它，更老的 git 不认这个变量，这一点压不住。
 * - `filter.<名>.*`、`diff.<名>.textconv`、`diff.external`：驱动名由仓库自取，`-c` 压不住；但这两条命令只列
 *   index 里的路径和没跟踪的文件名，不算工作区文件的哈希、不生成补丁、不读属性，碰不到它们。
 * - 分页器：输出不是终端，git 不起分页器。
 */
async function git(cwd: string, args: string[]): Promise<string> {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
	for (const name of REDIRECTING) delete env[name];
	const guarded = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args];
	const { stdout } = await execFileAsync("git", guarded, { cwd, env, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 });
	return stdout;
}

/** `root` 之下的文件，相对 `root`、用 `/` 分隔。不跟软链：一个指回上层的链接会让它绕不出来。 */
async function walkFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		if (files.length >= WALK_CAP) return;
		const entries: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(() => []);
		const below: Promise<void>[] = [];
		for (const entry of entries) {
			const full = join(dir, entry.name);
			// 隐藏目录也跳过：没有 .gitignore 兜着，`.venv`、`.idea` 里同名的文件不是回复说的那一个。
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) below.push(visit(full));
			} else if (entry.isFile() && files.length < WALK_CAP) {
				files.push(relative(root, full).split(sep).join("/"));
			}
		}
		await Promise.all(below);
	};
	await visit(root);
	return files;
}

export async function listSessionDirectory(cwd: string, target: string, projectRoots: readonly string[] = []): Promise<FileEntry[]> {
	const path = await resolveInsideCwd(cwd, target, projectRoots);
	if (!path) throw new Error(text("files.unreadable"));
	const entries = await readdir(path, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory() || entry.isFile())
		.map((entry) => ({
			name: entry.name,
			path: join(target, entry.name),
			isDirectory: entry.isDirectory(),
		}))
		.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}
