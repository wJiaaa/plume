import { createHash } from "node:crypto";
import { constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DOCUMENT_EXTENSION, DOCUMENT_ID, MAX_DOCUMENT_BYTES, type DocumentRef } from "./document-types.ts";

const MIME_EXTENSIONS: Record<string, string> = {
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.ms-word.document.macroenabled.12": "docm",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.template": "dotx",
	"application/vnd.ms-word.template.macroenabled.12": "dotm",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.template": "xltx",
	"application/vnd.ms-excel.template.macroenabled.12": "xltm",
	"application/vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
	"application/vnd.ms-excel": "xls",
	"application/vnd.oasis.opendocument.spreadsheet": "ods",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptm",
	"application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
	"application/vnd.ms-powerpoint.slideshow.macroenabled.12": "ppsm",
	"application/vnd.openxmlformats-officedocument.presentationml.template": "potx",
	"application/vnd.ms-powerpoint.template.macroenabled.12": "potm",
	"application/vnd.sqlite3": "sqlite",
	"application/x-sqlite3": "sqlite",
};

function documentName(uri: string, mime: string | undefined): string | null {
	let path = uri.split(/[?#]/)[0] ?? "";
	try {
		path = decodeURIComponent(path);
	} catch {
		return null;
	}
	const name = (path.split(/[/\\]/).pop() ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(-230);
	if (DOCUMENT_EXTENSION.test(name.toLowerCase())) return name;
	const type = mime?.split(";")[0]?.trim().toLowerCase() ?? "";
	const extension = Object.hasOwn(MIME_EXTENSIONS, type) ? MIME_EXTENSIONS[type] : undefined;
	return extension ? `${name || "document"}.${extension}` : null;
}

/** 只存服务已经返回的数据；界面只能按内容 id 读本会话快照，不能提交磁盘路径或下载地址。 */
export class Documents {
	private readonly root: string;
	constructor(root: string) {
		this.root = root;
	}

	private directory(session: string): string {
		if (typeof session !== "string" || !session || session.length > 256) throw new Error("Invalid document session");
		return join(this.root, createHash("sha256").update(session).digest("hex"));
	}

	save(session: string, uri: string, mime: string | undefined, blob: string): DocumentRef | null {
		const name = documentName(uri, mime);
		if (!name || !blob || blob.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 || blob.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(blob)) return null;
		const bytes = Buffer.from(blob, "base64");
		if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) return null;
		const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
		const id = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
		const directory = this.directory(session);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		try {
			writeFileSync(join(directory, id), bytes, { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		return { id, name, bytes: bytes.length };
	}

	async *read(session: string, id: string, signal: AbortSignal): AsyncGenerator<Uint8Array, void> {
		signal.throwIfAborted();
		if (typeof id !== "string" || !DOCUMENT_ID.test(id)) throw new Error("Invalid document id");
		const file = await open(join(this.directory(session), id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await file.stat();
			if (!info.isFile() || !info.size || info.size > MAX_DOCUMENT_BYTES) throw new Error("Invalid document size");
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(256 * 1024);
			let total = 0;
			while (true) {
				signal.throwIfAborted();
				const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, MAX_DOCUMENT_BYTES + 1 - total), null);
				if (!bytesRead) break;
				total += bytesRead;
				if (total > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds 64 MiB");
				const chunk = buffer.subarray(0, bytesRead);
				hash.update(chunk);
				yield Uint8Array.from(chunk);
			}
			signal.throwIfAborted();
			if (hash.digest("hex") !== id.split(".")[0]) throw new Error("Document snapshot changed");
		} finally {
			await file.close();
		}
	}

	remove(session: string): void {
		rmSync(this.directory(session), { recursive: true, force: true });
	}
}
