/**
 * 宿主进程里对「沙箱可写的仓库」跑 git，而不执行仓库能控制的任何程序。
 *
 * `workspace-write` 下 `.git/config`、`.git/info/attributes`、`.gitattributes` 都是沙箱内命令可写的，
 * 而 git 会照着它们去执行程序：`filter.<名>.clean/smudge/process`（计算工作区文件哈希、
 * `cat-file --filters` 时）、`core.fsmonitor`（任何一次读 index）、`post-index-change` 等钩子
 * （写回 index 时）、`diff.external`/`diff.<名>.textconv`（生成补丁时）、`log.showSignature` 带出的
 * `gpg.program`、partial clone 的惰性拉取（读缺失对象时，经 `remote.*.uploadpack`、`core.sshCommand`、`ext::` 传输）。
 * 宿主不在沙箱里，于是「沙箱写一行配置，宿主下一次调用替它执行」——断网也挡不住。
 *
 * `-c` 只能压住名字固定的键，压不住驱动名由仓库自己取的 `filter.<名>.*`、`diff.<名>.*`；
 * `info/attributes` 也关不掉。所以这里不去逐项压制，而是让 git 根本读不到仓库的配置：
 *
 * - 只有 `rev-parse`（找目录、解析 HEAD 为 oid，不读对象、不读 index）、`symbolic-ref`、
 *   `for-each-ref`（只读引用）和 `config --list`（纯读取）在真实仓库上跑。
 * - 其余命令在一个我们自己生成的 `GIT_DIR` 里跑：配置文件只含白名单里的纯数据键
 *   （换行转换、大小写、stat 比较方式、忽略/属性文件路径、改名的判定，以及分支的上游和远端的地址），
 *   系统与全局配置关掉，没有钩子目录，没有远端和 promisor，`refs` 照真实仓库抄一份（`packed-refs` 和松散的符号引用），
 *   浅克隆的边界也抄过去。index 和对象库经 `GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY` 指回真实仓库，工作区经 `GIT_WORK_TREE`。
 *   属性里写了 `filter=x`、`diff=x` 也没用：配置里没有这个驱动，git 按没有处理。
 * - 这个目录放在 Plume 的数据目录下而不是系统临时目录：后者是沙箱可写根之一，后台命令可以抢在
 *   git 读之前往里写配置。
 * - 宿主自己环境里的 `GIT_*` 一律去掉，只留下面明确设的那些（见 `@plume/platform` 的 `gitEnv`）。
 *
 * 换行转换（`core.autocrlf`、`eol=crlf`）仍然由 git 按原规则做。代价：用了 split index（`core.splitIndex`）
 * 的仓库在视图里读不到共享 index，调用会失败，调用方按「答不上来」处理（项目文件清单退回自己走目录）；
 * 全局配置里的过滤器（git lfs）在视图里也没有，被碰过的 LFS 文件会显示成改了。
 *
 * 用它的：项目文件清单（`project-files.ts`，插件经 `ctx.workspace.files`）、文件面板找回复里写的文件
 * （`@plume/agent` 的 `files.ts`）、命令前后对比（`command-changes.ts`），以及插件经 `ctx.workspace.git`
 * 读写仓库的那套完整视图（引用、上游、获取）。
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gitEnv, gitFile } from "@plume/platform";

const exec = promisify(execFile);

export interface HostRepo {
	root: string;
	commonDir: string;
	index: string;
	/** HEAD 的 oid；未出生的分支为 null。 */
	head: string | null;
	/** 写进视图 `config` 的全文，打开仓库时算一次。 */
	config: string;
}

/** 完整视图要的那几样：HEAD 原文、引用、浅克隆的边界。比 `HostRepo` 多两条只读命令。 */
interface HostRepoView {
	root: string;
	objects: string;
	index: string;
	infoDir: string;
	shallow: string;
	/** 写进视图 `HEAD` 的全文：`ref: refs/heads/x\n` 或分离的 oid。 */
	headLine: string;
	refs: { oid: string; name: string; target: string }[];
	config: string;
}

export type HostGit = (args: string[]) => Promise<string>;

/**
 * 从真实配置里带进视图的键：都是纯数据，没有一个会让 git 启动程序。
 * 带它们是为了让 git 在视图里做出和在真实仓库里一样的判断（换行转换、文件是否变了、哪些被忽略、改名怎么认）。
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

function baseEnv(): NodeJS.ProcessEnv {
	// 双保险：视图里本来就没有 promisor 与分页器，旧版 git 不认的变量会被忽略。
	return { ...gitEnv(process.env), GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" };
}

/** 一次 git 最多输出多少、跑多久；视图里的调用可以各自放宽（文件面板列整个仓库）。 */
export interface GitLimits {
	maxBuffer?: number;
	timeout?: number;
}

async function run(cwd: string, args: string[], env: NodeJS.ProcessEnv, limits: GitLimits = {}): Promise<string> {
	const { maxBuffer = 20 * 1024 * 1024, timeout = 5000 } = limits;
	return (await exec(gitFile(), [...HARDENING, ...args], { cwd, env, maxBuffer, timeout, windowsHide: true })).stdout;
}

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

/** 找到 cwd 所在的仓库；不在仓库里返回 null。只跑不会执行仓库程序的两条命令。 */
export async function openRepo(cwd: string): Promise<HostRepo | null> {
	const env = baseEnv();
	let located: string[];
	try {
		located = (await run(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-path", "index"], env))
			.trim()
			.split(/\r?\n/);
	} catch {
		return null;
	}
	const [root, commonDir, index] = located;
	if (!root || !commonDir || !index) return null;
	let head: string | null;
	try {
		head = (await run(root, ["rev-parse", "-q", "--verify", "HEAD"], env)).trim() || null;
	} catch {
		head = null;
	}
	const config = viewConfig(await run(root, ["config", "--list", "-z"], env).catch(() => ""));
	return { root, commonDir, index, head, config };
}

const REF_FORMAT = "--format=%(objectname) %(refname) %(symref)";

function parseRefs(out: string): HostRepoView["refs"] {
	const refs: HostRepoView["refs"] = [];
	for (const line of out.split("\n")) {
		const [oid = "", name = "", target = ""] = line.trim().split(" ");
		if (oid && name.startsWith("refs/")) refs.push({ oid, name, target });
	}
	return refs;
}

/**
 * 完整视图照着的真实仓库：多读 HEAD 的原文、全部引用和浅克隆的边界。
 * 引用的命令都只读引用、不读 index、不读对象内容，所以仍可以在这几条上碰真实配置；别的读一律进视图。
 */
async function openViewRepo(cwd: string): Promise<HostRepoView | null> {
	const env = baseEnv();
	let located: string[];
	try {
		located = (
			await run(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-path", "index", "--git-path", "shallow"], env)
		)
			.trim()
			.split(/\r?\n/);
	} catch {
		return null;
	}
	const [root, commonDir, index, shallow] = located;
	if (!root || !commonDir || !index || !shallow) return null;
	const [symbolic, detached, listing, refs] = await Promise.all([
		run(cwd, ["symbolic-ref", "-q", "HEAD"], env).then(
			(out) => out.trim(),
			() => "",
		),
		run(cwd, ["rev-parse", "-q", "--verify", "HEAD"], env).then(
			(out) => out.trim(),
			() => "",
		),
		run(root, ["config", "--list", "-z"], env).catch(() => ""),
		run(root, ["for-each-ref", REF_FORMAT], env).catch(() => ""),
	]);
	// 还没有提交的分支 `symbolic-ref` 照样答得出；两个都答不出的 HEAD 没法照着搭。
	const headLine = symbolic ? `ref: ${symbolic}\n` : detached ? `${detached}\n` : null;
	if (!headLine) return null;
	return {
		root,
		objects: join(commonDir, "objects"),
		index,
		infoDir: join(commonDir, "info"),
		shallow,
		headLine,
		refs: parseRefs(refs),
		config: viewConfig(listing),
	};
}

/** 双保险：视图的配置里本来就是 false。 */
const HARDENING = ["-c", "core.fsmonitor=false"];

/** 照仓库搭一个视图目录。`repo` 有引用时（`openViewRepo`）HEAD、引用、浅克隆边界都抄过去；没有就只搭一个空仓库。 */
async function buildView(dir: string, repo: HostRepoView | HostRepo): Promise<void> {
	await mkdir(join(dir, "refs"));
	await mkdir(join(dir, "info"));
	const rich = "refs" in repo ? repo : null;
	await writeFile(join(dir, "HEAD"), rich ? rich.headLine : "ref: refs/heads/plume-view\n");
	await writeFile(join(dir, "config"), repo.config);
	if (rich) {
		// 符号引用写成松散的符号引用，别的进 `packed-refs`。
		await writeFile(join(dir, "packed-refs"), rich.refs.flatMap((ref) => (ref.target ? [] : [`${ref.oid} ${ref.name}\n`])).join(""));
		for (const ref of rich.refs) {
			if (!ref.target) continue;
			// git 列出来的引用名不会带 `..`，这里还是不让它写到视图外面去。
			const file = resolve(dir, ref.name);
			if (!file.startsWith(dir + sep)) continue;
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, `ref: ${ref.target}\n`);
		}
	}
	// 忽略规则、属性、浅克隆的边界都是数据；属性里的 `filter=`、`diff=` 在这里找不到驱动，不会执行。
	const infoDir = "commonDir" in repo ? join(repo.commonDir, "info") : repo.infoDir;
	const sources: [string, string][] = [
		[join(infoDir, "exclude"), join(dir, "info", "exclude")],
		[join(infoDir, "attributes"), join(dir, "info", "attributes")],
	];
	if (rich) sources.push([rich.shallow, join(dir, "shallow")]);
	for (const [from, to] of sources) {
		const content = await readFile(from).catch(() => undefined);
		if (content) await writeFile(to, content);
	}
}

/**
 * 在隔离的 `GIT_DIR` 里跑一组 git 命令，结束即删。视图放在 `dataDir`（Plume 的数据目录）的 `git-views/` 下，理由见文件开头。
 * `cwd` 是命令在工作区里的哪个目录跑（路径、pathspec 相对它，和在那里直接跑 git 一样），缺省是仓库根。
 */
export async function withRepoView<T>(
	repo: HostRepo,
	dataDir: string,
	work: (git: HostGit) => Promise<T>,
	options: GitLimits & { cwd?: string } = {},
): Promise<T> {
	return withViewDir(repo, dataDir, options, async (env, cwd, limits) => work((args) => run(cwd, args, env, limits)));
}

/** 一个会话里读仓库时能用的完整视图，见 `ctx.workspace.git`。 */
export interface PluginRepoView {
	/** 调用方给的目录：命令在这里跑，路径和在真实仓库里一样相对于它所在的检出。 */
	cwd: string;
	git(args: string[]): Promise<string>;
	/** 不替调用方决定回答是不是文字：`git show HEAD:logo.png` 回的是 PNG，按 UTF-8 解码就成了乱码。 */
	gitBuffer(args: string[]): Promise<Uint8Array>;
	/** 要往 stdin 写的那一个调用（`cat-file --batch`）用。 */
	gitWithInput(args: string[], input: string): Promise<Uint8Array>;
	/** 没人点的那种获取：在视图里获取，再把变了的引用搬回真实仓库。 */
	fetch(options: { signal?: AbortSignal; timeoutMs: number }): Promise<{ ok: true } | { ok: false; cancelled?: boolean; timedOut?: boolean; stderr?: string }>;
}

async function withViewDir<T>(
	repo: HostRepo | HostRepoView,
	dataDir: string,
	options: GitLimits & { cwd?: string },
	work: (env: NodeJS.ProcessEnv, cwd: string, limits: GitLimits) => Promise<T>,
	userConfig = false,
): Promise<T> {
	const parent = join(dataDir, "git-views");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const dir = await mkdtemp(join(parent, "view-"));
	try {
		await buildView(dir, repo);
		const { cwd = repo.root, ...limits } = options;
		return await work(viewEnvironment(dir, repo, userConfig), cwd, limits);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * 视图的环境。读的时候系统与全局配置也关掉：要用的键已经从合并后的配置里抄进来了，别的一概不要。
 * 获取（`userConfig`）留着它们：凭据助手、ssh 设置、`insteadOf` 是人自己配的，没有它们连不上；仓库自己的配置照样读不到。
 */
function viewEnvironment(dir: string, repo: HostRepo | HostRepoView, userConfig: boolean): NodeJS.ProcessEnv {
	return {
		...baseEnv(),
		GIT_DIR: dir,
		GIT_WORK_TREE: repo.root,
		GIT_INDEX_FILE: repo.index,
		GIT_OBJECT_DIRECTORY: "objects" in repo ? repo.objects : join(repo.commonDir, "objects"),
		GIT_ATTR_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		...(userConfig ? {} : { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "no-global-config") }),
	};
}

/**
 * 完整视图：引用、上游、二进制输出、要写 stdin 的调用都在。
 *
 * 一次读共用一个视图：搭一个要先在真实仓库上跑几条命令，每条读各搭一个就是每次刷新几十个进程。
 * `cwd` 不在检出里时返回 null，由调用方当作「读不了」。
 */
export async function withPluginView<T>(cwd: string, dataDir: string, work: (view: PluginRepoView) => Promise<T>): Promise<T | null> {
	const repo = await openViewRepo(cwd);
	if (!repo) return null;
	return withViewDir(repo, dataDir, { cwd, maxBuffer: 32 * 1024 * 1024 }, async (env, where) => {
		const options = { cwd: where, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true };
		const runInView = (args: string[], encoding: "utf8" | "buffer") =>
			exec(gitFile(), [...HARDENING, ...args], { ...options, encoding }).then((result) => result.stdout);
		return work({
			cwd,
			git: async (args) => runInView(args, "utf8") as Promise<string>,
			gitBuffer: async (args) => runInView(args, "buffer") as Promise<Uint8Array>,
			gitWithInput: (args, input) => withInput(where, args, env, input),
			fetch: (options) => fetchInView(repo, dataDir, options),
		});
	});
}

/** 写一段 stdin、把输出整份收下来。`cat-file --batch` 一次要走几百个修订，逐段拼但设上限。 */
const MAX_INPUT_OUTPUT_BYTES = 64 * 1024 * 1024;

function withInput(cwd: string, args: string[], env: NodeJS.ProcessEnv, input: string): Promise<Uint8Array> {
	return new Promise((done, fail) => {
		const child = spawn(gitFile(), [...HARDENING, ...args], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Uint8Array[] = [];
		let size = 0;
		let settled = false;
		const stop = (error: Error) => {
			if (settled) return;
			settled = true;
			child.kill();
			fail(error);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			// 失控的一批直接杀掉，不让它撑满堆。
			if (size > MAX_INPUT_OUTPUT_BYTES) return stop(new Error("git output too large"));
			chunks.push(chunk);
		});
		child.on("error", stop);
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			const output = Buffer.concat(chunks);
			if (code !== 0) return fail(new Error(`git ${args[0] ?? ""} exited with ${code ?? "signal"}`));
			done(output);
		});
		// stdin 出错是子进程已经走了，`close` 会报。
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
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
async function fetchInView(
	repo: HostRepoView,
	dataDir: string,
	{ signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ ok: true } | { ok: false; cancelled?: boolean; timedOut?: boolean; stderr?: string }> {
	return withViewDir(
		repo,
		dataDir,
		{ cwd: repo.root },
		async (env, cwd) => {
			const remoteEnv = { ...env, GCM_INTERACTIVE: "never" };
			try {
				await exec(
					gitFile(),
					[
						...HARDENING,
						"-c",
						"credential.interactive=false",
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
					{ cwd, env: remoteEnv, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, signal, windowsHide: true },
				);
			} catch (error) {
				const detail = error as { stderr?: string; message?: string; killed?: boolean; name?: string };
				// 先认取消：被中止的子进程也是被杀掉的，先问 `killed` 会把每次取消都报成超时。
				if (detail.name === "AbortError") return { ok: false, cancelled: true };
				if (detail.killed) return { ok: false, timedOut: true };
				return { ok: false, stderr: (detail.stderr ?? detail.message ?? "").trim() };
			}

			const dir = String(env.GIT_DIR);
			const shallowBefore = await readFile(repo.shallow).catch(() => null);
			const shallowAfter = await readFile(join(dir, "shallow")).catch(() => null);
			const sameShallow = shallowBefore === null || shallowAfter === null ? shallowBefore === shallowAfter : shallowBefore.equals(shallowAfter);
			if (!sameShallow) return { ok: false };

			const after = parseRefs(
				(await exec(gitFile(), [...HARDENING, "for-each-ref", REF_FORMAT], { cwd, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true })).stdout,
			);
			const before = new Map(repo.refs.filter((ref) => !ref.target).map((ref) => [ref.name, ref.oid]));
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
				{ ...gitEnv(process.env), GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
				`${commands.join("\n")}\n`,
			);
			return moved ? { ok: true } : { ok: false };
		},
		true,
	);
}
