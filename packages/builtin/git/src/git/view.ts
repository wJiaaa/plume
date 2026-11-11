/**
 * 读仓库而不执行仓库能控制的任何程序。
 *
 * 面板一露面、一轮在跑时每 1.5 秒，这个插件就在宿主进程里（不在沙箱里）读一遍仓库：status、diff、numstat、log、
 * cat-file；面板开着时还每五分钟悄悄获取一次。没有人点任何东西。而 `workspace-write` 下 `.git/config`、
 * `.git/info/attributes`、`.gitattributes` 都是沙箱里的命令写得到的，git 会照着它们去执行程序：`core.fsmonitor`
 * （任何一次读 index）、`filter.<名>.clean/process`（给 stat 变了的文件算哈希）、`diff.external`、
 * `diff.<名>.textconv`（`--numstat` 也用）、`log.showSignature` 带出的 `gpg.program`、写回 index 时的钩子、
 * partial clone 的惰性拉取和获取本身（`remote.*.uploadpack`、`core.sshCommand`、`credential.helper`、`ext::`）、
 * 进子模块跑的 status（子模块自己的配置）。于是「沙箱写一行配置，面板下一次刷新在沙箱外替它执行」。
 *
 * `-c` 只压得住名字固定的键，压不住驱动名由仓库自己取的 `filter.<名>.*`、`diff.<名>.*`，`info/attributes` 也关不掉。
 * 所以不逐项压制，而是让 git 读不到仓库的配置（和 plume.tools 的 `host-git.ts` 同一个办法）：
 *
 * - 真实仓库上只跑不读 index、不读对象内容的几条：`rev-parse`、`symbolic-ref`、`for-each-ref`、`config --list`
 *   （`exec.ts` 给前三种关了惰性拉取），用来找目录、抄下 HEAD、引用和配置。
 * - 其余的读在一个自己生成的 `GIT_DIR`（视图）里跑：配置只有白名单里的纯数据键，系统与全局配置关掉，没有钩子、
 *   没有 promisor。index、对象库经 `GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY` 指回真实仓库，工作区经 `GIT_WORK_TREE`；
 *   HEAD 和引用照真实仓库抄一份（`packed-refs`，符号引用照样写成符号引用），配置里带上算上游要的 `branch.*`、`remote.*`
 *   那几个键，分支、ahead / behind、log 的装饰就和在真实仓库里一样。属性里写了 `filter=x`、`diff=x` 也没用：
 *   视图的配置里没有这个驱动，git 按没有处理。
 * - 碰工作区的 status、diff 由调用方带 `--ignore-submodules=dirty`：不进子模块跑 status；子模块指向的提交变了照样报。
 * - 视图放在插件的数据目录下，不在系统临时目录：后者是沙箱可写根之一，后台命令可以抢在 git 读之前往里写配置。
 *
 * 边界：人点了按钮才做的事（暂存、提交、推送、拉取、手动获取、切分支、建工作树和它之前的获取、合并同步）仍在真实仓库上跑——
 * 人在操作自己的仓库，钩子、凭据助手正是他要的。
 *
 * 代价：git lfs 这类全局配置里的过滤器在视图里也没有，被碰过（stat 变了）的 LFS 文件会显示成改了；用了 split index
 * 的仓库在视图里读不到共享 index，读会失败，面板显示为空。全局配置在读的视图里也关着，因为它不一定在沙箱外：dotfiles 仓库、
 * 家目录当项目打开时，`~/.gitconfig`（或它 include 的文件）就在某个会话的可写根里。
 *
 * 已知风险：后台静默获取的视图留着系统和全局配置——凭据助手、ssh 设置、`insteadOf` 多半写在那里，关掉它们，用全局凭据的
 * 远端静默获取就都悄悄失败了。所以上面那种「全局配置在可写根里」的情形下，沙箱写进全局配置的 `core.sshCommand`、
 * `credential.helper` 会在下一次静默获取时执行。那时它已经是一次独立的逃逸（人在任何终端里跑 git 都会执行它），这里只是
 * 不用等人动手；要堵就得不开静默获取，或者只在可写根里没有全局配置时才开。
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { RemoteResult } from "../api.ts";
import { git, gitFile, isolatedEnvironment, runRemote } from "./exec.ts";
import { say } from "./say.ts";

const execFileAsync = promisify(execFile);

/** 逻辑入口在 `apply` 里换成插件自己的数据目录；测试直接用的是这个缺省值。 */
let viewsDir = join(homedir(), ".plume", "plugin-data", "plume.git", "views");

export function setViewsDir(dataDir: string): void {
	viewsDir = join(dataDir, "views");
}

/** 在视图里跑 git：和 `exec.ts` 的 `git` 一样的回答，只是读不到仓库的配置。 */
export interface RepoView {
	/** 调用方给的目录：命令在这里跑，路径和在真实仓库里一样相对于它所在的检出。 */
	cwd: string;
	git(args: string[]): Promise<string>;
	/** 不替调用方决定回答是不是文字：`git show HEAD:logo.png` 回的是 PNG，按 UTF-8 解码就成了乱码。 */
	gitBuffer(args: string[]): Promise<Buffer>;
	/** 要往 stdin 写的那一个调用（`cat-file --batch`）用。 */
	spawnGit(args: string[]): ChildProcessWithoutNullStreams;
}

/**
 * 从真实配置里带进视图的键：都是纯数据，没有一个会让 git 启动程序。前面这些让 git 在视图里做出和在真实仓库里
 * 一样的判断（换行转换、文件是否变了、哪些被忽略、改名怎么认）。
 */
const KEPT_KEYS = new Set([
	"core.autocrlf",
	"core.eol",
	"core.checkroundtripencoding",
	"core.ignorecase",
	"core.precomposeunicode",
	"core.protectntfs",
	"core.protecthfs",
	"core.longpaths",
	"core.filemode",
	"core.symlinks",
	"core.trustctime",
	"core.checkstat",
	"core.excludesfile",
	"core.attributesfile",
	"diff.renames",
	"diff.renamelimit",
	"status.renames",
	"status.renamelimit",
]);

/** 带子节的键：分支的上游、远端的地址和映射。只是数据：读不连远端，获取时由 git 自己守着地址里的传输方式。 */
const KEPT_SUBSECTION_KEYS: Record<string, Set<string>> = {
	branch: new Set(["remote", "merge"]),
	remote: new Set(["url", "fetch", "tagopt"]),
};

function quote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

/**
 * `config --list -z` 里挑白名单键，拼成视图用的配置文件。按原顺序一条一节地写：单值键后出现的覆盖先出现的，
 * 多值键（`remote.*.fetch`）全留着，都和 git 读原配置时一样。键名里节和变量名是小写，子节保留原样，可以带点。
 */
function viewConfig(listing: string): string {
	let objectFormat: string | undefined;
	const kept: string[] = [];
	for (const entry of listing.split("\0")) {
		if (!entry) continue;
		const split = entry.indexOf("\n");
		const key = split === -1 ? entry : entry.slice(0, split);
		const value = split === -1 ? "true" : entry.slice(split + 1);
		const first = key.indexOf(".");
		const last = key.lastIndexOf(".");
		if (first <= 0 || last === key.length - 1) continue;
		const section = key.slice(0, first).toLowerCase();
		const name = key.slice(last + 1).toLowerCase();
		if (first === last) {
			if (`${section}.${name}` === "extensions.objectformat") objectFormat = value;
			else if (KEPT_KEYS.has(`${section}.${name}`)) kept.push(`[${section}]`, `\t${name} = ${quote(value)}`);
		} else if (KEPT_SUBSECTION_KEYS[section]?.has(name)) {
			kept.push(`[${section} ${quote(key.slice(first + 1, last))}]`, `\t${name} = ${quote(value)}`);
		}
	}
	const lines = ["[core]", `\trepositoryformatversion = ${objectFormat ? 1 : 0}`, "\tbare = false", "\tfsmonitor = false", "\tsafecrlf = false", ...kept];
	if (objectFormat) lines.push("[extensions]", `\tobjectformat = ${quote(objectFormat)}`);
	return `${lines.join("\n")}\n`;
}

interface Ref {
	oid: string;
	name: string;
	/** 符号引用指向的引用名；不是符号引用为空串。 */
	target: string;
}

const REF_FORMAT = "--format=%(objectname) %(refname) %(symref)";

function parseRefs(out: string): Ref[] {
	const refs: Ref[] = [];
	for (const line of out.split("\n")) {
		const [oid = "", name = "", target = ""] = line.trim().split(" ");
		if (oid && name.startsWith("refs/")) refs.push({ oid, name, target });
	}
	return refs;
}

/** 真实仓库的样子：视图照着它搭，获取完拿它比出改了哪些引用。 */
interface Snapshot {
	root: string;
	objects: string;
	index: string;
	infoDir: string;
	shallow: string;
	head: string;
	refs: Ref[];
	config: string;
}

/** 只跑不读 index、不读对象内容的几条命令。不在检出里（裸仓库、`.git` 目录里面）为空。 */
async function snapshot(cwd: string): Promise<Snapshot | null> {
	let located: string[];
	try {
		located = (await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-path", "index", "--git-path", "shallow"]))
			.trim()
			.split(/\r?\n/);
	} catch {
		return null;
	}
	const [root, commonDir, index, shallow] = located;
	if (!root || !commonDir || !index || !shallow) return null;
	const [symbolic, detached, listing, refs] = await Promise.all([
		git(cwd, ["symbolic-ref", "-q", "HEAD"]).then(
			(out) => out.trim(),
			() => "",
		),
		git(cwd, ["rev-parse", "-q", "--verify", "HEAD"]).then(
			(out) => out.trim(),
			() => "",
		),
		git(cwd, ["config", "--list", "-z"]).catch(() => ""),
		git(cwd, ["for-each-ref", REF_FORMAT]).catch(() => ""),
	]);
	// 还没有提交的分支 `symbolic-ref` 照样答得出；两个都答不出的 HEAD 没法照着搭。
	const head = symbolic ? `ref: ${symbolic}\n` : detached ? `${detached}\n` : null;
	if (!head) return null;
	return {
		root,
		objects: join(commonDir, "objects"),
		index,
		infoDir: join(commonDir, "info"),
		shallow,
		head,
		refs: parseRefs(refs),
		config: viewConfig(listing),
	};
}

/** 照快照搭一个视图目录。符号引用写成松散的符号引用，别的进 `packed-refs`。 */
async function build(snap: Snapshot): Promise<string> {
	await mkdir(viewsDir, { recursive: true, mode: 0o700 });
	const dir = await mkdtemp(join(viewsDir, "view-"));
	try {
		await mkdir(join(dir, "refs"));
		await mkdir(join(dir, "info"));
		await writeFile(join(dir, "HEAD"), snap.head);
		await writeFile(join(dir, "config"), snap.config);
		await writeFile(join(dir, "packed-refs"), snap.refs.flatMap((ref) => (ref.target ? [] : [`${ref.oid} ${ref.name}\n`])).join(""));
		for (const ref of snap.refs) {
			if (!ref.target) continue;
			// git 列出来的引用名不会带 `..`，这里还是不让它写到视图外面去。
			const file = resolve(dir, ref.name);
			if (!file.startsWith(dir + sep)) continue;
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, `ref: ${ref.target}\n`);
		}
		// 忽略规则、属性、浅克隆的边界都是数据；属性里的 `filter=`、`diff=` 在这里找不到驱动，不会执行。
		for (const [from, to] of [
			[join(snap.infoDir, "exclude"), join(dir, "info", "exclude")],
			[join(snap.infoDir, "attributes"), join(dir, "info", "attributes")],
			[snap.shallow, join(dir, "shallow")],
		] as const) {
			const content = await readFile(from).catch(() => undefined);
			if (content) await writeFile(to, content);
		}
		return dir;
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

/**
 * 视图的环境。读的时候系统与全局配置也关掉：要用的键已经从合并后的配置里抄进来了，别的一概不要。
 * 获取（`userConfig`）留着它们：凭据助手、ssh 设置、`insteadOf` 是人自己配的，没有它们连不上；仓库自己的配置照样读不到。
 */
function viewEnvironment(dir: string, snap: Snapshot, userConfig: boolean): NodeJS.ProcessEnv {
	return isolatedEnvironment({
		GIT_DIR: dir,
		GIT_WORK_TREE: snap.root,
		GIT_INDEX_FILE: snap.index,
		GIT_OBJECT_DIRECTORY: snap.objects,
		GIT_ATTR_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		...(userConfig ? {} : { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "no-global-config") }),
	});
}

/** 双保险：视图的配置里本来就是 false。 */
const HARDENING = ["-c", "core.fsmonitor=false"];

/**
 * 在视图里做一组读，结束即删。`cwd` 不在检出里时为空。
 * 一组读共用一个视图：搭一个要先在真实仓库上跑四条命令，每条读各搭一个就是每次刷新几十个进程。
 */
export async function withView<T>(cwd: string, work: (view: RepoView) => Promise<T>): Promise<T | null> {
	const snap = await snapshot(cwd);
	if (!snap) return null;
	const dir = await build(snap);
	const env = viewEnvironment(dir, snap, false);
	const options = { cwd, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true };
	try {
		return await work({
			cwd,
			git: async (args) => (await execFileAsync(gitFile(), [...HARDENING, ...args], options)).stdout,
			gitBuffer: async (args) => (await execFileAsync(gitFile(), [...HARDENING, ...args], { ...options, encoding: "buffer" })).stdout,
			spawnGit: (args) => spawn(gitFile(), [...HARDENING, ...args], { cwd, env, windowsHide: true }),
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** 往 stdin 写一段再等它退出，答成没成。 */
function feed(cwd: string, args: string[], env: NodeJS.ProcessEnv, input: string): Promise<boolean> {
	return new Promise((done) => {
		const child = spawn(gitFile(), args, { cwd, env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
		child.on("error", () => done(false));
		child.on("close", (code) => done(code === 0));
		// stdin 出错是子进程已经走了，`close` 会报。
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

/**
 * 没人点的那种获取（面板露面时、之后每五分钟）：在视图里获取，再把变了的引用搬回真实仓库。
 *
 * 视图里有真实仓库全部的引用，协商和在真实仓库里一样，只下新的对象，对象直接落进真实的对象库。获取时关掉自动 gc 和
 * 维护（视图看不到真实的 index、reflog，在那里收垃圾会删掉还有用的对象）、不进子模块、不认 `ext::`。
 * 搬引用用 `update-ref --stdin`，每条带着抄快照时的旧值：这期间有人动过就整批不搬；钩子目录指向一个不存在的地方，
 * `reference-transaction` 钩子不跑。符号引用不搬（`origin/HEAD`），浅克隆的边界变了也不搬，留给人点的那次获取。
 */
export async function fetchInView(cwd: string, { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number }): Promise<RemoteResult> {
	const snap = await snapshot(cwd);
	if (!snap) return { ok: false, error: say().actionFailed };
	const dir = await build(snap);
	try {
		const env = { ...viewEnvironment(dir, snap, true), GCM_INTERACTIVE: "never" };
		const fetched = await runRemote(
			cwd,
			[
				...HARDENING,
				"-c",
				"gc.auto=0",
				"-c",
				"maintenance.auto=false",
				"-c",
				"fetch.writeCommitGraph=false",
				"-c",
				"protocol.ext.allow=never",
				"fetch",
				"--prune",
				"--no-recurse-submodules",
			],
			{ timeoutMs, signal, env },
		);
		if (!fetched.ok) return fetched;

		const shallowBefore = await readFile(snap.shallow).catch(() => null);
		const shallowAfter = await readFile(join(dir, "shallow")).catch(() => null);
		const sameShallow = shallowBefore === null || shallowAfter === null ? shallowBefore === shallowAfter : shallowBefore.equals(shallowAfter);
		if (!sameShallow) return { ok: false, error: say().actionFailed };

		const after = parseRefs(
			(await execFileAsync(gitFile(), [...HARDENING, "for-each-ref", REF_FORMAT], { cwd, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true })).stdout,
		);
		const before = new Map(snap.refs.filter((ref) => !ref.target).map((ref) => [ref.name, ref.oid]));
		const commands: string[] = [];
		for (const ref of after) {
			if (ref.target) continue;
			const old = before.get(ref.name);
			before.delete(ref.name);
			if (old === undefined) commands.push(`create ${ref.name} ${ref.oid}`);
			else if (old !== ref.oid) commands.push(`update ${ref.name} ${ref.oid} ${old}`);
		}
		// 视图里没了的就是 `--prune` 删掉的。
		for (const [name, oid] of before) commands.push(`delete ${name} ${oid}`);
		if (commands.length === 0) return { ok: true };

		const moved = await feed(
			cwd,
			[...HARDENING, "-c", `core.hooksPath=${join(dir, "no-hooks")}`, "update-ref", "--stdin"],
			isolatedEnvironment({ GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }),
			`${commands.join("\n")}\n`,
		);
		return moved ? { ok: true } : { ok: false, error: say().actionFailed };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
