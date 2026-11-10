/**
 * 读的边界：一条规则，几个入口。
 *
 * read、ls、grep、glob 问「这个文件能不能读」，得到的必须是同一个答案：一个工具拒了、换个工具读得到，
 * 模型就学会去绕。这里测判定本身（`assessRead`）、批准覆盖多大（`readGrantRoot`），以及每个读文件的工具
 * 都经 `authorizeRead` 这一道门。
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, expect, it, onTestFinished } from "vitest";
import { assessRead, authorizeCommandReads, commandReadTargets, readGrantRoot, toAbsolute } from "../../src/tools/read-access.ts";
import { isReadOnlyCommand } from "../../src/read-only-command.ts";
import { bashTool } from "../../src/tools/bash.ts";
import { localSandbox } from "../sandbox.ts";
import { windowsSpelling } from "../../src/tools/paths.ts";
import { home, scratchHome } from "../../src/tools/home.ts";
import { readTool } from "../../src/tools/read.ts";
import { lsTool } from "../../src/tools/ls.ts";
import { grepTool } from "../../src/tools/grep.ts";
import { globTool } from "../../src/tools/glob.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";

type ApprovalContent = Parameters<NonNullable<ToolContext["requestApproval"]>>[0];
type Decision = "once" | "always" | "reject";

/*
 * 家目录借一间空屋，不碰跑测试那个人的真家目录：下面要在 `~/.ssh` 下摆密钥。
 *
 * 不能开在临时目录里：临时区按设计就是可读的，开在那里「项目之外要先问」的断言全成空话。所以它开在
 * 真家目录底下，是一个新建的空目录，跑完连它一起删掉。git 也拦在门口：有人的家目录本身就是仓库，
 * 不设天花板，git 会一路往上找到它。
 */
const HOME = await mkdtemp(join(homedir(), ".plume-read-access-home-"));
const borrowed = ["HOME", "USERPROFILE", "GIT_CEILING_DIRECTORIES"] as const;
const saved = new Map(borrowed.map((key) => [key, process.env[key]]));
for (const key of borrowed) process.env[key] = HOME;
afterAll(async () => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
if (home() !== HOME) {
	await rm(HOME, { recursive: true, force: true });
	throw new Error(`the code under test sees ${home()} rather than the borrowed ${HOME}; refusing to run against a real home`);
}

/** 工作区不放在临时目录下：临时目录本来可读，放那里「外面」的路径全读得到，断言就空了。 */
const WS = join(HOME, ".plume-test-ws");
const OUTSIDE = join(HOME, ".plume-test-outside");

function ctxFor(cwd: string, approvals?: { decisions: Decision[]; seen: ApprovalContent[] }): ToolContext {
	return {
		cwd,
		state: new Map(),
		sandbox: localSandbox,
		...(approvals
			? {
					requestApproval: async (request: ApprovalContent) => {
						approvals.seen.push(request);
						return approvals.decisions.shift() ?? "reject";
					},
				}
			: {}),
	};
}

const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("\n");

/** 只看读的审批。 */
function readsAsked(seen: ApprovalContent[]): ApprovalContent[] {
	return seen.filter((request) => request.kind === "read");
}

/** 一个真目录当工作区，放在借来的家目录下（理由同 `WS`）。 */
async function workspace(): Promise<string> {
	const dir = await mkdtemp(join(HOME, ".plume-test-ws-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function outsideDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(HOME, prefix));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

// ---------------------------------------------------------------- 判定

it("工作区和临时区不问就能读", () => {
	expect(assessRead(join(WS, "src/index.ts"), WS).decision).toBe("allow");
	expect(assessRead(WS, WS).decision).toBe("allow");
	expect(assessRead(join(tmpdir(), "build.log"), WS).decision).toBe("allow");
	// 会话的临时目录：太大没交给模型的图、截断前的全文都在这里，读回来不用问。
	expect(assessRead(join(scratchHome(), "s1", "mcp-images", "a.png"), WS).decision).toBe("allow");
	expect(assessRead("/tmp/build.log", WS).decision).toBe("allow");
});

it("工具链要读的系统目录不是别人的另一个项目", () => {
	for (const path of ["/usr/bin/node", "/etc/hosts", "/bin/sh", "/opt/homebrew/bin/pnpm", "/Library/Fonts"]) {
		expect(assessRead(path, WS).decision, path).toBe("allow");
	}
});

it("工作区外的其他地方要问，批准按目录", () => {
	const verdict = assessRead(join(OUTSIDE, "src/app.ts"), WS);
	expect(verdict.decision).toBe("ask");
	expect(verdict.decision === "ask" && verdict.scope).toBe("tree");
	expect(verdict.decision === "ask" ? verdict.reason : "").toMatch(/项目之外/);
});

it("密钥在哪里都要问，批准只管它自己", () => {
	// Plume 的密钥名单里是 `~/.plume` 的 settings.json（Magpie 的 key）、credentials.json 和 vault.key。
	for (const path of [
		join(HOME, ".ssh/id_ed25519"),
		join(HOME, ".plume/settings.json"),
		join(HOME, ".plume/credentials.json"),
		join(HOME, ".plume/vault.key"),
		join(HOME, ".aws/credentials"),
		join(HOME, ".netrc"),
	]) {
		const verdict = assessRead(path, WS);
		expect(verdict.decision, path).toBe("ask");
		expect(verdict.decision === "ask" && verdict.scope, path).toBe("file");
	}
});

it("工作区里的密钥还是密钥", () => {
	// 在工作区之前判：密钥读了不是坏了，是用掉了，「碰巧在项目里」不是不问就交出去的理由。
	const verdict = assessRead(join(WS, ".ssh/id_rsa"), WS);
	expect(verdict.decision).toBe("ask");
	expect(verdict.decision === "ask" && verdict.scope).toBe("file");
});

it("用户拖进来的文件就是用户给的", () => {
	const attached = join(OUTSIDE, "notes.md");
	expect(assessRead(attached, WS, { allowedPaths: new Set([attached]) }).decision).toBe("allow");
	// 包括密钥：拖进来是被保护的人自己做的。
	const key = join(HOME, ".ssh/id_ed25519");
	expect(assessRead(key, WS, { allowedPaths: new Set([key]) }).decision).toBe("allow");
	// 但只是那一个文件，不包括它旁边的。
	expect(assessRead(join(OUTSIDE, "other.md"), WS, { allowedPaths: new Set([attached]) }).decision).toBe("ask");
});

// ---------------------------------------------------------------- 批准覆盖什么

it("批准往上走到仓库根，批一次覆盖整个项目", async () => {
	const repo = await outsideDir(".plume-test-repo-");
	await mkdir(join(repo, ".git"), { recursive: true });
	await mkdir(join(repo, "src/deep/deeper"), { recursive: true });

	const exists = (path: string) => path === join(repo, ".git");
	expect(readGrantRoot(join(repo, "src/deep/deeper/a.ts"), false, exists)).toBe(repo);
	expect(readGrantRoot(join(repo, "src"), true, exists)).toBe(repo);
});

it("家目录和根目录永远不当批准范围", () => {
	// 直接放在它们下面的文件，上一级就是它们：「以后不再问」就成了整台机器。
	const never = () => false;
	expect(readGrantRoot(join(HOME, ".zshrc"), false, never)).toBe(join(HOME, ".zshrc"));
	expect(readGrantRoot("/vmlinuz", false, never)).toBe("/vmlinuz");
	// 家目录下直接点名的目录本身是合理的批准范围。
	expect(readGrantRoot(join(HOME, "Documents"), true, never)).toBe(join(HOME, "Documents"));
});

// ---------------------------------------------------------------- 每个读的工具，同一道门

it("read 拒绝时什么都不给，批准后读得到", async () => {
	const ws = await workspace();
	const outside = await outsideDir(".plume-test-outside-");
	const file = join(outside, "secret.txt");
	await writeFile(file, "SECRET_FROM_OTHER_PROJECT\n", "utf8");

	const refused = await readTool.execute({ path: file } as never, ctxFor(ws, { decisions: ["reject"], seen: [] }));
	expect(refused.isError).toBe(true);
	expect(textOf(refused)).not.toMatch(/SECRET_FROM_OTHER_PROJECT/);

	const allowed = await readTool.execute({ path: file } as never, ctxFor(ws, { decisions: ["once"], seen: [] }));
	expect(allowed.isError).toBeUndefined();
	expect(textOf(allowed)).toMatch(/SECRET_FROM_OTHER_PROJECT/);
});

it("ls、grep、glob 和 read 按同一个规则判", async () => {
	const outside = await outsideDir(".plume-test-tools-");
	await writeFile(join(outside, "app.ts"), "const needle = 1;\n", "utf8");

	for (const [name, run] of [
		["ls", () => lsTool.execute({ path: outside } as never, ctxFor(WS, { decisions: ["reject"], seen: [] }))],
		["grep", () => grepTool.execute({ pattern: "needle", path: outside } as never, ctxFor(WS, { decisions: ["reject"], seen: [] }))],
		["glob", () => globTool.execute({ pattern: "**/*.ts", path: outside } as never, ctxFor(WS, { decisions: ["reject"], seen: [] }))],
	] as const) {
		const refused = await run();
		expect(refused.isError, name).toBe(true);
		expect(textOf(refused), `${name} 不能把拒绝读的内容漏出来`).not.toMatch(/needle|app\.ts/);
	}

	const listed = await lsTool.execute({ path: outside } as never, ctxFor(WS, { decisions: ["once"], seen: [] }));
	expect(listed.isError).toBeUndefined();
	expect(textOf(listed)).toMatch(/app\.ts/);
});

it.skipIf(process.platform === "win32")("工作区里指向外面的链接，每个工具都按它指向的地方判", async () => {
	// 以前只有 read 解析链接；grep/ls/glob 按字面路径判，链接在工作区里就当成工作区。
	const ws = await workspace();
	const outside = await outsideDir(".plume-test-linked-");
	await writeFile(join(outside, "app.ts"), "const needle = 1;\n", "utf8");
	await symlink(outside, join(ws, "link"));

	for (const [name, run] of [
		["ls", (ctx: ToolContext) => lsTool.execute({ path: "link" } as never, ctx)],
		["grep", (ctx: ToolContext) => grepTool.execute({ pattern: "needle", path: "link" } as never, ctx)],
		["glob", (ctx: ToolContext) => globTool.execute({ pattern: "**/*.ts", path: "link" } as never, ctx)],
		["read", (ctx: ToolContext) => readTool.execute({ path: "link/app.ts" } as never, ctx)],
	] as const) {
		const approvals = { decisions: ["reject" as const], seen: [] as ApprovalContent[] };
		const refused = await run(ctxFor(ws, approvals));
		expect(readsAsked(approvals.seen).length, `${name} 没有问`).toBe(1);
		expect(refused.isError, name).toBe(true);
		expect(textOf(refused), `${name} 读到了链接指向的外部内容`).not.toMatch(/needle/);
	}

	// 链接指回工作区自己，不问。
	await symlink(join(ws, "src"), join(ws, "inside-link")).catch(() => {});
	await mkdir(join(ws, "src"), { recursive: true });
	const approvals = { decisions: [] as Decision[], seen: [] as ApprovalContent[] };
	await lsTool.execute({ path: "inside-link" } as never, ctxFor(ws, approvals));
	expect(readsAsked(approvals.seen).length).toBe(0);
});

it("没人可问时，边界守住而不是打开", async () => {
	// 没有审批入口的宿主（测试、拿不到人的子任务）没被任何人授权过。
	const outside = await outsideDir(".plume-test-noask-");
	const file = join(outside, "x.txt");
	await writeFile(file, "nope", "utf8");

	const result = await readTool.execute({ path: file } as never, ctxFor(WS));
	expect(result.isError).toBe(true);
	expect(textOf(result)).toMatch(/没有可以询问的人/);
	expect(textOf(result)).not.toMatch(/nope/);
});

// ---------------------------------------------------------------- 别问多了

it("工作区里的日常读一次都不问", async () => {
	// `ls src` 也弹的提示，人会学会不看就点，那就不再是保护。
	const ws = await workspace();
	await mkdir(join(ws, "src"), { recursive: true });
	await writeFile(join(ws, "package.json"), "{}\n", "utf8");
	await writeFile(join(ws, "src/index.ts"), "export const a = 1;\n", "utf8");

	const approvals = { decisions: [] as Decision[], seen: [] as ApprovalContent[] };
	const ctx = ctxFor(ws, approvals);
	await readTool.execute({ path: "src/index.ts" } as never, ctx);
	await lsTool.execute({ path: "src" } as never, ctx);
	await grepTool.execute({ pattern: "a", path: "src" } as never, ctx);
	expect(readsAsked(approvals.seen).length, "工作区内的读一次都不该问").toBe(0);
});

it("不存在的路径不值得问", async () => {
	// 为打不开的文件问换不来安全，只多一次提示；工具自己的「找不到」才是诚实的回答。
	const approvals = { decisions: [] as Decision[], seen: [] as ApprovalContent[] };
	const result = await readTool.execute({ path: join(HOME, ".plume-test-absent-xyz/nope.txt") } as never, ctxFor(WS, approvals));
	expect(approvals.seen.length).toBe(0);
	expect(result.isError).toBe(true);
	expect(textOf(result)).toMatch(/File not found/);
});

it("toAbsolute 把相对工作区的路径放在它该在的地方", () => {
	expect(toAbsolute(WS, "src/a.ts")).toBe(join(WS, "src/a.ts"));
	expect(toAbsolute(WS, "~/x")).toBe(join(HOME, "x"));
	expect(toAbsolute(WS, "/etc/hosts")).toBe(resolve("/etc/hosts"));
});

it("Windows shell 的写法就是它们指的 Windows 路径", () => {
	const homeDir = "C:\\Users\\me";
	const temp = "C:\\Users\\me\\AppData\\Local\\Temp";
	// Git Bash：`/c/...` 是 C 盘。Node 读成 `C:\c\...`，那里不存在。
	expect(windowsSpelling("/c/Users/me/.ssh/id_ed25519", homeDir, temp)).toBe("C:\\Users\\me\\.ssh\\id_ed25519");
	expect(windowsSpelling("/cygdrive/d/work/x", homeDir, temp)).toBe("D:\\work\\x");
	expect(windowsSpelling("/c", homeDir, temp)).toBe("C:\\");
	expect(windowsSpelling("/tmp/a/b", homeDir, temp)).toBe(`${temp}\\a\\b`);
	// PowerShell 的家目录写法。
	expect(windowsSpelling("~\\Documents\\x", homeDir, temp)).toBe("C:\\Users\\me\\Documents\\x");
	// 单字母目录只在根上才是盘符，别的原样不动。
	expect(windowsSpelling("/cc/x", homeDir, temp)).toBe("/cc/x");
	expect(windowsSpelling("/usr/bin/git", homeDir, temp)).toBe("/usr/bin/git");
	expect(windowsSpelling("src/c/x", homeDir, temp)).toBe("src/c/x");
});

it.skipIf(process.platform === "win32")("经链接进来的工作区仍是工作区，read 也一样", async () => {
	// 工作区本身在链接后面时，解析后的路径不以 cwd 字面开头；不能因此把自己的项目当成外面去问。
	const real = await workspace();
	await writeFile(join(real, "a.txt"), "inside\n", "utf8");
	const alias = join(HOME, `.plume-test-alias-${Date.now()}`);
	await symlink(real, alias);
	onTestFinished(() => rm(alias, { force: true }));
	const approvals = { decisions: [] as Decision[], seen: [] as ApprovalContent[] };
	const result = await readTool.execute({ path: "a.txt" } as never, ctxFor(alias, approvals));
	expect(textOf(result)).toMatch(/inside/);
	await grepTool.execute({ pattern: "inside", path: "." } as never, ctxFor(alias, approvals));
	expect(readsAsked(approvals.seen).length).toBe(0);
});

// ---------------------------------------------------------------- 命令行写明的路径

/** 写给 bash 的路径：加单引号，空格和引号都不会把它拆开。 */
const sh = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

it("找出命令写明的路径，程序名不算", () => {
	expect(commandReadTargets(`cat ${sh(join(HOME, ".ssh/id_ed25519"))}`, WS)).toEqual([join(HOME, ".ssh/id_ed25519")]);
	expect(commandReadTargets("pwd", WS)).toHaveLength(0);
});

it("~ 和 .. 照样解析：离开边界靠的就是它们", () => {
	expect(commandReadTargets("cat ~/.netrc", WS)).toContain(join(HOME, ".netrc"));
	expect(commandReadTargets("cat ../sibling/key.pem", join(HOME, "a/b"))).toContain(join(HOME, "a/sibling/key.pem"));
});

it("重定向的目标是被写的，不是被读的；从文件读进来的是读", () => {
	expect(commandReadTargets(`echo hi > ${sh(join(HOME, "notes.txt"))}`, WS)).not.toContain(join(HOME, "notes.txt"));
	expect(commandReadTargets(`echo hi >> ${sh(join(HOME, "notes.txt"))}`, WS)).not.toContain(join(HOME, "notes.txt"));
	expect(commandReadTargets(`make 2> ${sh(join(HOME, "err.log"))}`, WS)).not.toContain(join(HOME, "err.log"));
	expect(commandReadTargets(`sort < ${sh(join(HOME, "notes.txt"))}`, WS)).toContain(join(HOME, "notes.txt"));
});

it("shell 会改写的词不猜", () => {
	const outside = (command: string) => commandReadTargets(command, WS).filter((path) => !path.startsWith(`${WS}${sep}`));
	expect(outside("cat $SECRETS/key")).toEqual([]);
	expect(outside("cat ~/.ssh/*")).toEqual([]);
	expect(outside("cat `which node`")).toEqual([]);
});

it("heredoc 的正文是数据，不是路径；没收尾的也不吞掉同一行前面的", () => {
	const command = `python3 - <<'EOF'\nimport os\nopen('${HOME}/.ssh/id_ed25519').read()\nprint("/dist and /out")\nEOF`;
	// 目标按本机写法返回：分隔符 `EOF` 在 Windows 上解析成 `WS\EOF`，不是 `WS/EOF`。
	expect(commandReadTargets(command, WS).filter((path) => !path.startsWith(`${WS}${sep}`))).toEqual([]);
	expect(commandReadTargets(`cat ${sh(join(HOME, "a.txt"))} && python3 - <<'EOF'\nbody\n`, WS)).toContain(join(HOME, "a.txt"));
});

it("不带引号的 heredoc 里的替换照样是读", () => {
	const key = join(HOME, ".ssh/id_ed25519");
	expect(commandReadTargets(`cat <<EOF\n$(cat ${sh(key)})\nEOF`, WS, ["posix"])).toContain(key);
	const quoted = `cat <<'EOF'\n$(cat ${sh(key)})\nEOF`;
	expect(commandReadTargets(quoted, WS, ["posix"])).not.toContain(key);
	/*
	 * PowerShell 没有 heredoc，按它的读法同一段正文是活的 `$(…)`。PowerShell 可能是跑它的那个 shell 时，这种读法要留着：
	 * 所以语法由知道是哪个 shell 的调用方传进来，而不是每种语法都读。
	 */
	expect(commandReadTargets(quoted, WS, ["posix", "powershell"])).toContain(key);
});

it("内联的脚本、选项都不是路径；反斜杠照 bash 的读法解", () => {
	expect(commandReadTargets(`python3 -c "line one\n${"x".repeat(500)}"`, WS)).toHaveLength(0);
	expect(commandReadTargets("ls -la --color=auto", WS)).toHaveLength(0);
	expect(commandReadTargets("cat ~/.ss\\h/id_ed25519", WS)).toContain(join(HOME, ".ssh/id_ed25519"));
});

it("经 bash 读密钥也要问，哪怕只读表说 cat 只读", async () => {
	const sshDir = join(HOME, ".ssh");
	const keyFile = join(sshDir, "id_ed25519");
	await mkdir(sshDir, { recursive: true });
	await writeFile(keyFile, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n", "utf8");
	onTestFinished(() => rm(sshDir, { recursive: true, force: true }));
	expect(isReadOnlyCommand(`cat ${sh(keyFile)}`)).toBe(true);

	for (const command of [`cat ${sh(keyFile)}`, `cd ${sh(sshDir)} && cat id_ed25519`]) {
		const approvals = { decisions: ["reject" as Decision], seen: [] as ApprovalContent[] };
		const result = await bashTool.execute({ command }, ctxFor(WS, approvals));
		expect(approvals.seen).toHaveLength(1);
		expect(approvals.seen[0]).toMatchObject({ kind: "read", subject: command.startsWith("cat") ? `read:${keyFile}` : expect.any(String) });
		expect(result.isError).toBe(true);
		expect(textOf(result)).not.toMatch(/BEGIN .* PRIVATE KEY/);
	}
});

it("同一个路径，文件工具和 shell 给同一个答案；同一个批准范围只问一次", async () => {
	const ws = await workspace();
	const outside = await outsideDir(".plume-test-outside-");
	const file = join(outside, "secret.txt");
	await writeFile(file, "SECRET_FROM_OTHER_PROJECT\n", "utf8");
	await writeFile(join(outside, "b.txt"), "b", "utf8");

	const viaRead = await readTool.execute({ path: file }, ctxFor(ws, { decisions: ["reject"], seen: [] }));
	const viaBash = await bashTool.execute({ command: `cat ${sh(file)}` }, ctxFor(ws, { decisions: ["reject"], seen: [] }));
	expect(viaRead.isError).toBe(true);
	expect(viaBash.isError).toBe(true);
	expect(textOf(viaBash)).not.toMatch(/SECRET_FROM_OTHER_PROJECT/);

	const okBash = await bashTool.execute({ command: `cat ${sh(file)}` }, ctxFor(ws, { decisions: ["once"], seen: [] }));
	expect(textOf(okBash)).toMatch(/SECRET_FROM_OTHER_PROJECT/);

	const approvals = { decisions: ["once" as Decision, "once" as Decision], seen: [] as ApprovalContent[] };
	await bashTool.execute({ command: `cat ${sh(file)} ${sh(join(outside, "b.txt"))}` }, ctxFor(ws, approvals));
	expect(readsAsked(approvals.seen)).toHaveLength(1);
});

it("密钥不管在不在都问；普通的不存在的路径不问", async () => {
	const ctx: ToolContext = { cwd: WS, state: new Map() };
	expect(await authorizeCommandReads(`cat ${sh(join(HOME, ".ssh", `id_plume_absent_${process.pid}`))}`, ctx)).toBeTruthy();
	expect(await authorizeCommandReads(`cat ${sh(join(HOME, `plume-absent-${process.pid}.txt`))}`, ctx)).toBeNull();
});
