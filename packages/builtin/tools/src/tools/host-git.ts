/**
 * 宿主进程里对「沙箱可写的仓库」跑 git，而不执行仓库能控制的任何程序。
 *
 * `workspace-write` 下 `.git/config`、`.git/info/attributes`、`.gitattributes` 都是沙箱内命令可写的，
 * 而 git 会照着它们去执行程序：`filter.<名>.clean/smudge/process`（计算工作区文件哈希、
 * `cat-file --filters` 时）、`core.fsmonitor`（任何一次读 index）、`post-index-change` 等钩子
 * （写回 index 时）、`diff.external`/`diff.<名>.textconv`（生成补丁时）、partial clone 的
 * 惰性拉取（读缺失对象时，经 `remote.*.uploadpack`、`core.sshCommand`、`ext::` 传输）。宿主不在
 * 沙箱里，于是「沙箱写一行配置，宿主下一次调用替它执行」——断网也挡不住。
 *
 * `-c` 只能压住名字固定的键，压不住驱动名由仓库自己取的 `filter.<名>.*`、`diff.<名>.*`；
 * `info/attributes` 也关不掉。所以这里不去逐项压制，而是让 git 根本读不到仓库的配置：
 *
 * - 只有 `rev-parse`（找目录、解析 HEAD 为 oid，不读对象、不读 index）和 `config --list`
 *   （纯读取）在真实仓库上跑。
 * - 其余命令在一个我们自己生成的 `GIT_DIR` 里跑：配置文件只含白名单里的几个纯数据键
 *   （换行转换、大小写、stat 比较方式、忽略/属性文件路径），系统与全局配置关掉，没有钩子目录，
 *   没有远端和 promisor，`refs` 是空的（也就没有 replace 引用）。index 和对象库经
 *   `GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY` 指回真实仓库，工作区经 `GIT_WORK_TREE`。
 *   属性里写了 `filter=x`、`diff=x` 也没用：配置里没有这个驱动，git 按没有处理。
 * - 这个目录放在 Plume 的数据目录下而不是系统临时目录：后者是沙箱可写根之一，后台命令可以抢在
 *   git 读之前往里写配置。
 * - 宿主自己环境里的 `GIT_*` 一律去掉，只留下面明确设的那些。
 *
 * 换行转换（`core.autocrlf`、`eol=crlf`）仍然由 git 按原规则做，所以 `command-changes.ts`
 * 要解决的「CRLF 检出被记成整文件改写」照旧成立。代价：用了 split index（`core.splitIndex`）
 * 的仓库在视图里读不到共享 index，调用会失败，变更记录退化为提示「未记录」。
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appHome } from "./home.ts";

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

export type HostGit = (args: string[]) => Promise<string>;

/**
 * 从真实配置里带进视图的键：都是纯数据，没有一个会让 git 启动程序。
 * 带它们是为了让 git 在视图里做出和在真实仓库里一样的判断（换行转换、文件是否变了、哪些被忽略）。
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
]);

function baseEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
	// 双保险：视图里本来就没有 promisor 与分页器，旧版 git 不认的变量会被忽略。
	return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" };
}

async function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
	return (await exec("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env, maxBuffer: 20 * 1024 * 1024, timeout: 5000, windowsHide: true })).stdout;
}

function quote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

/** `config --list -z` 的输出只挑白名单键，拼成视图用的配置文件。后出现的值覆盖先出现的，与 git 一致。 */
function viewConfig(listing: string): string {
	const kept = new Map<string, string>();
	let objectFormat: string | undefined;
	for (const entry of listing.split("\0")) {
		const split = entry.indexOf("\n");
		const key = (split === -1 ? entry : entry.slice(0, split)).toLowerCase();
		const value = split === -1 ? "true" : entry.slice(split + 1);
		if (KEPT_KEYS.has(key)) kept.set(key.slice("core.".length), value);
		else if (key === "extensions.objectformat") objectFormat = value;
	}
	const lines = ["[core]", `\trepositoryformatversion = ${objectFormat ? 1 : 0}`, "\tbare = false", "\tfsmonitor = false", "\tsafecrlf = false"];
	for (const [key, value] of kept) lines.push(`\t${key} = ${quote(value)}`);
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

/** 在隔离的 `GIT_DIR` 里跑一组 git 命令，结束即删。 */
export async function withRepoView<T>(repo: HostRepo, work: (git: HostGit) => Promise<T>): Promise<T> {
	const parent = join(appHome(), "git-views");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const dir = await mkdtemp(join(parent, "view-"));
	try {
		await mkdir(join(dir, "refs"));
		await mkdir(join(dir, "info"));
		await writeFile(join(dir, "HEAD"), "ref: refs/heads/plume-view\n");
		await writeFile(join(dir, "config"), repo.config);
		// 忽略规则与属性是数据；属性里的 `filter=`/`diff=` 在这里找不到驱动，不会执行。
		for (const name of ["exclude", "attributes"]) {
			const content = await readFile(join(repo.commonDir, "info", name)).catch(() => undefined);
			if (content) await writeFile(join(dir, "info", name), content);
		}
		const env: NodeJS.ProcessEnv = {
			...baseEnv(),
			GIT_DIR: dir,
			GIT_WORK_TREE: repo.root,
			GIT_INDEX_FILE: repo.index,
			GIT_OBJECT_DIRECTORY: join(repo.commonDir, "objects"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(dir, "no-global-config"),
			GIT_ATTR_NOSYSTEM: "1",
			GIT_NO_REPLACE_OBJECTS: "1",
		};
		return await work((args) => run(repo.root, args, env));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
