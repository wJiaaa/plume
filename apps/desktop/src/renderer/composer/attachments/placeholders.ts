/**
 * 附件的次序，和它在句子里站的位置。
 *
 * 草稿要是「一段文字加一袋文件」，袋子没有次序：「拿这张截图跟旧的那张比一比」里哪张是哪张，模型看不到。
 * 所以往正文里写一个记号，让次序活在唯一能扛住编辑、撤销的地方——正文本身。记号写的是「图片 1」「表格 2」
 * 这样的门类加序号（或者文件自己的名字），正是人指认附件时说的话；输入框和气泡都把它画成一枚标签。
 *
 * 匹配按名字加次序：文中第二个 `【表格 1】` 认的是第二个叫「表格 1」的附件。
 *
 * 发给模型的那几行（`Attached file` 这些）是英文，不进翻译表：窗口设成什么语言都不该改变模型读到的东西。
 */

/** 写进正文的那个记号。 */
export function placeholderFor(name: string): string {
	// i18n-exempt：记号的括号是存储格式，正文和气泡都靠它配对，不随界面语言变。
	return `【${name}】`;
}

/**
 * 一份附件在这一条消息里的位置，说给模型听。
 *
 * 两个序号都给：`3/5` 是在全部附件里的位置，`image 2 of 3` 是在同门类里的位置——有了后者，「图片 2」
 * 不用模型自己去数，它数错的时候不会有任何迹象。
 */
export function attachmentLabel(position: { index: number; total: number; kind?: string; kindIndex: number; kindTotal: number }): string {
	const { index, total, kind, kindIndex, kindTotal } = position;
	const within = kind && kindTotal > 1 ? `, ${kind} ${kindIndex} of ${kindTotal}` : kind ? `, ${kind}` : "";
	return total > 1 ? `Attachment ${index} of ${total}${within}` : kind === "folder" ? "Attached folder" : "Attached file";
}

/** 文本附件的内容怎么写进提示词：带名字、围起来，模型分得清文件和前后那句话。 */
export function attachmentBody(name: string, text: string, label = "Attached file"): string {
	return `\n\n### ${label}: ${name}\n\`\`\`\n${text}\n\`\`\`\n\n`;
}

/** 读不出内容的文件写成这样：说清楚没带内容，模型就不会装作读过。 */
export function attachmentStub(name: string, mimeType?: string, label = "Attached file"): string {
	return `\n\n[${label}: ${name}${mimeType ? ` (${mimeType})` : ""} — contents not included]\n\n`;
}

/** 文件夹只给完整路径，内容由模型自己用工具去读：整个目录既装不下也没必要。 */
export function attachmentFolder(name: string, path: string, label = "Attached folder"): string {
	return `\n\n[${label}: ${name} — folder at ${JSON.stringify(path)}; contents not included, read it with your tools if needed]\n\n`;
}

/** 图片块前面那一行：图片块里写不了字，三张截图之间唯一的区别就是紧挨着它的这段文字。 */
export function attachmentImageLabel(name: string, label: string): string {
	return `\n\n### ${label}: ${name}\n\n`;
}

/**
 * 一个文本块是不是附件内容，而不是人打的字。
 *
 * 气泡只画人打的那些：老消息没有 `displayText` 时，从正文里拼回人打的字要把这些块跳过去。
 */
export function isAttachmentBody(text: string): boolean {
	return /^\n\n(?:### |\[)(?:Attached (?:file|folder)|Attachment \d+)[:,]/.test(text) || /^\n\n(?:### |\[)Attachment \d+ of \d+/.test(text);
}

type Segment<File> = { kind: "text"; text: string } | { kind: "file"; file: File };

/** 正文里一处认得出的标记：在哪儿，指的是谁。 */
export interface Placeholder<File> {
	start: number;
	/** 闭合的 `】` 之后一位，可以直接拿去 `slice`。 */
	end: number;
	file: File;
}

/**
 * 标记写的是附件在界面上的名字（`label`），没有才是文件名：一张粘贴进来的图叫「图片 1」，而它的 `name` 是
 * 剪贴板给的 `image.png`。
 */
function answersTo(file: { name: string; label?: string }, written: string): boolean {
	return (file.label ?? file.name) === written;
}

/**
 * 扫出正文里所有认得出的标记，带位置。解析只有这一处，其余都从这里取。
 *
 * 认不出的 `【…】` 原样留着——中文里方括号是普通标点，「这个【重要】」不是在引用任何东西。
 */
export function scanPlaceholders<File extends { name: string; label?: string }>(text: string, files: File[]): Placeholder<File>[] {
	const hits: Placeholder<File>[] = [];
	// i18n-exempt：记号的括号，见 placeholderFor。
	const [open, close] = ["【", "】"] as const;
	if (!text.includes(open)) return hits;
	const taken = new Set<File>();
	let at = 0;

	while (at < text.length) {
		const start = text.indexOf(open, at);
		if (start === -1) break;
		const end = text.indexOf(close, start + 1);
		if (end === -1) break;
		const name = text.slice(start + 1, end);
		const file = files.find((candidate) => answersTo(candidate, name) && !taken.has(candidate));
		if (!file) {
			// 不是引用。从这个括号之后接着找，`【a【b.md】` 还能找到里面那个。
			at = start + 1;
			continue;
		}
		hits.push({ start, end: end + 1, file });
		taken.add(file);
		at = end + 1;
	}

	return hits;
}

/**
 * 附件的名字变了，正文里指着它的标记跟着改。
 *
 * 删掉「图片 1」之后原来的「图片 2」成了「图片 1」，句子里那枚不跟着改就指向一个不存在的编号。定位用改名之前
 * 那份列表，所以不会认不出；`nameAfter` 返回 null 表示那一份已经不在了，标记跟着走，留下的空档收干净。
 */
export function renamePlaceholders<File extends { name: string; label?: string }>(
	text: string,
	before: File[],
	nameAfter: (file: File) => string | null,
): string {
	const hits = scanPlaceholders(text, before);
	if (hits.length === 0) return text;

	let out = "";
	let cursor = 0;
	for (const hit of hits) {
		out += text.slice(cursor, hit.start);
		const next = nameAfter(hit.file);
		if (next !== null) out += placeholderFor(next);
		cursor = hit.end;
	}
	out += text.slice(cursor);

	return out
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface Placement<File> {
	/** 按标记切开的正文，阅读顺序。 */
	segments: Segment<File>[];
	/**
	 * 没有标记可站的附件。它们照样要发出去——一份悄悄没到的附件比站错位置的糟得多。
	 */
	unplaced: File[];
}

/** 按指着某份附件的标记切开 `text`；什么都不指的 `【…】` 留作普通文字。 */
export function placeAttachments<File extends { name: string; label?: string }>(text: string, files: File[]): Placement<File> {
	const segments: Segment<File>[] = [];
	const hits = scanPlaceholders(text, files);
	const taken = new Set<File>(hits.map((hit) => hit.file));
	let cursor = 0;

	for (const hit of hits) {
		const plain = text.slice(cursor, hit.start);
		if (plain) segments.push({ kind: "text", text: plain });
		segments.push({ kind: "file", file: hit.file });
		cursor = hit.end;
	}

	const tail = text.slice(cursor);
	if (tail) segments.push({ kind: "text", text: tail });

	return { segments, unplaced: files.filter((file) => !taken.has(file)) };
}
