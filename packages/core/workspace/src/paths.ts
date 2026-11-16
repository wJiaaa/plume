/**
 * 模型写的路径指的是哪里、交给模型时怎么写，以及哪里要人亲自点头（Plume 自己的目录）。读边界（`read-access.ts`）和写边界
 * （这里的 `resolveWriteTarget`、`writesAppData`）都按这里解析出的绝对路径判定。
 */

import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withinOrIs } from "@plume/platform";

/** `~/x` as an absolute path, and anything already absolute resolved against the session's cwd. */
export function toAbsolute(cwd: string, input: string): string {
	const native = process.platform === "win32" ? windowsSpelling(input, homedir(), tmpdir()) : input;
	const expanded = native.startsWith("~/") || native === "~" ? native.replace("~", homedir()) : native;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * A path as a Windows shell spelled it, as the Windows path it names.
 *
 * On Windows the agent's commands run in Git Bash, which reads `/c/Users/me` as `C:\Users\me` and
 * `/tmp` as the user's temp directory. Node reads the same strings as `C:\c\Users\me` and `C:\tmp`
 * — paths that do not exist, and a path that does not exist is not asked about (`worthAsking`).
 * So `cat /c/Users/me/.ssh/id_ed25519` read the key without a question. `~\` is PowerShell's
 * spelling of the home directory, which only `~/` was expanded for.
 *
 * Pure, with the home and temp directories handed in, so it can be tested on any platform.
 */
export function windowsSpelling(input: string, homeDir: string, tempDir: string): string {
	const drive = /^(?:\/cygdrive)?\/([a-zA-Z])(?=\/|$)(.*)$/.exec(input);
	if (drive) return `${drive[1]!.toUpperCase()}:\\${drive[2]!.replace(/^[/]/, "").replaceAll("/", "\\")}`;
	const temp = /^\/tmp(?=\/|$)(.*)$/.exec(input);
	if (temp) return `${tempDir}${temp[1]!.replaceAll("/", "\\")}`;
	if (input === "~" || input.startsWith("~\\")) return `${homeDir}${input.slice(1)}`;
	return input;
}

/** 给模型看的路径：相对工作区根，出了工作区写绝对路径。 */
export function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute);
	if (rel === "") return ".";
	// `..x/a.ts` 是工作区里一个以 `..` 开头的目录，不是上一级。
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return absolute;
	return rel.split(sep).join("/");
}

/**
 * 写边界用到的几样：会话的工作目录，同一脉的会话的临时目录（`ToolRun.scratchDirs`，写进去不用问人），Plume 的数据目录（写进去要人点头）。
 * 附件（`ToolRun.allowedPaths`）不在里面：拖一个文件进来是「看看这个」，不是「可以改它」。
 */
export interface WriteScope {
	cwd: string;
	scratchDirs: readonly string[];
	dataDir: string;
}

/**
 * Plume 自己的目录：数据目录（模型设置和 API key、会话、插件和插件开关、命令），和缺省的 `~/.plume`（换了数据目录时它还在）。
 * 写得到它们，一次看起来和别的调用没两样的调用就能改掉自己的权限，所以写它们要人亲自点头，见 `writesAppData`。
 */
function appHomes(dataDir: string): string[] {
	return [join(homedir(), ".plume"), dataDir];
}

/**
 * 模型要**写**的路径，解析成绝对路径。哪里都不在这里拒：工作区外写的时候审批卡照样会问，Plume 自己的目录要人亲自点头
 * （`writesAppData`）。拒了的话，人说「存到桌面」「改一下 ~/.plume 里的设置」，模型会改用 `cat > … <<EOF`——一样写到那里，
 * 只是卡片上没有 diff、没有「先读再写」的检查。shell 不认的拒绝不是边界，只是绕路。
 */
export function resolveWritePath(scope: WriteScope, input: string): string {
	if (!input || typeof input !== "string") throw new Error("A path is required.");
	// 与读取侧同一套写法解析：Windows 上 `/c/…`、`~\` 读得到，写也得认。
	return toAbsolute(scope.cwd, input);
}

/** 在 Plume 自己的目录里——除非那就是工作区或同一脉的会话的临时目录（别的会话的临时目录算在里面：那是别的对话的草稿和原始输出）。 */
function insideAppHome(roots: string[], homes: string[], absolute: string): boolean {
	return homes.some((appHome) => withinOrIs(appHome, absolute)) && !roots.some((root) => withinOrIs(root, absolute));
}

/** 解析软链后的真实路径；还不存在的，取已有的上级目录的真实路径再拼回去。 */
async function canonical(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
		return resolve(await canonical(dirname(path)), basename(path));
	}
}

/**
 * 写 `target`（绝对路径）是不是在改 Plume 自己的目录：是的话这次写入只认人在卡上答，权限模式、「以后不再问」、帮我批准都不替人点头。
 * 两边都按真实路径比，链接借不了道。
 */
export async function writesAppData(scope: WriteScope, target: string): Promise<boolean> {
	const [real, root, scratch, homes] = await Promise.all([
		canonical(target),
		canonical(scope.cwd),
		Promise.all(scope.scratchDirs.map(canonical)),
		Promise.all(appHomes(scope.dataDir).map(canonical)),
	]);
	return insideAppHome([root, ...scratch], homes, real);
}

/**
 * 真正要写的那个文件：已有的父目录也取真实路径，同一个文件的几种写法排进同一个队，链接也到不了字面路径到不了的地方。
 */
export async function resolveWriteTarget(scope: WriteScope, input: string): Promise<string> {
	const absolute = resolveWritePath(scope, input);
	const target = await canonical(absolute);
	const [root, scratch] = await Promise.all([canonical(scope.cwd), Promise.all(scope.scratchDirs.map(canonical))]);
	/*
	 * A link that looks like it is in the workspace and lands outside it is still refused. The
	 * approval card names the path as written, so it would read "Edit notes.md" over a change to
	 * whatever the link points at. Writing the target by its own name asks with that name instead.
	 */
	const near = [scope.cwd, ...scope.scratchDirs].some((place) => withinOrIs(place, absolute));
	if (near && ![root, ...scratch].some((place) => withinOrIs(place, target))) {
		// i18n-exempt：发给模型的话。
		throw new Error(`${input} is a link to ${target}, outside the workspace. Write ${target} by that path instead, so the approval names what changes.`);
	}
	return target;
}
