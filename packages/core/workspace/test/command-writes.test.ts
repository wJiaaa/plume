/**
 * `commandWriteTargets`、`commandWritesAppData`：完全访问下一行命令写明要改哪些路径，哪些在 Plume 自己的目录里。
 */

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { commandWriteTargets, commandWritesAppData } from "../src/command-writes.ts";

const CWD = "/work/app";
const PLUME = join(homedir(), ".plume");
const targets = (command: string) => commandWriteTargets(command, CWD, ["posix"]);

it("认重定向、放文件的程序、原地改、删和建；~ 和 $HOME 展开", () => {
	expect(targets("echo '{}' > ~/.plume/settings.json")).toEqual([join(PLUME, "settings.json")]);
	expect(targets("echo x >>$HOME/.plume/a.txt")).toEqual([join(PLUME, "a.txt")]);
	expect(targets("cat <<'EOF' > ${HOME}/.plume/b.json\n{}\nEOF")).toEqual([join(PLUME, "b.json")]);
	expect(targets("printf x | tee -a ~/.plume/c.txt")).toEqual([join(PLUME, "c.txt")]);
	expect(targets("sed -i '' 's/a/b/' ~/.plume/settings.json")).toContain(join(PLUME, "settings.json"));
	expect(targets("perl -pi -e 's/a/b/' ~/.plume/d.json")).toContain(join(PLUME, "d.json"));
	expect(targets("cp new.json ~/.plume/plugins.json")).toEqual([join(PLUME, "plugins.json")]);
	expect(targets("mv ~/.plume/x.json ~/backup/x.json")).toEqual([join(PLUME, "x.json"), join(homedir(), "backup", "x.json")]);
	expect(targets("rm -rf ~/.plume/plugins/*")).toEqual([join(PLUME, "plugins")]);
	expect(targets("sudo touch ~/.plume/e")).toEqual([join(PLUME, "e")]);
	expect(targets("dd if=/dev/zero of=~/.plume/f bs=1 count=1")).toEqual([join(PLUME, "f")]);
	expect(targets("mkdir -p out && echo hi > out/a.txt")).toEqual([join(CWD, "out"), join(CWD, "out", "a.txt")]);
});

it("读不算写：cat、grep、从 ~/.plume 往外拷、没加 -i 的 sed 都不认", () => {
	expect(targets("cat ~/.plume/settings.json")).toEqual([]);
	expect(targets("grep -r key ~/.plume")).toEqual([]);
	expect(targets("cp ~/.plume/settings.json /tmp/settings.json")).toEqual(["/tmp/settings.json"]);
	expect(targets("sed 's/a/b/' ~/.plume/settings.json")).toEqual([]);
	expect(targets("cat ~/.plume/settings.json 2>/dev/null")).toEqual(["/dev/null"]);
});

it("拼出来的路径认不出来，不猜", () => {
	expect(targets("echo x > $DIR/settings.json")).toEqual([]);
	expect(targets("python3 fix.py")).toEqual([]);
});

it("PowerShell 的写法也认", () => {
	const ps = (command: string) => commandWriteTargets(command, CWD, ["powershell"]);
	expect(ps("Set-Content -Path ~/.plume/settings.json -Value '{}'")).toContain(join(PLUME, "settings.json"));
	expect(ps("Remove-Item -Recurse ~/.plume/plugins")).toContain(join(PLUME, "plugins"));
});

let dir: string;
beforeAll(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "plume-command-writes-")));
	await mkdir(join(dir, "data", "scratch", "own"), { recursive: true });
	await mkdir(join(dir, "app"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

it("只挑出落在 Plume 自己目录里的：工作区、同一脉的临时目录、别处都不算", async () => {
	const data = join(dir, "data");
	const scope = { cwd: join(dir, "app"), scratchDirs: [join(data, "scratch", "own")], dataDir: data };
	expect(await commandWritesAppData(scope, `echo x > ${data}/settings.json && echo y > out.txt`, ["posix"])).toEqual([join(data, "settings.json")]);
	expect(await commandWritesAppData(scope, `echo x > ${data}/scratch/own/probe.py`, ["posix"])).toEqual([]);
	expect(await commandWritesAppData(scope, `echo x > ${data}/scratch/other/a.md`, ["posix"])).toEqual([join(data, "scratch", "other", "a.md")]);
	expect(await commandWritesAppData(scope, `cat ${data}/settings.json`, ["posix"])).toEqual([]);
	expect(await commandWritesAppData(scope, "echo x > ~/Desktop/notes.md", ["posix"])).toEqual([]);
});
