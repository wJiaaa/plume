import {
	Braces,
	FileArchive,
	FileAudio,
	FileCode,
	FileImage,
	FileJson,
	FileLock,
	FileSpreadsheet,
	FileTerminal,
	FileText,
	FileType,
	FileVideo,
	Folder,
	FolderOpen,
	GitBranch,
	Hash,
	Palette,
	Settings,
	type LucideIcon,
} from "./icons/index.ts";

/**
 * 一个文件在列表里长什么样。
 *
 * 颜色是重点。四十行一样灰的树得一行一行读；同一棵树有了 TypeScript 的蓝、JSON 的琥珀、Markdown 的
 * 石板灰，一眼就读完了，因为眼睛先找到一组，再读名字。
 *
 * 色相跟着人们在编辑器里已经习惯的约定走——TS 蓝、JS 黄、Rust 锈色——而不是这里另起一套。没人认得
 * 的配色只是装饰。
 *
 * 每种颜色都给两套主题各一个值：在白底上读得清的中间调，放到近黑的底上是浑的，反过来也一样。
 */
export interface FileLook {
	Icon: LucideIcon;
	/** 不走 Tailwind：行内设上，因为这些颜色不在主题推导的色阶里。 */
	light: string;
	dark: string;
}

const NEUTRAL: FileLook = { Icon: FileText, light: "#8a8d90", dark: "#7e8184" };

/** 整个文件名匹配优先于扩展名——`package.json` 不只是又一个 JSON 文件。 */
const BY_NAME: Record<string, FileLook> = {
	"package.json": { Icon: Braces, light: "#8b5a2b", dark: "#cb9a63" },
	"package-lock.json": { Icon: FileLock, light: "#8a8d90", dark: "#7e8184" },
	"pnpm-lock.yaml": { Icon: FileLock, light: "#8a8d90", dark: "#7e8184" },
	"yarn.lock": { Icon: FileLock, light: "#8a8d90", dark: "#7e8184" },
	"pnpm-workspace.yaml": { Icon: Settings, light: "#b0632a", dark: "#e0955c" },
	"tsconfig.json": { Icon: Settings, light: "#2f74c0", dark: "#63a6e8" },
	"tsconfig.base.json": { Icon: Settings, light: "#2f74c0", dark: "#63a6e8" },
	dockerfile: { Icon: FileCode, light: "#1d63ed", dark: "#6f9bf0" },
	makefile: { Icon: FileTerminal, light: "#7d6b3f", dark: "#bda878" },
	".gitignore": { Icon: GitBranch, light: "#d1533a", dark: "#e8836b" },
	".gitattributes": { Icon: GitBranch, light: "#d1533a", dark: "#e8836b" },
	".env": { Icon: FileLock, light: "#9a7d16", dark: "#d8bd4e" },
	"readme.md": { Icon: FileText, light: "#3d7cc9", dark: "#7fb1e8" },
	license: { Icon: FileText, light: "#9a7d16", dark: "#d8bd4e" },
};

const BY_EXTENSION: Record<string, FileLook> = {
	// TypeScript / JavaScript
	ts: { Icon: FileCode, light: "#2f74c0", dark: "#63a6e8" },
	tsx: { Icon: FileCode, light: "#2f74c0", dark: "#63a6e8" },
	mts: { Icon: FileCode, light: "#2f74c0", dark: "#63a6e8" },
	cts: { Icon: FileCode, light: "#2f74c0", dark: "#63a6e8" },
	js: { Icon: FileCode, light: "#b8951a", dark: "#e6c85a" },
	jsx: { Icon: FileCode, light: "#b8951a", dark: "#e6c85a" },
	mjs: { Icon: FileCode, light: "#b8951a", dark: "#e6c85a" },
	cjs: { Icon: FileCode, light: "#b8951a", dark: "#e6c85a" },

	// Data
	json: { Icon: FileJson, light: "#b0761c", dark: "#e2ab55" },
	jsonc: { Icon: FileJson, light: "#b0761c", dark: "#e2ab55" },
	yaml: { Icon: FileCode, light: "#7b52ab", dark: "#b48ede" },
	yml: { Icon: FileCode, light: "#7b52ab", dark: "#b48ede" },
	toml: { Icon: FileCode, light: "#7d6b3f", dark: "#bda878" },
	xml: { Icon: FileCode, light: "#5f8a3a", dark: "#9dc873" },
	csv: { Icon: FileSpreadsheet, light: "#2f7d4f", dark: "#6fc191" },
	sql: { Icon: FileSpreadsheet, light: "#b0632a", dark: "#e0955c" },

	// Web
	html: { Icon: FileCode, light: "#c1502a", dark: "#ec8a63" },
	htm: { Icon: FileCode, light: "#c1502a", dark: "#ec8a63" },
	css: { Icon: Palette, light: "#2f74c0", dark: "#63a6e8" },
	scss: { Icon: Palette, light: "#c04277", dark: "#ec84b0" },
	sass: { Icon: Palette, light: "#c04277", dark: "#ec84b0" },
	less: { Icon: Palette, light: "#2b4c8c", dark: "#7d9ce0" },
	vue: { Icon: FileCode, light: "#2f9268", dark: "#6fce9f" },
	svelte: { Icon: FileCode, light: "#c1502a", dark: "#ec8a63" },

	// Other languages
	py: { Icon: FileCode, light: "#2f6fa8", dark: "#6fa8dc" },
	rs: { Icon: FileCode, light: "#a3562a", dark: "#dd9160" },
	go: { Icon: FileCode, light: "#1c7d8e", dark: "#5ec4d6" },
	java: { Icon: FileCode, light: "#a8442a", dark: "#e08668" },
	kt: { Icon: FileCode, light: "#7b52ab", dark: "#b48ede" },
	rb: { Icon: FileCode, light: "#a8242a", dark: "#e06d72" },
	php: { Icon: FileCode, light: "#5b6ba8", dark: "#98a6e0" },
	swift: { Icon: FileCode, light: "#c1502a", dark: "#ec8a63" },
	c: { Icon: FileCode, light: "#4a6f9c", dark: "#8fb2dd" },
	h: { Icon: FileCode, light: "#4a6f9c", dark: "#8fb2dd" },
	cpp: { Icon: FileCode, light: "#2f74c0", dark: "#63a6e8" },
	hpp: { Icon: FileCode, light: "#2f74c0", dark: "#63a6e8" },
	cs: { Icon: FileCode, light: "#4a8a3a", dark: "#8ccb73" },
	sh: { Icon: FileTerminal, light: "#4a7d4a", dark: "#8cc48c" },
	bash: { Icon: FileTerminal, light: "#4a7d4a", dark: "#8cc48c" },
	zsh: { Icon: FileTerminal, light: "#4a7d4a", dark: "#8cc48c" },

	// Prose
	md: { Icon: FileText, light: "#3d7cc9", dark: "#7fb1e8" },
	mdx: { Icon: FileText, light: "#3d7cc9", dark: "#7fb1e8" },
	txt: NEUTRAL,

	// Media
	png: { Icon: FileImage, light: "#2f9268", dark: "#6fce9f" },
	jpg: { Icon: FileImage, light: "#2f9268", dark: "#6fce9f" },
	jpeg: { Icon: FileImage, light: "#2f9268", dark: "#6fce9f" },
	gif: { Icon: FileImage, light: "#2f9268", dark: "#6fce9f" },
	webp: { Icon: FileImage, light: "#2f9268", dark: "#6fce9f" },
	avif: { Icon: FileImage, light: "#2f9268", dark: "#6fce9f" },
	bmp: { Icon: FileImage, light: "#2f9268", dark: "#6fce9f" },
	ico: { Icon: FileImage, light: "#2f9268", dark: "#6fce9f" },
	svg: { Icon: FileImage, light: "#b0761c", dark: "#e2ab55" },
	mp4: { Icon: FileVideo, light: "#7b52ab", dark: "#b48ede" },
	webm: { Icon: FileVideo, light: "#7b52ab", dark: "#b48ede" },
	mov: { Icon: FileVideo, light: "#7b52ab", dark: "#b48ede" },
	mkv: { Icon: FileVideo, light: "#7b52ab", dark: "#b48ede" },
	avi: { Icon: FileVideo, light: "#7b52ab", dark: "#b48ede" },
	mp3: { Icon: FileAudio, light: "#c04277", dark: "#ec84b0" },
	wav: { Icon: FileAudio, light: "#c04277", dark: "#ec84b0" },
	flac: { Icon: FileAudio, light: "#c04277", dark: "#ec84b0" },
	ogg: { Icon: FileAudio, light: "#c04277", dark: "#ec84b0" },
	m4a: { Icon: FileAudio, light: "#c04277", dark: "#ec84b0" },

	// Bundles and binaries
	zip: { Icon: FileArchive, light: "#8a6f3a", dark: "#c9ab6f" },
	tar: { Icon: FileArchive, light: "#8a6f3a", dark: "#c9ab6f" },
	gz: { Icon: FileArchive, light: "#8a6f3a", dark: "#c9ab6f" },
	tgz: { Icon: FileArchive, light: "#8a6f3a", dark: "#c9ab6f" },
	rar: { Icon: FileArchive, light: "#8a6f3a", dark: "#c9ab6f" },
	"7z": { Icon: FileArchive, light: "#8a6f3a", dark: "#c9ab6f" },
	pdf: { Icon: FileType, light: "#b8342a", dark: "#e87d72" },
	woff: { Icon: Hash, light: "#7b52ab", dark: "#b48ede" },
	woff2: { Icon: Hash, light: "#7b52ab", dark: "#b48ede" },
	ttf: { Icon: Hash, light: "#7b52ab", dark: "#b48ede" },
	otf: { Icon: Hash, light: "#7b52ab", dark: "#b48ede" },
};

const DIRECTORY: FileLook = { Icon: Folder, light: "#6f8ab0", dark: "#93aed6" };
const DIRECTORY_OPEN: FileLook = { Icon: FolderOpen, light: "#6f8ab0", dark: "#93aed6" };

export function lookFor(name: string, isDirectory: boolean, expanded = false): FileLook {
	if (isDirectory) return expanded ? DIRECTORY_OPEN : DIRECTORY;

	const lower = name.toLowerCase();
	const byName = BY_NAME[lower];
	if (byName) return byName;

	// `.d.ts` 和 `.tar.gz` 的意思，光看最后一段看不出来。
	if (lower.endsWith(".d.ts")) return { Icon: FileCode, light: "#4a7d9c", dark: "#8fbcdd" };
	if (lower.endsWith(".tar.gz")) return BY_EXTENSION.gz ?? NEUTRAL;

	const dot = lower.lastIndexOf(".");
	// 开头的点是整个名字（`.env`），不是扩展名。
	if (dot <= 0) return NEUTRAL;
	return BY_EXTENSION[lower.slice(dot + 1)] ?? NEUTRAL;
}

/**
 * 只给认得出的：名字和扩展名都对不上时返回 `null`，而不是那个灰色的通用图标。
 *
 * 认不出时调用方往往有更好的说法——附件标记知道自己是 Word 还是压缩包，那份门类图标比一张灰纸有用。
 */
function knownLook(name: string): FileLook | null {
	const look = lookFor(name, false);
	return look === NEUTRAL ? null : look;
}

/** 取在当前主题下读得清的那个色值。深浅色跟随系统，和 theme.css 的 `prefers-color-scheme` 一致。 */
export function iconColour(look: FileLook): string {
	return matchMedia("(prefers-color-scheme: dark)").matches ? look.dark : look.light;
}

/**
 * 附件标记前面那枚图标该是什么：和文件树、回复里的文件链接同一张表。
 *
 * 只按门类画的话（`.plume-attachment-token[data-kind]` 那十几枚），`starship.toml`、`a.ts`、`x.json`
 * 都落在「文本」那一档，是同一张灰纸，文件夹也只是另一种灰。表里认不出的（Word、表格、压缩包……）
 * 返回 `null`，由门类图标接着画——那些本来就按常见配色挑过，比通用的灰纸强。
 */
export function tokenLook(name: string | undefined, kind?: string): FileLook | null {
	if (kind === "folder") return lookFor(name ?? "", true);
	return name ? knownLook(name) : null;
}

/** 画出来的那一枚。大小和位置由 `.plume-token-glyph` 定，和门类图标住同一个位置。 */
export function TokenGlyph({ look }: { look: FileLook }) {
	return <look.Icon aria-hidden strokeWidth={2} className="plume-token-glyph" style={{ color: iconColour(look) }} />;
}
