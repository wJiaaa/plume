/**
 * 一份附件在屏幕上叫什么。
 *
 * 纯函数，`node --test` 能把每种名字都过一遍。写在这里而不是散在渲染里，是因为「这张图该叫图片几」错了没有
 * 任何迹象：界面上是「图片 2」，提示词里是 `image 1 of 1`，人说「看图片 2」，模型去找一个不存在的编号。
 */

import type { FileKind } from "./file-kind.ts";

/** `archive.tar.gz` 是 `.gz`，`.env` 整个是名字。 */
function splitExtension(name: string): [stem: string, extension: string] {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/**
 * 这个名字是不是等于没说。
 *
 * 剪贴板里的图片没有文件名：浏览器给的是 `image.png`，截图粘过来也是它。一排附件里全长一样，指认不了任何
 * 东西，这一类让位给序号。拖进来、选进来的文件不在此列：`report.pdf` 是人自己起的名字。
 *
 * `regionShot` 由调用方传进来，因为它是翻译过的名字。
 */
export function isPlaceholderName(name: string, regionShot?: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return true;
	if (regionShot && trimmed === regionShot) return true;
	const [stem] = splitExtension(trimmed);
	// `image`、`image (1)`、`pasted image`、`screenshot`——加不加序号、用什么分隔都算。
	return /^(image|photo|picture|screenshot|screen[\s_-]?shot|clipboard|pasted[\s_-]?image|untitled)([\s_-]*\(?\d+\)?)?$/i.test(stem);
}

/**
 * 名字拆成可以被省略号吃掉的和不许被吃掉的：扩展名就是类型本身，省略号落在 `.xlsx` 上，一排文件既看不出是
 * 哪一个，也看不出是什么。
 */
export function nameParts(name: string): { stem: string; ext: string } {
	const [stem, extension] = splitExtension(name);
	const ext = extension.replace(/^\./, "");
	// 太长或带空格的不是扩展名：`会议纪要 2026.09.13 定稿` 的最后一段是日期的一部分。
	if (!ext || ext.length > 8 || /\s/.test(ext)) return { stem: name, ext: "" };
	return { stem, ext };
}

/**
 * 这一份写哪几个字。
 *
 * `kindIndex` 是它在同门类里的序号，和提示词里 `image 2 of 3` 数的是同一个数——两边不是同一个数的话，人说的
 * 「图片 2」和模型看到的不是同一张。
 *
 * 图片不管叫什么都按序号称呼：缩略图才是它的辨认方式，而图片的文件名多半是机器起的（`DSC_0042.JPG`、一串
 * 哈希），摆进句子里是一整行噪声。真名照旧进提示词，见 `attachmentImageLabel`。
 */
export function displayName(file: { name: string; kind?: FileKind; kindLabel: string; kindIndex: number }, regionShot?: string): string {
	return file.kind === "image" || isPlaceholderName(file.name, regionShot) ? `${file.kindLabel} ${file.kindIndex}` : file.name;
}
