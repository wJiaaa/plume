/**
 * 工作区改了什么。
 *
 * 自己算 diff，不让 git 排版成补丁：界面要的是能画、能数的 hunk，不是一段还得再解析的文字。
 * 大文件有上限：生成出来的包没人逐行看，放在内存里也帮不了谁。
 */

import { open } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ChangeHunk } from "@plume/contract";
import type { DiffBlob, DiffFile, FileStatus, WorkspaceDiff } from "../api.ts";
import { readBlobs, type BlobRead } from "./blobs.ts";
import { mapLimit, MAX_BLOB_BYTES, MAX_FILES } from "./exec.ts";
import { computeDiff } from "@plume/platform";
import { parseStatusZ } from "./parse.ts";
import { gitBranch, isGitRepo } from "./probe.ts";
import { withView, type RepoView } from "./view.ts";

/**
 * 没提交的改动，按面板显示的样子。`status` 给文件列表，两边内容一边来自 `cat-file`、一边来自工作区，
 * hunk 在这里算。`base` 为 `index` 时只看没暂存的部分（暂存区对工作区）。
 */
export async function collectWorkspaceDiff(cwd: string, base: "head" | "index" = "head"): Promise<WorkspaceDiff> {
	const empty: WorkspaceDiff = { files: [], added: 0, removed: 0, branch: null };
	if (!(await isGitRepo(cwd))) return empty;
	const branch = await gitBranch(cwd);
	return (await withView(cwd, (view) => workspaceDiffIn(view, base, branch)).catch(() => null)) ?? empty;
}

async function workspaceDiffIn(view: RepoView, base: "head" | "index", branch: string | null): Promise<WorkspaceDiff> {
	const { cwd } = view;
	/*
	 * `-uall`：默认情况下整个没跟踪的目录会被折成一行 `src/`，面板只能说「这个目录没跟踪」——而一个新功能的
	 * 一堆新文件正是最该看的；改动计数也会和面板对不上，因为计数走的是真实的文件列表。
	 */
	const status = await view.git(["status", "--porcelain=v1", "-uall", "-z", "--ignore-submodules=dirty"]).catch(() => "");

	const changed: { path: string; beforePath: string; kind: FileStatus }[] = [];
	for (const { code, path, source } of parseStatusZ(status).entries) {
		if (changed.length >= MAX_FILES) break;
		if (base === "index" && code[1] === " ") continue;
		changed.push({ path, beforePath: base === "head" ? source : path, kind: classify(base === "index" ? (code[1] ?? "") : code) });
	}

	// 两边各一批，而不是每个文件两次读：提交的一边走一次 `cat-file --batch`，工作区一边是读文件，重叠着读。
	const heads = await readBlobs(
		view,
		changed.map((entry) => (entry.kind === "added" || entry.kind === "untracked" ? "" : `${base === "head" ? "HEAD" : ""}:${entry.beforePath}`)),
	);
	const working = await mapLimit(changed, (entry) => (entry.kind === "deleted" ? Promise.resolve(blank) : readWorking(cwd, entry.path)));

	const files: DiffFile[] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	changed.forEach(({ path, kind }, i) => {
		const before = kind === "added" || kind === "untracked" ? blank : sideOfBlob(heads[i] ?? null);
		const after = working[i] ?? blank;
		/*
		 * 不是文本的文件照样是改了的文件：列出来、标上，没有 hunk，行数是 0——图片要么变了要么没变，没有哪一行可指。
		 * 跳过它，改图就从审阅里消失了；把它当文本比，删一张图会算成五行 PNG 头的删除。
		 */
		if (before.binary || after.binary) {
			files.push({ path, status: kind, added: 0, removed: 0, hunks: [], binary: true, bytes: after.bytes || before.bytes });
			return;
		}
		const diff = computeDiff(asCheckedOut(before.text, after.text), after.text);
		totalAdded += diff.added;
		totalRemoved += diff.removed;
		files.push({ path, status: kind, added: diff.added, removed: diff.removed, hunks: capHunks(diff.hunks) });
	});

	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files, added: totalAdded, removed: totalRemoved, branch };
}

export function classify(code: string): FileStatus {
	if (code.includes("?")) return "untracked";
	if (code.includes("A")) return "added";
	if (code.includes("D")) return "deleted";
	if (code.includes("R")) return "renamed";
	return "modified";
}

/** 比较的一边：文字，或者说明它没有文字。`binary` 是一种回答，不是缺席：删掉的文件和图片得分得开。 */
interface Side {
	text: string;
	binary: boolean;
	bytes: number;
}

const blank: Side = { text: "", binary: false, bytes: 0 };

/** 提交里的这一边。批量读拒绝读的是超过上限的，回答和二进制一样：列出来、说多大、不比。 */
function sideOfBlob(read: BlobRead | null): Side {
	if (!read) return blank;
	if (!read.content) return { text: "", binary: true, bytes: read.bytes };
	return sideOf(read.content);
}

async function readWorking(cwd: string, path: string): Promise<Side> {
	const read = await readCapped(join(cwd, path), MAX_BLOB_BYTES);
	if (!read) return blank;
	return read.buffer ? sideOf(read.buffer) : { text: "", binary: true, bytes: read.bytes };
}

/**
 * 工作区的一个文件；超过 `cap` 时只给大小。先看大小再读：先读后比会把项目里每个没跟踪的视频、数据库导出
 * 在每次刷新时都读进内存一遍。读不了时为空。
 */
export async function readCapped(path: string, cap: number): Promise<{ buffer: Buffer | null; bytes: number } | null> {
	const handle = await open(path, "r").catch(() => null);
	if (!handle) return null;
	try {
		const { size } = await handle.stat();
		if (size > cap) return { buffer: null, bytes: size };
		const buffer = await handle.readFile();
		return { buffer, bytes: buffer.length };
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => {});
	}
}

/** 有 NUL 字节就不是文本，和 git 自己的判断一样；太大的也当二进制，下游的处理是一样的。 */
function sideOf(buffer: Buffer): Side {
	const binary = buffer.length > MAX_BLOB_BYTES || buffer.includes(0);
	return { text: binary ? "" : buffer.toString("utf8"), binary, bytes: buffer.length };
}

/**
 * 按检出时的样子看提交的文字。blob 存的是 LF，Windows 上的 git 默认检出成 CRLF：照存的样子比，每一行都不同，
 * 改一行显示成整个文件重写。只在工作区通篇 CRLF、提交的一边没有 `\r` 时转换，真改了换行符仍然显示成改动。
 */
function asCheckedOut(committed: string, working: string): string {
	if (committed.includes("\r") || !working.includes("\r\n")) return committed;
	if (/\r(?!\n)|(?<!\r)\n/.test(working)) return committed;
	return committed.replaceAll("\n", "\r\n");
}

/** 几百个 hunk 的文件只带前一部分。 */
export function capHunks(hunks: ChangeHunk[]): ChangeHunk[] {
	return hunks.slice(0, 40);
}

/**
 * 二进制文件多大以内还给预览。data URL 是 base64，比文件大三分之一，整个落进渲染进程的内存：
 * 截图、图标、示意图都在 8MB 以内，视频和模型权重用不着在 diff 里预览。
 */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/**
 * 会画的扩展名和对应的类型。用封闭的名单而不是嗅探：结果是一个 `data:` 地址，类型决定渲染进程怎么对待它，
 * 把不是 SVG 的东西猜成 `image/svg+xml` 等于把任意标记交给 `<img>`。
 */
const PREVIEW_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	icns: "image/x-icns",
	svg: "image/svg+xml",
};

function previewType(path: string): string | null {
	const dot = path.lastIndexOf(".");
	return dot > 0 ? (PREVIEW_TYPES[path.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/** 解析后落在 `root` 里面的绝对路径；跑出去（`../../.ssh/id_rsa`）为空。 */
function resolveInside(root: string, path: string): string | null {
	const base = resolve(root);
	const full = resolve(base, path);
	return full.startsWith(base + sep) ? full : null;
}

/**
 * 二进制文件的一边，画成图用。不画的（不是图片、太大、这一边不存在）为空，界面改写大小。
 * 路径必须落在仓库里：一个能被要到 `../../.ssh/id_rsa` 的 diff 面板，就是套着相框的任意读文件。
 */
export async function readDiffBlob(cwd: string, path: string, side: "head" | "work"): Promise<DiffBlob | null> {
	const type = previewType(path);
	if (!type) return null;
	const inside = resolveInside(cwd, path);
	if (!inside) return null;
	const buffer =
		side === "head"
			? await withView(cwd, (view) => view.gitBuffer(["show", `HEAD:${path}`])).catch(() => null)
			: ((await readCapped(inside, MAX_PREVIEW_BYTES))?.buffer ?? null);
	if (!buffer || buffer.length === 0 || buffer.length > MAX_PREVIEW_BYTES) return null;
	return { dataUrl: `data:${type};base64,${buffer.toString("base64")}`, bytes: buffer.length };
}
