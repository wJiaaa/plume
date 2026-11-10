/**
 * 按文件的种类画它的内容：Markdown 渲染出来（或看源码），文本和 JSON 用只读代码视图，图片可缩放，PDF 用 Chromium
 * 自带的阅读器，音视频用播放器，二进制只说一声。
 *
 * 图片、PDF、音视频经 `plume-media://f/…` 取（见 `mediaUrl`）。表格、数据库和 Word 经统一文档预览插件展示。
 */

import type { FileContents } from "@plume/contract";
import { Button, Scroller, translate } from "@plume/ui";
import { ExternalLink, FileQuestion, FileWarning } from "@plume/ui/icons";

import { attachmentActions } from "../composer/attachments/actions.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import { directoryOf } from "../markdown/assets.ts";
import { useCallback } from "react";
import { DocumentPreview } from "./document-viewers.tsx";
import { CodeView } from "./CodeView.tsx";
import { ImagePane } from "./ImagePane.tsx";
import { mediaUrl, readFileBytes, useReading, type OpenFile } from "./open-file.ts";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const VIDEO = new Set(["mp4", "webm", "mov", "mkv", "m4v"]);
const AUDIO = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac"]);
/** 表格、数据库、Word：由文档预览插件处理，不能按普通二进制展示。 */
const DOCUMENT = new Set(["xlsx", "xlsm", "xlsb", "xls", "ods", "sqlite", "sqlite3", "db", "docx"]);

export type FileKind = "image" | "video" | "audio" | "pdf" | "document" | "markdown" | "json" | "text" | "binary";

function extensionOf(name: string): string {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf(".");
	return dot > 0 ? lower.slice(dot + 1) : "";
}

/** 看扩展名在前、看内容在后：一张 PNG 读出来也是二进制，但它是能看的图。 */
export function fileKind(name: string, contents: FileContents | null): FileKind {
	const ext = extensionOf(name);
	if (IMAGE.has(ext)) return "image";
	if (VIDEO.has(ext)) return "video";
	if (AUDIO.has(ext)) return "audio";
	if (ext === "pdf") return "pdf";
	if (DOCUMENT.has(ext)) return "document";
	if (contents?.binary) return "binary";
	if (ext === "md" || ext === "mdx") return "markdown";
	if (ext === "json" || ext === "jsonc") return "json";
	return "text";
}

export function FileViewer({
	sessionId,
	path,
	name,
	contents,
	reveal,
}: {
	sessionId: string;
	path: string;
	name: string;
	contents: FileContents;
	reveal?: OpenFile["reveal"];
}) {
	const kind = fileKind(name, contents);
	const { wrap, showSource } = useReading();
	// 带着修改时间：原地改写过的文件换个地址，重新取。
	const media = mediaUrl(sessionId, path, contents.modifiedAt);
	const readBytes = useCallback((signal: AbortSignal) => readFileBytes(sessionId, path, contents.modifiedAt, signal), [sessionId, path, contents.modifiedAt]);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{kind === "image" ? (
				// 新的一版是新的一张图：缩放从头来。
				<ImagePane key={media} src={media} name={name} />
			) : kind === "pdf" ? (
				// `<embed>` 直接接上 Chromium 的 PDF 阅读器（搜索、打印、缩略图都在），不用多带一个 iframe 的浏览上下文。
				<embed key={media} src={media} type="application/pdf" aria-label={name} className="min-h-0 w-full flex-1" />
			) : kind === "video" ? (
				<div className="flex min-h-0 flex-1 items-center justify-center bg-shade/85 p-2">
					{/* 文件预览没有字幕轨。 */}
					<video key={media} src={media} controls className="max-h-full max-w-full rounded-item" />
				</div>
			) : kind === "audio" ? (
				<div className="flex min-h-0 flex-1 items-center justify-center p-4">
					<audio key={media} src={media} controls className="w-full max-w-md" />
				</div>
			) : kind === "document" ? (
				<DocumentPreview
					name={name}
					identity={media}
					readBytes={readBytes}
					fallback={
						<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
							<FileQuestion size={26} strokeWidth={1.4} className="text-ink-faint" />
							<p className="text-label text-ink-muted">{translate("fileViewer.noPreview")}</p>
							<Button
								size="sm"
								variant="soft"
								icon={<ExternalLink size={13} strokeWidth={1.9} />}
								onClick={() => attachmentActions.openDefault({ name, path })}
							>
								{translate("openTarget.defaultApp")}
							</Button>
						</div>
					}
				/>
			) : kind === "binary" ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
					<FileWarning size={26} strokeWidth={1.4} className="text-ink-faint" />
					<p className="text-label text-ink-muted">{translate("fileViewer.binary")}</p>
					<p className="text-detail text-ink-faint">{formatBytes(contents.bytes)}</p>
				</div>
			) : kind === "markdown" && !showSource ? (
				<Scroller className="flex-1" contentClassName="px-3">
					<div className="py-3">
						<Markdown text={contents.text} baseDir={directoryOf(path)} sessionId={sessionId} remoteImages />
					</div>
				</Scroller>
			) : (
				<CodeView path={path} text={contents.text} wrap={wrap} reveal={reveal} />
			)}
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
