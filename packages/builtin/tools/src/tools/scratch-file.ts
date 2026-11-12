/**
 * write、edit 认的地址。读地址归本体（`ToolRun.files.read`）；写这一侧还在这里：唯一可写的地址是本体的 `scratch://`
 * （会话的临时目录），write 写进去、edit 改它，和 read 认的是同一个文件。
 *
 * 落点的判定和本体 `scratch://` 读时的是同一套（字面和顺着软链的真实落点都得在临时目录里）。
 */

import { mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { resolveInside, withinOrIs } from "@plume/platform";
import type { ToolContext } from "./types.ts";

/** 一个地址：有人登记了的 scheme、`://` 后面去掉行范围的路径段、有没有行范围。 */
interface Address {
	scheme: string;
	segments: string[];
	ranged: boolean;
	raw: string;
	writable: boolean;
}

/** scheme 的写法和末尾的行范围，和本体拆地址的规则一样：必须有 `://`，`C:\Users` 不是地址。 */
const URL_PATTERN = /^([a-z][a-z0-9-]*):\/\/(.*)$/i;
const RANGE_PATTERN = /:(\d+)(?:-(\d+))?$/;

/** `input` 是有人登记了的地址时拆开它，别的（普通路径、没人认的 `foo://`）是 null。不给登记表（直接调工具的测试）时都是 null。 */
export function addressOf(ctx: Pick<ToolContext, "resources">, input: string): Address | null {
	if (!ctx.resources || typeof input !== "string") return null;
	const match = URL_PATTERN.exec(input.trim());
	if (!match) return null;
	const scheme = match[1]!.toLowerCase();
	const known = ctx.resources.list().find((entry) => entry.scheme === scheme);
	if (!known) return null;
	const ranged = RANGE_PATTERN.exec(match[2]!);
	const path = ranged ? match[2]!.slice(0, ranged.index) : match[2]!;
	return { scheme, segments: path.split("/").filter(Boolean), ranged: Boolean(ranged), raw: input.trim(), writable: known.writable };
}

/**
 * `scratch://x` 指的磁盘上的那个文件，别的都是 null。
 *
 * read 和 edit 得认同一个文件：先读再改的记录按文件记。只有 read 经地址读、edit 却把地址当相对路径（`<项目>/scratch:/x`）的话，
 * 每次改临时文件都报「先读一遍」，重读也没用。带行范围的（`scratch://x:10-40`）还是地址：那是一段，不是一个文件。
 */
export async function scratchFile(ctx: Pick<ToolContext, "resources" | "scratchDir">, input: string): Promise<string | null> {
	const address = addressOf(ctx, input);
	if (address?.scheme !== "scratch" || address.ranged) return null;
	return scratchTarget(address, ctx.scratchDir);
}

/**
 * 把 `content` 写进一个地址。可写的只有 `scratch://`，其余的拒掉正是要的：能 `write skill://<名字>` 的模型就能改掉它该遵守的说明。
 * 抛的错交给模型。
 */
export async function writeAddress(ctx: Pick<ToolContext, "scratchDir">, address: Address, content: string): Promise<void> {
	// i18n-exempt：交给模型的工具结果。
	if (address.scheme !== "scratch" || !address.writable) throw new Error(`\`${address.scheme}://\` 是只读的，不能写。`);
	// 先查真实落点再建目录：顺着软链先在外面把目录建出来，查出来也晚了。
	const target = await scratchTarget(address, ctx.scratchDir);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content, "utf8");
}

/**
 * 临时目录里的一条路径，字面和真实落点都得在目录里：目录里一条指向外面的软链，就能让 write 覆盖或新建用户的任何文件。
 */
async function scratchTarget(address: Address, scratchDir: string | undefined): Promise<string> {
	// i18n-exempt：交给模型的工具结果。
	if (!scratchDir) throw new Error("这个会话没有临时目录。");
	const target = resolveInside(scratchDir, address.segments.join("/"));
	// i18n-exempt：交给模型的工具结果。
	if (!target) throw new Error(`\`${address.raw}\` 指到了临时目录外面。`);
	// i18n-exempt：交给模型的工具结果。
	if (!(await stillInside(scratchDir, target))) throw new Error(`\`${address.raw}\` 经过软链后指到了临时目录外面。`);
	return target;
}

/** 顺着软链再查一遍还在不在里面（根也按同一个办法取：临时目录第一次写之前还不存在）。 */
async function stillInside(root: string, resolved: string): Promise<boolean> {
	const [realRoot, realChild] = await Promise.all([realLocation(root), realLocation(resolved)]);
	return withinOrIs(realRoot, realChild);
}

/** 一条路径真正落在哪里，包括还不存在的：悬空软链跟着它走，真不存在的取最近一个存在的父目录的真实位置，再接上剩下的部分。 */
async function realLocation(path: string, hops = 0): Promise<string> {
	const real = await realpath(path).catch(() => null);
	if (real !== null) return real;
	const link = hops < 40 ? await readlink(path).catch(() => null) : null;
	if (link !== null) return realLocation(resolve(dirname(path), link), hops + 1);
	const parent = dirname(path);
	if (parent === path) return path;
	return join(await realLocation(parent, hops), basename(path));
}
