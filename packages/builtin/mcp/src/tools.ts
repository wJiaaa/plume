/**
 * MCP 工具怎么交给 agent：给模型看的名字、参数的 JSON Schema、调用结果换成交给模型的文字和图。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolOutput } from "@plume/contract";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS, type DocumentRef } from "./document-types.ts";

/**
 * 各家函数名的共同约束是 `^[a-zA-Z0-9_-]{1,64}$`。放得下、又没被清洗改过字的，就是 `mcp__<服务>__<工具>`；
 * 超长、有要换掉的字符（`.`、空格、中文），或者撞上 `taken` 里的名字时，截短并接上由服务名和原名算出的哈希。
 * 改过字就加哈希、而不是等撞了再加：同一个工具每次得到同一个名字，「以后不再问」和历史里的调用都记在名字上。
 * 执行时用的是原名，不从这个名字反解。
 */
export function qualifiedToolName(server: string, tool: string, taken: ReadonlySet<string> = new Set()): string {
	const clean = sanitize(tool);
	const plain = `mcp__${sanitize(server)}__${clean}`;
	if (clean === tool && plain.length <= 64 && !taken.has(plain)) return plain;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${plain.slice(0, 64 - hash.length - 1)}_${hash}`;
}

/** 服务名、工具名里函数名放不下的字换成 `_`；资源地址 `mcp://<服务>/` 里的服务段也用它，和工具名一致。 */
export function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const SUBSCHEMAS = ["items", "prefixItems", "additionalProperties", "anyOf", "oneOf", "allOf", "not"] as const;
const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"] as const;

/**
 * 服务器给的参数 Schema。不是 object 的换成接受任意参数的 object（工具表只认 object）；`array` 没写 `items` 的补上
 * `{}`：有的服务商拒收这样的 Schema，整次请求都发不出去。
 */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
	if (isRecord(schema) && schema.type === "object") return fillArrayItems(schema, new WeakMap()) as Record<string, unknown>;
	return { type: "object", properties: {}, additionalProperties: true };
}

function fillArrayItems(schema: unknown, seen: WeakMap<object, unknown>): unknown {
	if (!isRecord(schema)) return schema;
	const already = seen.get(schema);
	if (already !== undefined) return already;
	const result: Record<string, unknown> = { ...schema };
	seen.set(schema, result);
	const visit = (value: unknown): unknown => (Array.isArray(value) ? value.map((child) => fillArrayItems(child, seen)) : fillArrayItems(value, seen));
	for (const key of SUBSCHEMAS) if (result[key] !== undefined) result[key] = visit(result[key]);
	for (const key of SUBSCHEMA_MAPS) {
		const children = result[key];
		if (isRecord(children)) result[key] = Object.fromEntries(Object.entries(children).map(([name, child]) => [name, fillArrayItems(child, seen)]));
	}
	const type = result.type;
	if ((type === "array" || (Array.isArray(type) && type.includes("array"))) && result.items === undefined) result.items = {};
	return result;
}

/** 交给模型的结果最多这么长，多出来的截掉中间、留头留尾；有临时目录时全文存在那里，模型要中间就去读。 */
export const RESULT_CHARS = 32_000;

/**
 * 多大的图直接交给模型：200 KiB。一张图跟着历史每轮都要重发，大图对模型理解的增益远不如它的体积——一张 2 MB 的截图按 base64
 * 是 2.7M 字符，几次就能把一些网关的请求体上限顶穿。超过的存进临时目录，给模型一个路径，它要看就 read。
 */
const INLINE_IMAGE_BYTES = 200 * 1024;
/** 单张图的上限，和 read 读本地图片一样：超过的连路径也不给，它读回来也会被拒。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 工具结果里能交给模型的图。 */
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type ModelImage = NonNullable<ToolOutput["images"]>[number];

/** 一次调用的结果换成交给模型的样子：文字、跟在后面的图，和只给人看的图。 */
export interface McpResult {
	output: string;
	images: ModelImage[];
	/** 只给人看的图，交给 `ToolOutput.shownImages`。 */
	shown: ModelImage[];
	documents?: DocumentRef[];
}

type SaveDocument = (uri: string, mime: string | undefined, blob: string) => DocumentRef | null;

/**
 * 服务器的结果换成交给模型的样子。每种内容块都有去处，一种都不悄悄丢：文字照给；图按大小直接给、存进临时目录给路径，或只说一声；
 * 音频、认不出的写一句说明。`structuredContent` 在正文里没有同样内容时接在后面。`scratchDir` 是会话的临时目录，
 * 大图和超长结果的全文落在那里，读文件的工具不用问人就能读回来；没有（设置页探测）时不存。`reader` 是这次能用的读文件工具
 * （工具表里 `kind: "view"` 的那个）叫什么，告诉模型拿它去读；没有就只说去读那个文件。
 */
export function mcpResult(
	response: { content?: unknown; structuredContent?: unknown; toolResult?: unknown },
	scratchDir?: string,
	saveDocument?: SaveDocument,
	reader?: string,
): McpResult {
	const raw = response.content ?? (response.toolResult !== undefined ? [{ type: "text", text: JSON.stringify(response.toolResult) }] : undefined);
	const parts: string[] = [];
	const result: McpResult = { output: "", images: [], shown: [] };
	for (const block of Array.isArray(raw) ? raw : []) {
		if (!isRecord(block)) continue;
		const type = block.type;
		if (type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (type === "image" && typeof block.data === "string") image(block.data, String(block.mimeType ?? "image/png"), scratchDir, result, parts, reader);
		// i18n-exempt：以下都是交给模型的结果。
		else if (type === "audio")
			parts.push(`[audio (${String(block.mimeType ?? "audio")}, ${size(block.data)}) omitted: Plume does not pass audio to the model]`);
		else if (type === "resource") embedded(isRecord(block.resource) ? block.resource : undefined, scratchDir, result, parts, saveDocument, reader);
		else if (type === "resource_link" && typeof block.uri === "string") parts.push(resourceLink(block));
		else parts.push(`[content of type "${String(type)}" omitted: Plume does not understand it]`);
	}
	if (response.structuredContent !== undefined && response.structuredContent !== null) {
		const wanted = stable(response.structuredContent);
		const present = parts.some((text) => {
			try {
				return stable(JSON.parse(text)) === wanted;
			} catch {
				return false;
			}
		});
		if (!present) parts.push(`structuredContent: ${JSON.stringify(response.structuredContent)}`);
	}
	const text = parts.join("\n\n");
	result.output = bound(text || (result.images.length > 0 ? "" : "(the server returned no content)"), scratchDir && join(scratchDir, "mcp-results"), reader);
	return result;
}

/** 一张图：小的原样给模型；大的存进临时目录、给人看、给模型路径；超过 5 MB 的只说一声。 */
function image(data: string, mimeType: string, scratchDir: string | undefined, result: McpResult, parts: string[], reader: string | undefined): void {
	const bytes = Math.floor((data.length * 3) / 4);
	// i18n-exempt：以下都是交给模型的结果。
	if (bytes > MAX_IMAGE_BYTES) {
		parts.push(`[image (${mimeType}, ${formatSize(bytes)}) omitted: over the 5 MB limit]`);
		return;
	}
	if (!MODEL_IMAGE_TYPES.has(mimeType)) {
		parts.push(`[image (${mimeType}, ${formatSize(bytes)}) omitted: Plume passes only PNG, JPEG, GIF and WebP images to the model]`);
		return;
	}
	if (bytes <= INLINE_IMAGE_BYTES) {
		result.images.push({ data, mimeType: mimeType as ModelImage["mimeType"] });
		return;
	}
	result.shown.push({ data, mimeType: mimeType as ModelImage["mimeType"] });
	const saved = scratchDir ? saveImage(data, mimeType, join(scratchDir, "mcp-images")) : undefined;
	parts.push(
		saved
			? `[image (${mimeType}, ${formatSize(bytes)}) not attached inline to save context; it is shown to the user and saved at ${saved} — ${reader ? `\`${reader}\` that path` : "open that file"} if you need to look at it]`
			: `[image (${mimeType}, ${formatSize(bytes)}) not attached inline to save context; it is shown to the user]`,
	);
}

/** 按内容起名：同一张图再来一次不多占一份。 */
function saveImage(data: string, mimeType: string, dir: string): string | undefined {
	try {
		const bytes = Buffer.from(data, "base64");
		const path = join(dir, `${createHash("sha1").update(bytes).digest("hex")}.${mimeType.slice("image/".length)}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, bytes);
		return path;
	} catch {
		return undefined;
	}
}

/** 嵌入的资源：文本带上地址给出去，图片按图片的规则，其余二进制说清楚是什么、多大。 */
function embedded(
	resource: Record<string, unknown> | undefined,
	scratchDir: string | undefined,
	result: McpResult,
	parts: string[],
	saveDocument: SaveDocument | undefined,
	reader: string | undefined,
): void {
	if (!resource) {
		parts.push("[resource]");
		return;
	}
	const uri = String(resource.uri ?? "");
	const mime = typeof resource.mimeType === "string" ? resource.mimeType : undefined;
	if (typeof resource.text === "string") parts.push(`[resource ${uri}${mime ? ` (${mime})` : ""}]\n${resource.text}`);
	else if (typeof resource.blob === "string" && mime?.startsWith("image/")) image(resource.blob, mime, scratchDir, result, parts, reader);
	else if (typeof resource.blob === "string") {
		const documents = result.documents ?? [];
		// shortcut: 每次结果最多 16 份、合计 64 MiB；有大批量资料需求时改为分页接收。
		const bytes = Math.floor((resource.blob.length * 3) / 4) - (resource.blob.endsWith("==") ? 2 : resource.blob.endsWith("=") ? 1 : 0);
		let saved: DocumentRef | null = null;
		if (documents.length < MAX_DOCUMENTS && documents.reduce((sum, item) => sum + item.bytes, 0) + bytes <= MAX_DOCUMENT_BYTES) {
			try {
				saved = saveDocument?.(uri, mime, resource.blob) ?? null;
			} catch {
				// 预览落盘失败不能丢掉这次工具的其余输出。
			}
		}
		if (saved) {
			result.documents = [...documents, saved];
			parts.push(`[resource ${uri} (${mime ?? "binary"}, ${size(resource.blob)}) is available in the user's document preview]`);
		} else parts.push(`[resource ${uri} (${mime ?? "binary"}, ${size(resource.blob)}) is binary and not shown]`);
	} else parts.push(`[resource ${uri}]`);
}

function resourceLink(block: Record<string, unknown>): string {
	const name = typeof block.title === "string" ? block.title : typeof block.name === "string" ? block.name : String(block.uri);
	const description = typeof block.description === "string" ? ` — ${block.description}` : "";
	return `[resource link] ${name}${typeof block.mimeType === "string" ? ` (${block.mimeType})` : ""}${description}: ${String(block.uri)}`;
}

/** 键排好序的 JSON，比较结构化结果和正文是不是同一份。 */
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** 截掉中间之前把全文存进 `saveDir`（临时目录的 `mcp-results/`），告诉模型去哪读；存不下就让它向工具要少一点。 */
function bound(text: string, saveDir: string | undefined, reader: string | undefined): string {
	const points = [...text];
	if (points.length <= RESULT_CHARS) return text;
	const saved = saveDir ? saveFull(text, saveDir) : undefined;
	const where = saved
		? `the full result is saved at ${saved} — ${reader ? `\`${reader}\` it with offset` : "read that file"} if you need the middle`
		: "ask the tool for less — a narrower query or a page — if you need the middle";
	const note = (omitted: number) =>
		`\n\n… [${omitted.toLocaleString("en-US")} of ${points.length.toLocaleString("en-US")} characters omitted by Plume (limit ${RESULT_CHARS.toLocaleString("en-US")}); ${where}.] …\n\n`;
	const keep = RESULT_CHARS - [...note(points.length)].length;
	const head = Math.floor(keep * 0.8);
	const tail = keep - head;
	return `${points.slice(0, head).join("")}${note(points.length - head - tail)}${points.slice(points.length - tail).join("")}`;
}

function saveFull(text: string, dir: string): string | undefined {
	try {
		mkdirSync(dir, { recursive: true });
		// 按内容起名：同一个结果再来一次不多占一份。
		const path = join(dir, `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.txt`);
		writeFileSync(path, text);
		return path;
	} catch {
		return undefined;
	}
}

function size(data: unknown): string {
	return typeof data === "string" ? formatSize(Math.floor((data.length * 3) / 4)) : "unknown size";
}

function formatSize(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KiB`;
}
