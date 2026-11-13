/**
 * 一次从仓库里读出很多个 blob。
 *
 * 每个文件每一边一次 `git show`，一百二十个改动文件就是两百多次起进程，时间全花在启动上；同样的量走一次
 * `cat-file --batch` 快一个数量级。分两遍：`--batch-check` 只打印头，几乎不花钱就知道每个多大，超过上限的
 * 根本不读——否则几个大的生成文件会先被整个读进内存再因为太大扔掉。
 */

import { MAX_BLOB_BYTES } from "./exec.ts";
import type { RepoView } from "./view.ts";

/**
 * 一个 blob，值得要的那部分。整条为空：那个提交里没有这个路径；`content` 为空：有，但太大不比。
 * 两种回答不同，后者让调用方说「二进制」而不是「已删除」。
 */
export interface BlobRead {
	bytes: number;
	content: Buffer | null;
}

/** 修订一行一个从 stdin 进去，所以用 `gitWithInput`；路径里带换行会破坏分帧，调用方要先滤掉。 */
function catFile(view: RepoView, revs: string[], args: string[]): Promise<Buffer> {
	return view.gitWithInput(["cat-file", ...args, "--buffer"], `${revs.join("\n")}\n`);
}

/** `--batch-check` 的输出：每个修订一行，`<oid> <type> <size>` 或 `<input> missing`，按请求顺序。 */
function parseSizes(out: Buffer, count: number): (number | null)[] {
	const lines = out.toString("utf8").split("\n");
	const sizes: (number | null)[] = [];
	for (let i = 0; i < count; i++) {
		const parts = (lines[i] ?? "").trim().split(" ");
		const size = Number.parseInt(parts[parts.length - 1] ?? "", 10);
		sizes.push(parts[parts.length - 2] === "blob" && Number.isFinite(size) ? size : null);
	}
	return sizes;
}

/** `--batch` 的输出：一行头，正好 size 个字节，再一个换行。头和预期对不上就停：两遍看到的不是同一个仓库。 */
function parseBlobs(out: Buffer, count: number): (Buffer | null)[] {
	const blobs: (Buffer | null)[] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		const newline = out.indexOf(0x0a, at);
		if (newline < 0) break;
		const header = out.toString("utf8", at, newline);
		at = newline + 1;
		const parts = header.trim().split(" ");
		const size = Number.parseInt(parts[parts.length - 1] ?? "", 10);
		if (parts[parts.length - 2] !== "blob" || !Number.isFinite(size)) {
			blobs.push(null);
			continue;
		}
		if (at + size > out.length) break;
		blobs.push(out.subarray(at, at + size));
		// 内容后面是 git 自己加的换行，不属于 blob。
		at += size + 1;
	}
	while (blobs.length < count) blobs.push(null);
	return blobs;
}

/**
 * 按顺序读出每个修订（`HEAD:src/main.ts`、`:staged.ts`、`abc123:old.ts`，`git show` 认的都行）。
 * 空字符串表示调用方已知没有这一边，不发；带换行的路径没法分帧，回空，不为它放弃整批。
 */
export async function readBlobs(view: RepoView, revs: string[]): Promise<(BlobRead | null)[]> {
	const out: (BlobRead | null)[] = revs.map(() => null);
	const asked: number[] = [];
	for (const [i, rev] of revs.entries()) if (rev && !rev.includes("\n")) asked.push(i);
	if (asked.length === 0) return out;

	const sizes = parseSizes(
		await catFile(
			view,
			asked.map((i) => revs[i] as string),
			["--batch-check"],
		),
		asked.length,
	);
	const wanted: number[] = [];
	asked.forEach((slot, i) => {
		const size = sizes[i];
		if (size === null || size === undefined) return;
		if (size > MAX_BLOB_BYTES) {
			out[slot] = { bytes: size, content: null };
			return;
		}
		wanted.push(slot);
	});
	if (wanted.length === 0) return out;

	const blobs = parseBlobs(
		await catFile(
			view,
			wanted.map((i) => revs[i] as string),
			["--batch"],
		),
		wanted.length,
	);
	wanted.forEach((slot, i) => {
		const content = blobs[i];
		out[slot] = content ? { bytes: content.length, content } : null;
	});
	return out;
}
