/**
 * 沙箱：受限命令能写什么（纯规则），这台机器提供哪种约束、给不了时怎么办，以及从输出里认出拒绝。
 *
 * 最要紧的两类：转义是安全边界（目录名里的引号不能提前结束 profile 字面量）；给不了约束必须抛错，
 * 悄悄把原命令还回去，上面每种模式都照常「成功」，却什么都没管住。
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { confine, looksDenied, resetProbeCache, SandboxUnavailableError, selectRunner } from "../src/backend.ts";
import { canonicalPath, seatbeltArgs, writableRoots } from "../src/policy.ts";

const profileOf = (args: string[]) => args[1] ?? "";

const cleanup: string[] = [];
afterEach(async () => {
	for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

describe("可写根", () => {
	it("read-only 一个可写根都不给", () => {
		expect(writableRoots({ mode: "read-only", workspaceRoot: "/some/project" })).toEqual([]);
	});

	it("danger-full-access 不是受限模式，也推不出可写根", () => {
		expect(writableRoots({ mode: "danger-full-access", workspaceRoot: "/some/project" })).toEqual([]);
	});

	it("workspace-write 给工作区和临时目录，且都是规范路径", () => {
		const roots = writableRoots({ mode: "workspace-write", workspaceRoot: realpathSync.native(tmpdir()) });
		expect(roots.length).toBeGreaterThan(0);
		// 指向符号链接的授权在运行时匹配不到任何东西。
		for (const root of roots) expect(root).toBe(canonicalPath(root));
	});

	it("临时目录里的工作区被吸收，不重复授权", async () => {
		const parent = await tempDir("plume-sb-");
		const child = join(parent, "project");
		await mkdir(child, { recursive: true });

		const roots = writableRoots({ mode: "workspace-write", workspaceRoot: child });
		const canonicalChild = canonicalPath(child);
		const covering = roots.filter((root) => canonicalChild === root || canonicalChild.startsWith(`${root}/`));
		expect(covering, JSON.stringify(roots)).toHaveLength(1);
	});

	it("只是前缀相同的兄弟目录不被吸收", () => {
		// `/a/bc` 不在 `/a/b` 里；直接 startsWith 会把它吞掉。
		expect(writableRoots({ mode: "workspace-write", workspaceRoot: "/nonexistent-a/bc" })).toContain("/nonexistent-a/bc");
	});

	it("解析不了的路径原样保留，存在之前什么都不授权", () => {
		const missing = "/definitely/not/here/right/now";
		expect(canonicalPath(missing)).toBe(missing);
	});

	it("符号链接解析成内核会报告的路径", async () => {
		const base = await tempDir("plume-sb-link-");
		const real = join(base, "real");
		const link = join(base, "link");
		await mkdir(real, { recursive: true });
		await symlink(real, link);
		expect(canonicalPath(link)).toBe(realpathSync.native(real));
	});
});

describe("Seatbelt profile", () => {
	it("拒写，但留下 shell 离不开的 /dev/null", () => {
		const profile = profileOf(seatbeltArgs({ mode: "read-only", workspaceRoot: "/p" }));
		expect(profile).toMatch(/\(deny file-write\*\)/);
		expect(profile).toMatch(/\(allow file-write\* \(literal "\/dev\/null"\)\)/);
		expect(profile).not.toContain("subpath");
	});

	it("workspace-write 加上 subpath 授权", () => {
		const profile = profileOf(seatbeltArgs({ mode: "workspace-write", workspaceRoot: realpathSync.native(tmpdir()) }));
		expect(profile).toMatch(/\(allow file-write\* \(subpath /);
	});

	it("受限 profile 拒掉会替命令写文件的守护进程", () => {
		// `open -g P.app` 让 P 在沙箱外写主目录，`defaults write` 让 cfprefsd 写偏好设置；只拒 launchservicesd 时 open 会走 quarantine resolver。
		for (const mode of ["read-only", "workspace-write"] as const) {
			const profile = profileOf(seatbeltArgs({ mode, workspaceRoot: "/p" }));
			const denial = /\(deny mach-lookup ([^()]|\([^()]*\))*\)/.exec(profile)?.[0] ?? "";
			for (const name of [
				'(global-name "com.apple.coreservices.launchservicesd")',
				'(global-name "com.apple.coreservices.quarantine-resolver")',
				'(global-name-prefix "com.apple.lsd.")',
				'(global-name "com.apple.cfprefsd.daemon")',
				'(global-name "com.apple.cfprefsd.agent")',
			]) {
				expect(denial, `${mode}: ${profile}`).toContain(name);
			}
		}
		// 完全访问就是没有沙箱，服务也不拦。
		expect(profileOf(seatbeltArgs({ mode: "danger-full-access", workspaceRoot: "/p" }))).not.toContain("mach-lookup");
	});

	it("profile 按 sandbox-exec 的方式用 -p 传", () => {
		const args = seatbeltArgs({ mode: "read-only", workspaceRoot: "/p" });
		expect(args[0]).toBe("-p");
		expect(args).toHaveLength(2);
	});

	/*
	 * 下面三条转义用例特意放在 `/tmp` 之外：被别的根包含的根会被去掉，`/tmp` 下的恶意路径根本进不了 profile，
	 * 断言就落空了（Linux 上 `/tmp` 不是符号链接，这种情况才会出现）。
	 */
	it("目录名里的引号不能提前结束字面量", () => {
		const profile = profileOf(seatbeltArgs({ mode: "workspace-write", workspaceRoot: '/ws/we"ird' }));
		expect(profile).toContain('we\\"ird');
		// 没转义的引号会让引号数变成奇数。
		expect((profile.match(/(?<!\\)"/g) ?? []).length % 2).toBe(0);
	});

	it("反斜杠先于引号转义", () => {
		const profile = profileOf(seatbeltArgs({ mode: "workspace-write", workspaceRoot: "/ws/back\\slash" }));
		expect(profile).toContain("back\\\\slash");
	});

	it("路径里的换行注入不了新的 profile 形式", () => {
		const profile = profileOf(seatbeltArgs({ mode: "workspace-write", workspaceRoot: '/ws/a\n(allow file-write* (subpath "/"))' }));
		expect(profile).not.toContain('(subpath "/"))');
		// 路径确实进了 profile，上一条说的是转义而不是缺席。
		expect(profile).toContain("/ws/a");
	});
});

describe("选后端与包装", () => {
	beforeEach(() => resetProbeCache());

	it("macOS 探测通过选 Seatbelt", () => {
		expect(selectRunner({ platform: "darwin", probe: () => true })).toBe("seatbelt");
	});

	it("在但拒绝 profile 的后端不选", () => {
		// 存在不等于能用，所以探测是真的跑而不是看文件在不在。
		expect(selectRunner({ platform: "darwin", probe: () => false })).toBe("none");
	});

	it("其他平台没有后端（Windows 的受限令牌见 windows.test.ts）", () => {
		expect(selectRunner({ platform: "linux", probe: () => true })).toBe("none");
	});

	it("每台机器只探测一次，不是每条命令一次", () => {
		let probes = 0;
		const hooks = {
			platform: "darwin" as const,
			probe: () => {
				probes += 1;
				return true;
			},
		};
		selectRunner(hooks);
		selectRunner(hooks);
		selectRunner(hooks);
		expect(probes).toBe(1);
	});

	it("给不了约束就抛错，不会不受限地跑", () => {
		expect(() => confine({ mode: "workspace-write", workspaceRoot: "/p" }, { platform: "freebsd", probe: () => false })).toThrow(SandboxUnavailableError);
		resetProbeCache();
		expect(() => confine({ mode: "read-only", workspaceRoot: "/p" }, { platform: "darwin", probe: () => false })).toThrow(SandboxUnavailableError);
		resetProbeCache();
		expect(() => confine({ mode: "read-only", workspaceRoot: "/p" }, { platform: "linux" })).toThrow(/没有可用的沙箱后端/);
	});

	it("探测失败的原因写进报错", () => {
		const error = (() => {
			try {
				confine({ mode: "read-only", workspaceRoot: "/p" }, { platform: "darwin", seatbeltExec: "/nonexistent/sandbox-exec" });
			} catch (caught) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(SandboxUnavailableError);
		expect((error as Error).message).toContain("seatbelt：");
	});

	it("danger-full-access 不要约束，也就不需要后端", () => {
		// 哪怕平台上什么都没有：这个模式就是没有沙箱，而「没有」到处都有。
		expect(confine({ mode: "danger-full-access", workspaceRoot: "/p" }, { platform: "freebsd" })).toBeNull();
	});

	it("Seatbelt 包装以 sandbox-exec 要的分隔符结尾", () => {
		const wrap = confine({ mode: "workspace-write", workspaceRoot: "/p" }, { platform: "darwin", probe: () => true, seatbeltExec: "/usr/bin/sandbox-exec" });
		expect(wrap).toMatchObject({ command: "/usr/bin/sandbox-exec", runner: "seatbelt", enforcement: "full" });
		expect(wrap?.args[0]).toBe("-p");
		expect(wrap?.args.at(-1)).toBe("--");
	});
});

describe("从输出认出拒绝", () => {
	it("后端真正打印的句子算拒绝", () => {
		expect(looksDenied("touch: /etc/hosts: Operation not permitted")).toBe(true);
		// macOS 默认的 zsh 写小写，整行形状也不同；只认 bash 的写法会漏掉真实环境里的每一次拒绝。
		expect(looksDenied("zsh:1: operation not permitted: /Users/x/.ssh/config")).toBe(true);
		expect(looksDenied("sandbox-exec: sandbox_apply: Operation not permitted")).toBe(true);
		expect(looksDenied("mkdir: cannot create directory '/x': Read-only file system")).toBe(true);
	});

	it("Permission denied 在 Seatbelt 下只是普通失败", () => {
		expect(looksDenied("/bin/bash: line 1: /home/u/x: Permission denied", "seatbelt")).toBe(false);
		expect(looksDenied("git@github.com: Permission denied (publickey).")).toBe(false);
	});

	it("Seatbelt 下 open、defaults 被拒了守护进程算拒绝，只在 Seatbelt 下", () => {
		// macOS 27 上 `open`、`defaults write` 在 profile 下的原样输出。
		const launch =
			'The application cannot be opened for an unexpected reason, error=Error Domain=NSOSStatusErrorDomain Code=-10827 "kLSNoExecutableErr: The executable is missing" UserInfo={_LSLine=4288, _LSFunction=_LSOpenStuffCallLocal, _LSFile=LSOpenCore.mm, _LSErrorMessage=kLSNoExecutableErr}';
		const document =
			'No application knows how to open URL file:///tmp/doc.txt (Error Domain=NSOSStatusErrorDomain Code=-10661 "kLSExecutableIncorrectFormat: No compatible executable was found" UserInfo={_LSLine=1972, _LSFunction=runEvaluator, _LSFile=LSBindingEvaluator.mm, _LSErrorMessage=kLSExecutableIncorrectFormat}).';
		const prefs = "Error: Could not write domain dev.example.probe; exiting";
		for (const output of [launch, document, prefs]) {
			expect(looksDenied(output, "seatbelt"), output).toBe(true);
			expect(looksDenied(output, "windows-acl"), output).toBe(false);
			expect(looksDenied(output), output).toBe(false);
		}
	});

	it("普通失败不读成拒绝", () => {
		// 错在这个方向代价大：会为沙箱没拦的事弹提权申请，教会用户这个弹窗没意义。
		expect(looksDenied("bash: line 1: nosuchcommand: command not found")).toBe(false);
		expect(looksDenied("error: pathspec 'x' did not match any file(s) known to git")).toBe(false);
		expect(looksDenied("npm ERR! code EACCES\nnpm ERR! syscall mkdir")).toBe(false);
		expect(looksDenied("")).toBe(false);
	});
});

describe("真实的 sandbox-exec", () => {
	beforeEach(() => resetProbeCache());

	const run = (mode: "read-only" | "workspace-write", workspace: string, script: string) => {
		const wrap = confine({ mode, workspaceRoot: workspace });
		if (!wrap) throw new Error("受限模式必须有包装");
		const result = spawnSync(wrap.command, [...wrap.args, "/bin/sh", "-c", script], { cwd: workspace, encoding: "utf8" });
		return { ...result, runner: wrap.runner };
	};

	test.skipIf(process.platform !== "darwin")("read-only 下写工作区被拒，且认得出是沙箱拒的", async () => {
		const workspace = await tempDir("plume-sb-ro-");
		const result = run("read-only", workspace, "touch f.txt");
		expect(result.status).not.toBe(0);
		expect(existsSync(join(workspace, "f.txt"))).toBe(false);
		expect(looksDenied(result.stderr, result.runner), result.stderr).toBe(true);
	});

	test.skipIf(process.platform !== "darwin")("workspace-write 下能写工作区，写不了工作区外", async () => {
		const workspace = await tempDir("plume-sb-ww-");
		const outside = join(homedir(), `.plume-sandbox-probe-${randomUUID()}`);
		cleanup.push(outside);

		const inside = run("workspace-write", workspace, "touch f.txt");
		expect(inside.status, inside.stderr).toBe(0);
		expect(existsSync(join(workspace, "f.txt"))).toBe(true);

		const escaped = run("workspace-write", workspace, `touch '${outside}'`);
		expect(escaped.status).not.toBe(0);
		expect(existsSync(outside)).toBe(false);
		expect(looksDenied(escaped.stderr, escaped.runner), escaped.stderr).toBe(true);
	});
});
