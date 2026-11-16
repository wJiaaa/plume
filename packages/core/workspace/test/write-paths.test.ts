/**
 * `resolveWritePath`：模型要写的路径怎么解析；`writesAppData`：哪些写入在改 Plume 自己的目录、要人亲自点头。
 *
 * 哪里都照样解析（交给审批去问）；Plume 自己的目录（`~/.plume` 和数据目录）不拒，只是写之前只认人答。
 */

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveWritePath, writesAppData, type WriteScope } from "../src/paths.ts";

const HOME = join(tmpdir(), "plume-paths-home");
const CWD = join(tmpdir(), "plume-paths-project");
const at = (cwd: string, scratchDirs: readonly string[] = []): WriteScope => ({ cwd, scratchDirs, dataDir: HOME });

it("工作区里的路径，相对的绝对的都解析", () => {
	expect(resolveWritePath(at(CWD), "src/index.ts")).toBe(join(CWD, "src/index.ts"));
	expect(resolveWritePath(at(CWD), join(CWD, "a/b.txt"))).toBe(join(CWD, "a/b.txt"));
	expect(resolveWritePath(at(CWD), ".")).toBe(resolve(CWD));
});

/** 工作区外不在这里拒，交给工具发起的审批；这里只负责解析成绝对路径。 */
it("工作区外的路径照样解析，留给审批", () => {
	expect(resolveWritePath(at(CWD), "/etc/passwd")).toBe(resolve("/etc/passwd"));
	expect(resolveWritePath(at(CWD), "../sibling/file.ts")).toBe(resolve(CWD, "../sibling/file.ts"));
	expect(resolveWritePath(at(CWD), "~/Desktop/notes.md")).toBe(join(homedir(), "Desktop/notes.md"));
});

/**
 * 设置、会话、插件都在数据目录里：写得到它们的工具能改掉自己的权限，所以要人亲自点头。`..` 绕回来的也一样；
 * 不拒：拒了模型会改用 shell 写，卡上没有 diff。
 */
it("应用自己的目录照样解析，算作改 Plume 的数据目录", async () => {
	for (const path of [
		join(HOME, "settings.json"),
		join(HOME, "sessions/x.jsonl"),
		join(HOME, "scratch/../settings.json"),
		join(HOME, "plugins", "waza", "skills", "check", "SKILL.md"),
		join(homedir(), ".plume", "settings.json"),
	]) {
		expect(resolveWritePath(at(CWD), path), path).toBe(resolve(path));
		expect(await writesAppData(at(CWD), resolve(path)), path).toBe(true);
	}
	expect(await writesAppData(at(CWD), join(CWD, "src", "index.ts"))).toBe(false);
	expect(await writesAppData(at(CWD), join(homedir(), "Desktop", "notes.md"))).toBe(false);
});

/** 系统提示词让模型把不该进项目的文件放进会话的临时目录：数据目录里只有这一块写了不用人亲自点头，同一棵会话树的算在一起。 */
it("这棵会话树的临时目录不算，别的会话的算", async () => {
	const tree = [join(HOME, "scratch", "parent"), join(HOME, "scratch", "child")];
	expect(await writesAppData(at(CWD, tree), join(HOME, "scratch", "parent", "probe.py"))).toBe(false);
	expect(await writesAppData(at(CWD, tree), join(HOME, "scratch", "child", "report.md"))).toBe(false);
	expect(await writesAppData(at(CWD, tree), join(HOME, "scratch", "other", "a.md"))).toBe(true);
});

it("没给路径是错误，不是工作区根", () => {
	expect(() => resolveWritePath(at(CWD), "")).toThrow(/A path is required/);
});

it("工作区本身在应用目录下时照样能写，不算改 Plume 的数据目录", async () => {
	const cwd = join(HOME, "git-views", "proj");
	expect(resolveWritePath(at(cwd), "a.ts")).toBe(join(cwd, "a.ts"));
	expect(await writesAppData(at(cwd), join(cwd, "a.ts"))).toBe(false);
});

it.skipIf(process.platform !== "win32")("写入认读取认的那些 Windows shell 写法", () => {
	// 读取侧早就认 Git Bash 的 `/c/…` 和 PowerShell 的 `~\`，写入侧只认 `~/`，同一个文件读得到、改不了。
	const cwd = "C:\\work\\proj";
	expect(resolveWritePath(at(cwd), "/c/work/proj/a.ts")).toBe("C:\\work\\proj\\a.ts");
	expect(resolveWritePath(at(cwd), "~\\notes.txt")).toBe(join(homedir(), "notes.txt"));
});
