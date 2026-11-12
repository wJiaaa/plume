/**
 * 读的边界，从工具这一侧看：read、ls、grep、glob、bash 都经本体的同一道门（`ToolRun.files`），拒绝时什么都不漏。
 *
 * 判定本身（哪里不问、哪里要问、批准覆盖多大、命令写明了哪些路径）在本体 `packages/core/workspace/test/read-access.test.ts` 里测，
 * 卡片怎么画在 `packages/core/agent/test/run-files.test.ts`。
 */

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, onTestFinished } from "vitest";
import { isReadOnlyCommand } from "../../src/read-only-command.ts";
import { bashTool } from "../../src/tools/bash.ts";
import { globTool } from "../../src/tools/glob.ts";
import { grepTool } from "../../src/tools/grep.ts";
import { lsTool } from "../../src/tools/ls.ts";
import { readTool } from "../../src/tools/read.ts";
import type { ToolContext, ToolResult } from "../../src/tools/types.ts";
import { writeTool } from "../../src/tools/write.ts";
import { withFiles } from "../files.ts";
import { localExec } from "../sandbox.ts";

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
if (homedir() !== HOME) {
	await rm(HOME, { recursive: true, force: true });
	throw new Error(`the code under test sees ${homedir()} rather than the borrowed ${HOME}; refusing to run against a real home`);
}

/** 工作区不放在临时目录下：临时目录本来可读，放那里「外面」的路径全读得到，断言就空了。 */
const WS = join(HOME, ".plume-test-ws");

function ctxFor(cwd: string, approvals?: { decisions: Decision[]; seen: ApprovalContent[] }, projectRoots?: string[]): ToolContext {
	return withFiles({
		cwd,
		state: new Map(),
		exec: localExec(cwd),
		...(projectRoots ? { projectRoots } : {}),
		...(approvals
			? {
					requestApproval: async (request: ApprovalContent) => {
						approvals.seen.push(request);
						return approvals.decisions.shift() ?? "reject";
					},
				}
			: {}),
	});
}

const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("\n");

/** 只看读的审批。 */
function readsAsked(seen: ApprovalContent[]): ApprovalContent[] {
	return seen.filter((request) => request.kind === "view");
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

it("同一个项目的其他源码目录读得到，写它照样要问", async () => {
	const ws = await workspace();
	const shared = await outsideDir(".plume-test-shared-");
	const path = join(shared, "core.ts");
	await writeFile(path, "export const value = 1;\n", "utf8");

	const approvals = { decisions: ["reject" as Decision], seen: [] as ApprovalContent[] };
	const ctx = ctxFor(ws, approvals, [shared]);
	expect(textOf(await readTool.execute({ path } as never, ctx))).toContain("export const value = 1");
	expect(readsAsked(approvals.seen)).toHaveLength(0);
	// 放进同一个项目是「读得到」，不是「可以改」：写的边界不跟着放宽。
	const written = await writeTool.execute({ path, content: "changed" } as never, ctx);
	expect(written.isError).toBe(true);
	expect(approvals.seen.at(-1)?.kind).toBe("create");
	expect(await readFile(path, "utf8")).toBe("export const value = 1;\n");
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
		expect(approvals.seen[0]).toMatchObject({ kind: "view", subject: command.startsWith("cat") ? `read:${keyFile}` : expect.any(String) });
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
