/**
 * 一个文件是什么，用来回答两件事：画哪个图标，以及它的字节能不能进提示词。
 *
 * 后一件是重点：不是图片的一律 `file.text()` 的话，`.doc` 这种复合二进制文档会被当 UTF-8 解码，
 * 模型收到几千行替换字符。所以先问它是什么。
 *
 * 先看扩展名，再看 MIME：浏览器给 `.doc` 报的类型不一致，有时什么都不报，名字是唯一总会带来的东西。
 *
 * 纯函数，`node --test` 能把每种情况都过一遍。
 */

import type { MessageKey } from "@plume/ui";

export type FileKind =
	| "image"
	| "video"
	| "audio"
	| "pdf"
	| "word"
	| "excel"
	| "powerpoint"
	| "archive"
	| "design"
	| "font"
	| "binary"
	| "text"
	/** 一整个目录。不从名字猜，只有拖进来时 `webkitGetAsEntry` 说它是目录才会是它，见 `picked.ts`。 */
	| "folder";

const BY_EXTENSION: Record<string, FileKind> = {
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	bmp: "image",
	svg: "image",
	avif: "image",
	heic: "image",
	ico: "image",
	tiff: "image",
	tif: "image",

	mp4: "video",
	mov: "video",
	avi: "video",
	mkv: "video",
	webm: "video",
	flv: "video",
	wmv: "video",
	m4v: "video",
	mpeg: "video",
	mpg: "video",

	mp3: "audio",
	wav: "audio",
	flac: "audio",
	aac: "audio",
	ogg: "audio",
	m4a: "audio",
	wma: "audio",
	opus: "audio",
	aiff: "audio",

	pdf: "pdf",
	doc: "word",
	docx: "word",
	rtf: "word",
	odt: "word",
	pages: "word",
	xls: "excel",
	xlsx: "excel",
	xlsm: "excel",
	xlsb: "excel",
	ods: "excel",
	numbers: "excel",
	// 表格软件打开它，图标就该是表格；能不能当文本读另由 `isReadableAsText` 答。
	csv: "excel",
	tsv: "excel",
	ppt: "powerpoint",
	pptx: "powerpoint",
	odp: "powerpoint",
	key: "powerpoint",

	zip: "archive",
	rar: "archive",
	"7z": "archive",
	tar: "archive",
	gz: "archive",
	bz2: "archive",
	xz: "archive",
	dmg: "archive",
	iso: "archive",
	jar: "archive",
	war: "archive",

	ttf: "font",
	otf: "font",
	woff: "font",
	woff2: "font",
	eot: "font",

	exe: "binary",
	dll: "binary",
	so: "binary",
	dylib: "binary",
	bin: "binary",
	node: "binary",
	class: "binary",
	pyc: "binary",
	wasm: "binary",
	db: "binary",
	sqlite: "binary",
	sqlite3: "binary",
	// 设计稿也是二进制，但「打不开的可执行文件」和「同事发来的设计稿」在列表里是两件事，单独一档。
	psd: "design",
	ai: "design",
	sketch: "design",
	fig: "design",
	xd: "design",
	afdesign: "design",
	blend: "design",
};

/** 小写的扩展名；没有扩展名、或者连名字都没有时是空串。 */
function extensionOf(name: string): string {
	// 名字不一定是字符串：转录里的附件是一段没人再校验过的数据，而这是渲染期的调用。
	const base = (typeof name === "string" ? name : "").toLowerCase().split(/[/\\]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1) : "";
}

export function fileKind(name: string, mimeType = ""): FileKind {
	const byExtension = BY_EXTENSION[extensionOf(name)];
	if (byExtension) return byExtension;

	// 兜到字符串：默认参数只挡得住 undefined，挡不住 null，而 null.startsWith 会让整个界面白掉。
	const mime = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("font/")) return "font";
	if (mime === "application/pdf") return "pdf";
	if (mime.includes("wordprocessing") || mime === "application/msword") return "word";
	if (mime.includes("spreadsheet") || mime === "application/vnd.ms-excel") return "excel";
	if (mime.includes("presentation") || mime === "application/vnd.ms-powerpoint") return "powerpoint";
	if (mime.includes("zip") || mime.includes("compressed") || mime.includes("tar")) return "archive";
	if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || mime.includes("javascript")) {
		return "text";
	}

	/*
	 * 认不出的当文本。没有扩展名也没有类型的多半真是文本（`Dockerfile`、`LICENSE`、忘了起名的脚本）；
	 * 读之前还会看一眼字节，见 `looksBinary`。
	 */
	return "text";
}

/**
 * 一份已经发出去的附件按什么门类画。
 *
 * 记下来的 `kind` 绝大多数时候是对的，但它是一段之后再没人校验过的字符串；而「图片」这个答案会被一路信到底
 * （取像素、画缩略图、菜单里给「复制图片」），一份 `.md` 记成图片就是一张裂开的图。所以「图片」要经得起名字
 * 和类型的复核：两者有一样在、又都说不是图，就听它们的。别的门类不复核，记错了顶多图标不对。认不出的字符串
 * 退回现算。
 */
export function sentKind(file: { name: string; kind?: string | null; mimeType?: string | null }): FileKind {
	const mime = typeof file.mimeType === "string" ? file.mimeType : "";
	const guessed = fileKind(file.name, mime);
	const recorded = typeof file.kind === "string" && Object.hasOwn(KIND_LABEL, file.kind) ? (file.kind as FileKind) : undefined;
	if (!recorded) return guessed;
	if (recorded === "image" && guessed !== "image" && (extensionOf(file.name) !== "" || mime !== "")) return guessed;
	return recorded;
}

/** `csv`、`tsv` 的图标是表格，内容却是纯文本：图标和能不能读是两个决定，这里按扩展名再问一次。 */
const TEXT_DESPITE_KIND = new Set(["csv", "tsv"]);

/** 提示词能不能带上这个文件的内容，而不只是名字。 */
export function isReadableAsText(kind: FileKind, name = ""): boolean {
	if (kind === "text") return true;
	return TEXT_DESPITE_KIND.has(extensionOf(name));
}

/**
 * 看字节判断是不是二进制：文件可以叫任何名字，扩展名只是第一道。
 *
 * 两个便宜的信号：出现 NUL 字节；或者文本里不会出现的控制字符占比过高。只看前 8KB——前 8KB 是文本的就是文本，
 * 为了确定去读一百兆比判断错的代价大。
 */
export function looksBinary(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 8192);
	if (sample.length === 0) return false;

	let suspicious = 0;
	for (const byte of sample) {
		if (byte === 0) return true;
		// C0 控制字符，去掉真实文本里会有的那三个（\t \n \r 一带）。
		if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious++;
	}
	return suspicious / sample.length > 0.05;
}

/** 每种门类叫什么。存 key，画的时候再查：这张表在导入时就建好了，语言会变。 */
export const KIND_LABEL: Record<FileKind, MessageKey> = {
	image: "fileKind.image",
	video: "fileKind.video",
	audio: "fileKind.audio",
	pdf: "fileKind.pdf",
	word: "fileKind.word",
	excel: "fileKind.spreadsheet",
	powerpoint: "fileKind.slides",
	archive: "fileKind.archive",
	design: "fileKind.design",
	font: "fileKind.font",
	binary: "fileKind.binary",
	text: "fileKind.text",
	folder: "fileKind.folder",
};
