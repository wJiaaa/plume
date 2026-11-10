/**
 * 每种门类的图标和颜色。
 *
 * 一类一个，不是一个扩展名一个：`.mov` 和 `.mp4` 对看列表的人是同一种东西。颜色和形状一样承担辨认——Word 蓝、
 * Excel 绿、PDF 红是用久了的约定，跟着它走，不读文件名也扫得出来；所以颜色不跟主题、不跟皮肤变。
 */

import { type FileLook, TokenGlyph, tokenLook } from "@plume/ui";
import {
	Binary,
	File as FileIcon,
	FileArchive,
	FileHeadphone,
	FileImage,
	FilePlay,
	FileSpreadsheet,
	FileText,
	FileType,
	Folder,
	Palette,
	Presentation,
} from "@plume/ui/icons";
import type { FileKind } from "./file-kind.ts";

const tone = (Icon: FileLook["Icon"], colour: string): FileLook => ({ Icon, light: colour, dark: colour });

/** 句子里那枚标记前面的图标：认不出文件类型时按门类画。灰的两档是「没什么可说的」那几类。 */
const KIND_LOOK: Record<FileKind, FileLook> = {
	image: tone(FileImage, "#8b5cf6"),
	video: tone(FilePlay, "#ec4899"),
	audio: tone(FileHeadphone, "#f59e0b"),
	pdf: tone(FileText, "#ef4444"),
	word: tone(FileText, "#2b7cd3"),
	excel: tone(FileSpreadsheet, "#16a34a"),
	powerpoint: tone(Presentation, "#ea580c"),
	archive: tone(FileArchive, "#a16207"),
	design: tone(Palette, "#d946ef"),
	font: tone(FileType, "#0ea5e9"),
	binary: tone(Binary, "#8d8d8d"),
	text: tone(FileIcon, "#8d8d8d"),
	folder: tone(Folder, "#8d8d8d"),
};

/**
 * 标记前面那枚图标：文件树认得出的（`a.ts`、`x.json`、文件夹）用文件树那张表，认不出的按门类。两种画在同一个
 * 位置，大小由 `.plume-token-glyph` 定。
 */
export function MarkGlyph({ name, kind }: { name: string; kind: FileKind }) {
	return <TokenGlyph look={tokenLook(name, kind) ?? KIND_LOOK[kind]} />;
}

/** 附件格子上（图片解不出来、退回成文件那一格）的门类图标。灰的几类跟着字色走，别的用约定色。 */
export function FileKindIcon({ kind, size = 14 }: { kind: FileKind; size?: number }) {
	const look = KIND_LOOK[kind];
	const muted = kind === "binary" ? "text-ink-faint" : kind === "text" || kind === "folder" ? "text-ink-muted" : "";
	return <look.Icon size={size} strokeWidth={1.8} className={`shrink-0 ${muted}`} style={muted ? undefined : { color: look.light }} />;
}
