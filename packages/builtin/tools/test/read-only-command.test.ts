/**
 * `isReadOnlyCommand` 决定审批走不走：判成只读的命令不会问人，所以这里测的是这条旁路有没有被绕过去。
 */

import { expect, test } from "vitest";
import { isReadOnlyCommand } from "../src/read-only-command.ts";

const readOnly = (command: string) => expect(isReadOnlyCommand(command), `应免审批: ${command}`).toBe(true);
const writes = (command: string) => expect(isReadOnlyCommand(command), command).toBe(false);

test("换行和分号一样分开命令", () => {
	writes("ls\nrm -rf ~");
	writes("ls\r\nrm -rf ~");
	readOnly("ls -la");
});

test("只读程序给了要跑的东西就不再只读", () => {
	// `env` 打印环境变量，直到给它一个命令。
	readOnly("env");
	readOnly("env FOO=1");
	writes("env rm -rf ~");
	writes("env FOO=1 rm -rf ~");

	// `find` 会删、会跑命令。
	expect(isReadOnlyCommand("find . -name '*.ts'"), "find 不在只读表上").toBe(false);
	expect(isReadOnlyCommand("find . -type f"), "find 不再无条件放行").toBe(false);
	writes("find . -delete");

	// 解释器跑一个文件，文件什么都能做。
	readOnly("node --version");
	readOnly("python3 -V");
	writes("node build.js");
	writes("python3 deploy.py");
	writes("go run main.go");
	expect(isReadOnlyCommand("cargo build"), "build.rs 是任意代码").toBe(false);
	expect(isReadOnlyCommand("tsc"), "不带参数会写出 .js").toBe(false);

	// 会跑东西或挪动东西的子命令。
	writes("npm run build");
	writes("git stash");
	expect(isReadOnlyCommand("git config core.fsmonitor ./x.sh"), "赋值没有旗标，也是写").toBe(false);
	writes("git config set user.email me@example.test");
	readOnly("git config user.email");
	readOnly("git config --get user.email");
	readOnly("git config --global --list");
	readOnly("git config get user.email");
	writes("git config --unset user.email");
});

test("只读程序带上会跑东西或写文件的旗标就不再只读", () => {
	// 每个匹配或每个文件跑一个程序。
	writes("fd -x rm");
	expect(isReadOnlyCommand("fd -Hx rm"), "短旗标可以连写").toBe(false);
	writes("fd --exec rm");
	writes("fd -X rm");
	writes("fd --exec-batch rm");
	writes("rg --pre ./x.sh TODO");
	writes("rg --pre=./x.sh TODO");
	// 输出写进文件。
	writes("tree -o out.txt");
	writes("tree -ao out.txt");
	writes("git diff --output=patch.txt");
	writes("git log --output patch.txt");
	writes("file -C -m magic");
	writes("date -s 2020-01-01");
	// 改分支、改远程，而不是列出来。
	for (const command of [
		"git branch -D main",
		"git branch -m old new",
		"git branch --delete x",
		"git branch feature",
		"git branch -u origin/main",
		"git branch --set-upstream-to=origin/main",
	])
		writes(command);
	for (const command of [
		"git remote add evil https://example.test/x.git",
		"git remote set-url origin https://example.test/x.git",
		"git remote remove origin",
		"git remote prune origin",
		"git remote update",
	])
		writes(command);
});

test("只读的照旧只读", () => {
	// agent 看看状态不该打断任何人。
	for (const command of [
		"ls -la",
		"pwd",
		"cat package.json",
		"head -20 README.md",
		"wc -l src/index.ts",
		"which node",
		"rg TODO",
		"git status",
		"git log --oneline -5",
		"git diff",
		"npm ls",
		"pnpm why react",
		"docker ps",
		"fd -e ts src",
		"fd -H config",
		"rg -n --hidden TODO",
		"tree -a -L 2",
		"file package.json",
		"date +%F",
		"git branch",
		"git branch -a -vv",
		"git branch --show-current",
		"git branch --contains HEAD",
		"git branch --list feat*",
		"git remote -v",
		"git remote show origin",
		"git remote get-url origin",
	])
		readOnly(command);
});

test("一串只读命令是只读的：模型四处看看时就这么写", () => {
	for (const command of [
		'cd packages/core/src/tools && grep -rn "as text before editing" . ; wc -l edit.ts',
		"git status --porcelain | head -20",
		'cd /work/Eim && grep -rn "MessageSelector\\|Callback" --include=*.java eim-echat/src | grep -v "/target/" | head -20',
		"cat VERSION 2>/dev/null; git log --oneline -8",
		"git ls-files 2>&1 | wc -l",
		"ls src && ls test",
		"ls &>/dev/null && git status",
		"ls '$(rm -rf ~)'",
		"echo '; rm -rf ~'",
		// 注释按 bash 的读法：只跑 `ls`。
		"ls # ; rm -rf ~",
		"cd ~/projects/app && git diff --stat",
	])
		readOnly(command);
});

test("一串里有一条会写、跑了别的、或藏着命令，就不是只读", () => {
	for (const command of [
		// 有一条不是只读的。
		"cd src && rm -rf ~",
		"ls | xargs rm",
		"grep -rl x . | sh",
		"git log --output=x | head",
		"FOO=bar ls",
		"sort -o out.txt a.txt",
		// 留下写入内容的重定向。
		"cat a > b",
		"cat a >> ~/.bashrc",
		"ls 2>out.txt",
		"ls >/dev/nullx",
		// 跑了不属于这串命令的东西。
		"echo $(rm -rf ~)",
		"echo `rm -rf ~`",
		"cat <(rm -rf ~)",
		'grep "$HOME" notes.txt',
		"cat $HOME/.ssh/id_rsa",
		"(rm -rf ~)",
		"{ rm -rf ~; }",
		"ls & rm -rf ~",
		"ls &",
		"cat <<EOF\nhi\nEOF",
		// 扫描器不能读错的引号。
		'echo \\"; rm -rf ~',
	])
		writes(command);
});

test("扫描器按 bash 的读法认引号和注释：bash 当数据的不当命令", () => {
	// 反斜杠转义了引号，整段是 echo 的一个参数。
	readOnly('echo "a\\"; rm -rf ~; echo"');
	readOnly("echo done # rm -rf ~");
});

test("打头的 cd 只在看得出去哪时才算", () => {
	// 回家目录、回上一个目录、变量、可能指向别处的 glob，或者不止一个 cd：都看不出后面读的是哪里。
	for (const command of [
		"cd && cat .ssh/id_rsa",
		"cd ~root && cat .ssh/id_rsa",
		"cd - && cat secrets.txt",
		"cd $HOME && cat .ssh/id_rsa",
		"cd lnk* && cat secrets.txt",
		"cd -P out && cat secrets.txt",
		"cd a && cd .. && cat secrets.txt",
		"ls && cd .. && cat secrets.txt",
		"cd a; cat secrets.txt",
		"cd a",
	])
		writes(command);
});

test("以 glob 开头的词可能展开成旗标，而旗标可能会写", () => {
	// 目录里有个叫 `--output=x` 的文件，`git diff *` 就成了写。
	for (const command of ["git diff *", "rg TODO *", "fd x ?", "git log '--output='*"]) writes(command);
	// 没有会写的旗标，或者 glob 只能展开成固定开头的名字，仍然只读。
	for (const command of ["ls *.ts", "wc -l src/*.ts", "git branch --list feat*", "cat docs/*.md | head"]) readOnly(command);
});

test("sed 读一段行是只读的，别的 sed 都不是", () => {
	for (const command of [
		"sed -n '1,80p' src/a.ts",
		"sed -n 120,160p a.ts b.ts",
		"sed -n 5p a.ts",
		'cd backend && sed -n "1,60p" main.go | head',
		"ls migrations | sed -n '1,60p'",
	])
		readOnly(command);
	for (const command of [
		// 会写、会跑：sed 不上只读表的原因。
		"sed -i '' 1d a.ts",
		"sed -n 1,5p -i a.ts",
		"sed -n '1,5w out.txt' a.ts",
		"sed -n '1e rm -rf ~' a.ts",
		"sed -n '1,5p;w out.txt' a.ts",
		// 允许的那一种形状以外的写法。
		"sed 's/a/b/' a.ts",
		"sed -n '/^fmt:/,/^$/p' Makefile",
		"sed 1,5p a.ts",
		// 目录里一个叫 `-i` 的文件会把 `*` 变成原地改写。
		"sed -n 1,5p *",
	])
		writes(command);
});
