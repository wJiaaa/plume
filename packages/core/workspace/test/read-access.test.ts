/**
 * 读的边界：一条规则，几个入口。
 *
 * read、ls、grep、glob、bash 问「这个文件能不能读」，得到的必须是同一个答案：一个工具拒了、换个工具读得到，
 * 模型就学会去绕。这里测判定本身（`assessRead`）、批准覆盖多大（`readGrantRoot`）、一行命令写明要读哪些路径，
 * 以及问人时交出去的是什么（`authorizeRead`、`authorizeCommandReads`）。各个工具都经这一道门，在 plume.tools 的
 * `test/tools/read-access.test.ts` 里测；卡片怎么画在 `packages/core/agent/test/run-files.test.ts`。
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, expect, it, onTestFinished } from "vitest";
import { assessRead, authorizeCommandReads, authorizeRead, commandReadTargets, readGrantRoot, type ReadRequest, type ReadScope } from "../src/read-access.ts";
import { toAbsolute, windowsSpelling } from "../src/paths.ts";

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
if (homedir() !== HOME) {
	await rm(HOME, { recursive: true, force: true });
	throw new Error(`the code under test sees ${homedir()} rather than the borrowed ${HOME}; refusing to run against a real home`);
}

/** 工作区不放在临时目录下：临时目录本来可读，放那里「外面」的路径全读得到，断言就空了。 */
const WS = join(HOME, ".plume-test-ws");
const OUTSIDE = join(HOME, ".plume-test-outside");
/** Plume 的数据目录：它下面的 `scratch/` 是各会话的临时目录。 */
const DATA = join(HOME, ".plume-test-data");

/** 一次调用读东西的环境；`answers` 依次答每一次问，答完了就拒绝。 */
function scopeFor(cwd: string, answers: boolean[] = [], extra: Partial<ReadScope> = {}): { scope: ReadScope; asked: ReadRequest[] } {
	const asked: ReadRequest[] = [];
	const scope: ReadScope = {
		cwd,
		dataDir: DATA,
		confirm: async (request) => {
			asked.push(request);
			return answers.shift() ? { ok: true } : { ok: false, message: `拒绝了：${request.shown}` };
		},
		...extra,
	};
	return { scope, asked };
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
	// 会话的临时目录：太大没交给模型的图、截断前的全文都在这里，读回来不用问；别的会话的也一样，读不分会话。
	expect(assessRead(join(DATA, "scratch", "s1", "mcp-images", "a.png"), WS, { dataDir: DATA }).decision).toBe("allow");
	expect(assessRead(join(DATA, "scratch", "other", "tool-output", "a.log"), WS, { dataDir: DATA }).decision).toBe("allow");
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

it("同一个项目的其他源码目录不问，里面的密钥照问", () => {
	const shared = join(OUTSIDE, "shared");
	expect(assessRead(join(shared, "core.ts"), WS, { projectRoots: [shared] }).decision).toBe("allow");
	expect(assessRead(join(shared, ".ssh/id_rsa"), WS, { projectRoots: [shared] }).decision).toBe("ask");
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

// ---------------------------------------------------------------- 问人时交出去的

it("项目外的读按项目问，记账用 read:<项目>；拒绝时交回调用方给的话", async () => {
	const outside = await outsideDir(".plume-test-ask-");
	await mkdir(join(outside, ".git"));
	await mkdir(join(outside, "src"));
	const file = join(outside, "src", "a.ts");
	await writeFile(file, "x", "utf8");

	const refused = scopeFor(WS, [false]);
	expect(await authorizeRead(refused.scope, file)).toEqual({ ok: false, message: `拒绝了：${file}` });
	expect(refused.asked).toEqual([{ absolute: file, shown: file, reason: "读取当前项目之外的位置", scope: "tree", grant: outside, subject: `read:${outside}` }]);

	const approved = scopeFor(WS, [true]);
	expect(await authorizeRead(approved.scope, file)).toEqual({ ok: true, absolute: file });
});

it("密钥只批它自己：grant 和 subject 都是那一个文件", async () => {
	const sshDir = join(HOME, ".ssh");
	const key = join(sshDir, "id_fixture");
	await mkdir(sshDir, { recursive: true });
	await writeFile(key, "test fixture only\n", "utf8");
	onTestFinished(() => rm(sshDir, { recursive: true, force: true }));

	const { scope, asked } = scopeFor(WS, [false]);
	expect((await authorizeRead(scope, "~/.ssh/id_fixture")).ok).toBe(false);
	expect(asked).toEqual([{ absolute: key, shown: key, reason: "读取本机密钥文件", scope: "file", grant: key, subject: `read:${key}` }]);
});

it("工作区里、附件、不存在的路径都不问", async () => {
	const ws = await outsideDir(".plume-test-ws-");
	await writeFile(join(ws, "a.txt"), "a", "utf8");
	const outside = await outsideDir(".plume-test-attached-");
	const attached = join(outside, "notes.md");
	await writeFile(attached, "n", "utf8");

	const { scope, asked } = scopeFor(ws, [], { allowedPaths: new Set([attached]) });
	expect(await authorizeRead(scope, "a.txt")).toEqual({ ok: true, absolute: join(ws, "a.txt") });
	expect(await authorizeRead(scope, attached)).toEqual({ ok: true, absolute: attached });
	// 为打不开的文件问换不来安全，只多一次提示；工具自己的「找不到」才是诚实的回答。
	expect((await authorizeRead(scope, join(HOME, ".plume-test-absent-xyz/nope.txt"))).ok).toBe(true);
	expect(asked).toHaveLength(0);
});

it.skipIf(process.platform === "win32")("工作区里指向外面的链接按它指向的地方判；源码目录自身是链接仍不问", async () => {
	const ws = await outsideDir(".plume-test-ws-");
	const outside = await outsideDir(".plume-test-linked-");
	await writeFile(join(outside, "app.ts"), "const needle = 1;\n", "utf8");
	await symlink(outside, join(ws, "link"));

	const linked = scopeFor(ws, [false]);
	expect((await authorizeRead(linked.scope, "link/app.ts")).ok).toBe(false);
	expect(linked.asked[0]).toMatchObject({ absolute: join(outside, "app.ts"), subject: `read:${outside}` });

	// 源码目录本身经链接进来：按真实位置放行，判定交回的是真实路径。
	const alias = join(HOME, `.plume-test-source-link-${process.pid}`);
	await symlink(outside, alias);
	onTestFinished(() => rm(alias, { force: true }));
	const viaRoot = scopeFor(ws, [], { projectRoots: [alias] });
	expect(await authorizeRead(viaRoot.scope, join(alias, "app.ts"))).toEqual({ ok: true, absolute: join(outside, "app.ts") });
	expect(viaRoot.asked).toHaveLength(0);
});

it("经链接进来的工作区仍是工作区", async () => {
	// 工作区本身在链接后面时，解析后的路径不以 cwd 字面开头；不能因此把自己的项目当成外面去问。
	const real = await outsideDir(".plume-test-ws-");
	await writeFile(join(real, "a.txt"), "inside\n", "utf8");
	const alias = join(HOME, `.plume-test-alias-${Date.now()}`);
	await symlink(real, alias);
	onTestFinished(() => rm(alias, { force: true }));
	const { scope, asked } = scopeFor(alias);
	expect(await authorizeRead(scope, "a.txt")).toEqual({ ok: true, absolute: join(alias, "a.txt") });
	expect(asked).toHaveLength(0);
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

it("密钥不管在不在都问；普通的不存在的路径不问", async () => {
	const { scope } = scopeFor(WS);
	expect(await authorizeCommandReads(scope, `cat ${sh(join(HOME, ".ssh", `id_plume_absent_${process.pid}`))}`)).toBeTruthy();
	expect(await authorizeCommandReads(scope, `cat ${sh(join(HOME, `plume-absent-${process.pid}.txt`))}`)).toBeNull();
});

it("一条命令里同一个批准范围只问一次", async () => {
	const outside = await outsideDir(".plume-test-outside-");
	await writeFile(join(outside, "a.txt"), "a", "utf8");
	await writeFile(join(outside, "b.txt"), "b", "utf8");
	const { scope, asked } = scopeFor(WS, [true, true]);
	expect(await authorizeCommandReads(scope, `cat ${sh(join(outside, "a.txt"))} ${sh(join(outside, "b.txt"))}`)).toBeNull();
	expect(asked).toHaveLength(1);
});
