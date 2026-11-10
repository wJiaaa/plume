/**
 * 「用什么打开」的候选表和起法（main/open-target-ids.ts）。
 *
 * 出过的错：Windows 终端被直接塞了目录（`wt <dir>`），把文件夹当命令跑；`code.cmd` 不经 shell 起，Node 抛 EINVAL，
 * 兜底悄悄改成用系统默认的应用打开，选了 VS Code 却不是 VS Code 打开的。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CANDIDATES, type Candidate, candidatesFor, launchPlan } from "../src/main/open-target-ids.ts";
import { cmdInvocation } from "../src/main/windows-command.ts";

const candidate = (platform: string, id: string): Candidate => {
	const found = candidatesFor(platform).find((entry) => entry.id === id);
	assert.ok(found, `${platform} 没有 ${id}`);
	return found;
};

test("每个平台都有能打开文件的应用，终端不是唯一的选择", () => {
	for (const [platform, list] of Object.entries(CANDIDATES)) {
		assert.ok(
			list.some((entry) => entry.kind === "app"),
			`${platform} 没有应用`,
		);
	}
});

test("每个候选都说清在自己的平台上怎么找", () => {
	for (const entry of CANDIDATES.darwin ?? []) assert.ok(entry.appName, `${entry.id} 没有包名`);
	for (const entry of CANDIDATES.win32 ?? []) assert.ok(entry.windows?.length || entry.command, `${entry.id} 既没有路径也没有命令`);
});

test("一个平台里 id 不重复：设置里只存一个 id", () => {
	for (const [platform, list] of Object.entries(CANDIDATES)) {
		const ids = list.map((entry) => entry.id);
		assert.equal(new Set(ids).size, ids.length, `${platform} 有重复的 id`);
	}
});

test("Windows 上的终端都说清怎么接目录（`open -a` 自己会交目录，macOS 不用）", () => {
	for (const entry of candidatesFor("win32").filter((item) => item.kind === "terminal")) assert.ok(entry.dirArgs, `${entry.id} 会把文件夹当命令跑`);
	assert.deepEqual(candidatesFor("linux"), []);
});

test("Windows 终端用 -d 接目录，也从那个目录起", () => {
	const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
	const plan = launchPlan(candidate("win32", "windows-terminal"), wt, "C:\\proj", "win32", {});
	assert.deepEqual(plan, { file: wt, args: ["-d", "C:\\proj"], cwd: "C:\\proj" });
});

test("路径里的分号要转义：wt 把裸的 ; 当成下一条命令", () => {
	const plan = launchPlan(candidate("win32", "windows-terminal"), "wt.exe", "C:\\a;b", "win32", {});
	assert.deepEqual(plan.args, ["-d", "C:\\a\\;b"]);
});

test("VS Code 的 code.cmd 经 cmd.exe 起，路径按 cmd 的规矩转义", () => {
	const plan = launchPlan(
		candidate("win32", "vscode"),
		"C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
		"C:\\proj\\a&b.ts",
		"win32",
		{ ComSpec: "C:\\Windows\\system32\\cmd.exe" },
	);
	assert.equal(plan.file, "C:\\Windows\\system32\\cmd.exe");
	assert.equal(plan.windowsVerbatimArguments, true);
	assert.deepEqual(plan.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
	const line = plan.args.at(-1) ?? "";
	assert.ok(line.includes("a^&b.ts"), `& 没转义就交给了 cmd：${line}`);
	assert.ok(line.includes("Microsoft^ VS^ Code"), `程序路径里的空格没转义：${line}`);
});

test("没有 ComSpec 时用 cmd.exe；大小写不同的 Comspec 也认", () => {
	const vscode = candidate("win32", "vscode");
	assert.equal(launchPlan(vscode, "C:\\x\\code.cmd", "C:\\a.ts", "win32", {}).file, "cmd.exe");
	assert.equal(launchPlan(vscode, "C:\\x\\code.cmd", "C:\\a.ts", "win32", { Comspec: "D:\\cmd.exe" }).file, "D:\\cmd.exe");
});

test("参数里有换行时不交给 cmd：cmd 在那里就把命令结束了", () => {
	assert.throws(() => launchPlan(candidate("win32", "vscode"), "C:\\x\\code.cmd", "C:\\a\nb.ts", "win32", {}));
});

test(".exe 直接起，文件就是它的参数", () => {
	const zed = "C:\\Users\\me\\AppData\\Local\\Programs\\Zed\\Zed.exe";
	assert.deepEqual(launchPlan(candidate("win32", "zed"), zed, "C:\\proj\\main.rs", "win32", {}), { file: zed, args: ["C:\\proj\\main.rs"] });
});

test("cmd 转义：引号前和结尾的反斜杠加倍，% 加 ^；npm 的垫片多转义一遍", () => {
	assert.equal(cmdInvocation("C:\\x\\code.cmd", ['C:\\a"b\\', "100%"], {}).args.at(-1), '"C:\\x\\code.cmd ^"C:\\a\\^"b\\\\^" ^"100^%^""');
	assert.equal(cmdInvocation("C:\\p\\node_modules\\.bin\\fmt.cmd", ["a&b"], {}).args.at(-1), '"C:\\p\\node_modules\\.bin\\fmt.cmd ^^^"a^^^&b^^^""');
});
