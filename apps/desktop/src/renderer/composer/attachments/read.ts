/**
 * 把拖进来、贴进来、选进来的文件读成附件，不假装每一份都是文本。三种结果，读之前就定下走哪一种：
 *
 *   - 图片：作为图片内容带上，模型真能看；
 *   - 已知不是文本的（文档、视频、压缩包）：抽得出字就带字，否则只带名字和类型；
 *   - 其余当文本读，读完再查一遍：扩展名只是第一道猜测，文件可以叫任何名字。
 */

import type { DocumentText } from "@plume/contract";
import { translate } from "@plume/ui";
import { fileKind, isReadableAsText, looksBinary, type FileKind } from "./file-kind.ts";
import type { PickedFile } from "./picked.ts";

/** 输入框里挂着的一份附件。 */
export interface DraftAttachment {
	id: string;
	name: string;
	mimeType: string;
	/** 是什么：决定图标，也决定字节能不能进提示词。 */
	kind?: FileKind;
	/** 图片的 base64，不带 `data:` 前缀。 */
	data?: string;
	text?: string;
	isText: boolean;
	/** 磁盘上的位置，有它才谈得上「打开」和「在访达中显示」。粘贴进来的截图没有。 */
	path?: string;
	/**
	 * 界面上叫什么：正文里那枚标记写的就是它。和 `name` 分开，一张粘贴进来的图的 `name` 是 `image.png`，
	 * 而屏幕上它是「图片 1」。
	 */
	label?: string;
	/** 它是会话媒体目录里哪张图的标注副本（插件经 `ui.draftInSession` 交来的）：发出去以后记在图片块上（`ImageContent.from`）。 */
	from?: string;
}

/**
 * 一次放得进来几个。四十个文件一起拖进来多半是拖错了目录，而每一个都要读字节、抽文本，窗口会停住；超出的会
 * 说出来，不默默丢掉。
 */
const MAX_FILES = 8;

export async function readPickedFiles(
	picked: PickedFile[],
	{ documentText, notify }: { documentText: (name: string, data: Uint8Array) => Promise<DocumentText | null>; notify: (text: string) => void },
): Promise<DraftAttachment[]> {
	const next: DraftAttachment[] = [];
	/** 本该有文字却没有的那些：只有这一类要说出来。 */
	const scanned: string[] = [];

	if (picked.length > MAX_FILES) notify(translate("composer.tooManyFiles", { count: MAX_FILES, dropped: picked.length - MAX_FILES }));

	for (const { file, path, directory } of picked.slice(0, MAX_FILES)) {
		const id = `${file.name}-${Date.now()}-${Math.random()}`;
		// 文件夹只记位置，在句子里和文件一样是一枚标记：模型有读目录的工具，它缺的只是「在哪」。
		if (directory && path) {
			next.push({ id, name: file.name, mimeType: "inode/directory", isText: false, kind: "folder", path });
			continue;
		}
		const kind = fileKind(file.name, file.type);
		// 每条出口都要带上它，漏在某一条上，那一类附件就打不开了。
		const from = path ? { path } : {};

		if (kind === "image") {
			const buffer = await file.arrayBuffer();
			next.push({ id, name: file.name, mimeType: file.type, data: bytesToBase64(new Uint8Array(buffer)), isText: false, kind, ...from });
			continue;
		}

		if (!isReadableAsText(kind, file.name)) {
			/*
			 * 不是文本，但未必读不出字：PDF、Word、Excel、PPT 里的字拿得到。抽取在 agent 进程，解析一份三百页的
			 * 文档要几百毫秒，卡住它比卡住正在打字的窗口好；哪些格式认得由那边说了算。
			 */
			const bytes = new Uint8Array(await file.arrayBuffer());
			const extracted = await documentText(file.name, bytes).catch(() => null);

			if (extracted?.text) {
				next.push({
					id,
					name: file.name,
					mimeType: file.type || "application/octet-stream",
					text:
						extracted.truncated && extracted.fullLength !== undefined
							? `${extracted.text}\n\n${translate("composer.textTruncated", { n: extracted.fullLength - extracted.text.length })}`
							: extracted.text,
					isText: true,
					// 门类不改：图标该是 PDF 就还是 PDF，变的只是内容进不进提示词。
					kind,
					...from,
				});
				continue;
			}

			next.push({ id, name: file.name, mimeType: file.type || "application/octet-stream", isText: false, kind, ...from });
			/*
			 * 读不出来的两种只说一种：扫描件是「本该有字，但它是一张图」，人得换个做法，不说他不会知道；格式本身不支持
			 * （压缩包、可执行文件）是预料之中的，由标记上淡一档的图标说。
			 */
			if (extracted?.imageOnly) scanned.push(translate("composer.scannedDocument", { name: file.name }));
			continue;
		}

		try {
			const buffer = new Uint8Array(await file.arrayBuffer());
			if (looksBinary(buffer)) {
				// 名字像文本，其实不是：和上面已知的那几类一样处理。
				next.push({ id, name: file.name, mimeType: file.type || "application/octet-stream", isText: false, kind: "binary", ...from });
				continue;
			}
			next.push({ id, name: file.name, mimeType: file.type || "text/plain", text: new TextDecoder().decode(buffer), isText: true, kind, ...from });
		} catch {
			notify(translate("subAgent.fileUnreadable", { name: file.name }));
		}
	}

	if (scanned.length > 0) notify(scanned.join("\n"));
	return next;
}

/** `btoa` 不收字节数组；分块转，大图不会撑爆调用栈。 */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** 标注过的 `data:` URL 拆回附件存的样子。标注器一律给 PNG。 */
export function fromDataUrl(dataUrl: string, previous: { mimeType: string }): { data: string; mimeType: string } {
	const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
	if (!match) return { data: "", mimeType: previous.mimeType };
	return { mimeType: match[1]!, data: match[2]! };
}
