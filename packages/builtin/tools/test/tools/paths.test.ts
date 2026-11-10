/**
 * `resolveWorkspacePath`：模型要写的路径怎么解析，哪里不写。
 *
 * 工作区外照样解析（交给审批去问）；只有 Plume 自己的目录（`~/.plume` 和数据目录）不写。
 */

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { setDataDir } from "../../src/tools/home.ts";
import { resolveWorkspacePath } from "../../src/tools/paths.ts";

const HOME = join(tmpdir(), "plume-paths-home");
setDataDir(HOME);

const CWD = join(tmpdir(), "plume-paths-project");

it("工作区里的路径，相对的绝对的都解析", () => {
	expect(resolveWorkspacePath(CWD, "src/index.ts")).toBe(join(CWD, "src/index.ts"));
	expect(resolveWorkspacePath(CWD, join(CWD, "a/b.txt"))).toBe(join(CWD, "a/b.txt"));
	expect(resolveWorkspacePath(CWD, ".")).toBe(resolve(CWD));
});

/** 工作区外不在这里拒，交给工具发起的审批；这里只负责解析成绝对路径。 */
it("工作区外的路径照样解析，留给审批", () => {
	expect(resolveWorkspacePath(CWD, "/etc/passwd")).toBe(resolve("/etc/passwd"));
	expect(resolveWorkspacePath(CWD, "../sibling/file.ts")).toBe(resolve(CWD, "../sibling/file.ts"));
	expect(resolveWorkspacePath(CWD, "~/Desktop/notes.md")).toBe(join(homedir(), "Desktop/notes.md"));
});

/** 设置、会话都在数据目录里：写得到它们的工具能改掉自己的权限。`..` 绕回来的也一样。 */
it("应用自己的数据目录不写", () => {
	for (const bad of [join(HOME, "settings.json"), join(HOME, "sessions/x.jsonl"), join(HOME, "scratch/../settings.json")]) {
		expect(() => resolveWorkspacePath(CWD, bad), bad).toThrow(/Plume's own data directory/);
	}
});

/** 系统提示词让模型把不该进项目的文件放进会话的临时目录：数据目录里只有这一块能写。 */
it("会话的临时目录能写", () => {
	expect(resolveWorkspacePath(CWD, join(HOME, "scratch", "s1", "probe.py"))).toBe(join(HOME, "scratch", "s1", "probe.py"));
});

it("没给路径是错误，不是工作区根", () => {
	expect(() => resolveWorkspacePath(CWD, "")).toThrow(/A path is required/);
});

/** 「能不能看」在 `read-access.ts`，这里只回答「能不能改」：应用自己的目录写不进去，插件和技能文件也不行。 */
it("应用目录里什么都不写，技能文件也一样", () => {
	for (const bad of [
		join(HOME, "plugins", "waza", "skills", "check", "references", "mode-audit.md"),
		join(HOME, "skills", "ui", "SKILL.md"),
		join(HOME, "plugins", "waza", "manifest.json"),
		join(HOME, "settings.json"),
	]) {
		expect(() => resolveWorkspacePath(CWD, bad), bad).toThrow(/Plume's own data directory/);
	}
});

it("工作区本身在应用目录下时照样能写", () => {
	const cwd = join(HOME, "git-views", "proj");
	expect(resolveWorkspacePath(cwd, "a.ts")).toBe(join(cwd, "a.ts"));
});

it.skipIf(process.platform !== "win32")("写入认读取认的那些 Windows shell 写法", () => {
	// 读取侧早就认 Git Bash 的 `/c/…` 和 PowerShell 的 `~\`，写入侧只认 `~/`，同一个文件读得到、改不了。
	const cwd = "C:\\work\\proj";
	expect(resolveWorkspacePath(cwd, "/c/work/proj/a.ts")).toBe("C:\\work\\proj\\a.ts");
	expect(resolveWorkspacePath(cwd, "~\\notes.txt")).toBe(join(homedir(), "notes.txt"));
});
