import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Documents } from "../src/documents.ts";
import { isDocumentList, MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from "../src/document-types.ts";
import { mcpResult } from "../src/tools.ts";

async function fixture(run: (store: Documents, root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "plume-mcp-documents-"));
	try {
		await run(new Documents(root), root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function bytes(store: Documents, session: string, id: string, signal = new AbortController().signal) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of store.read(session, id, signal)) chunks.push(chunk);
	return Buffer.concat(chunks);
}

test("嵌入文档只存快照引用，正文与图片保留；未知格式和链接不主动下载", () =>
	fixture(async (store, root) => {
		const blob = Buffer.from("document snapshot").toString("base64");
		const result = mcpResult(
			{
				content: [
					{ type: "text", text: "original output" },
					{ type: "resource", resource: { uri: "resource://reports/%E5%BA%93%E5%AD%98.XLSX?version=1", blob } },
					{
						type: "resource",
						resource: { uri: "resource://reports/report", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", blob },
					},
					{ type: "resource", resource: { uri: "resource://reports/archive.zip", blob } },
					{ type: "resource_link", uri: "https://example.invalid/book.xlsx" },
					{ type: "image", mimeType: "image/png", data: "aGk=" },
				],
			},
			undefined,
			(uri, mime, data) => store.save("session-a", uri, mime, data),
		);
		assert.match(result.output, /original output/);
		assert.match(result.output, /user's document preview/);
		assert.match(result.output, /archive.zip.*not shown/);
		assert.match(result.output, /resource link/);
		assert.equal(result.images.length, 1);
		assert.ok(isDocumentList(result.documents));
		assert.deepEqual(
			result.documents.map((item) => item.name),
			["库存.XLSX", "report.docx"],
		);
		assert.equal(JSON.stringify(result).includes(blob), false);
		const document = result.documents[0]!;
		assert.equal((await bytes(store, "session-a", document.id)).toString(), "document snapshot");
		// 重启插件仍能读；同内容去重，另一会话不能借到该快照。
		assert.equal((await bytes(new Documents(root), "session-a", document.id)).toString(), "document snapshot");
		assert.equal(store.save("session-a", "other.xlsx", undefined, blob)?.id, document.id);
		await assert.rejects(bytes(store, "session-b", document.id));
		const directory = join(root, createHash("sha256").update("session-a").digest("hex"));
		assert.equal((await readdir(directory)).length, 2);
		assert.equal((await stat(join(directory, document.id))).mode & 0o777, 0o600);
		store.remove("session-a");
		await assert.rejects(bytes(store, "session-a", document.id));
	}));

test("拒绝路径、软链、损坏快照和取消读取", () =>
	fixture(async (store, root) => {
		const blob = Buffer.from("original").toString("base64");
		const document = store.save("session", "safe.docx", undefined, blob)!;
		await assert.rejects(bytes(store, "session", "../../secret.docx"), /Invalid document id/);
		const aborted = AbortSignal.abort();
		await assert.rejects(bytes(store, "session", document.id, aborted), { name: "AbortError" });
		const file = join(root, createHash("sha256").update("session").digest("hex"), document.id);
		await writeFile(file, "changed");
		await assert.rejects(bytes(store, "session", document.id), /snapshot changed/);
		await rm(file);
		const outside = join(root, "outside");
		await writeFile(outside, "original");
		await symlink(outside, file);
		await assert.rejects(bytes(store, "session", document.id));
		assert.equal(store.save("session", "bad.xlsx", undefined, "not-base64"), null);
		assert.equal(store.save("session", "unknown", "constructor", blob), null);
		assert.equal(store.save("session", "bad.xlsx", undefined, ""), null);
		assert.equal(store.save("session", "bad.xlsx", undefined, "A".repeat(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 4)), null);
	}));

test("一批文档有数量和总大小上限，保存失败不丢失工具输出", () => {
	let calls = 0;
	const content = Array.from({ length: MAX_DOCUMENTS + 2 }, () => ({ type: "resource", resource: { uri: "doc.xlsx", blob: "YQ==" } }));
	const result = mcpResult({ content }, undefined, () => {
		calls++;
		return { id: "a".repeat(64) + ".xlsx", name: "doc.xlsx", bytes: 1 };
	});
	assert.equal(calls, MAX_DOCUMENTS);
	assert.equal(result.documents?.length, MAX_DOCUMENTS);
	assert.match(result.output, /not shown/);
	calls = 0;
	mcpResult({ content }, undefined, () => {
		calls++;
		return { id: "b".repeat(64) + ".xlsx", name: "doc.xlsx", bytes: MAX_DOCUMENT_BYTES };
	});
	assert.equal(calls, 1);
	assert.match(
		mcpResult({ content }, undefined, () => {
			throw new Error("disk full");
		}).output,
		/not shown/,
	);
	assert.equal(isDocumentList([{ id: "../bad", name: "doc.xlsx", bytes: 1 }]), false);
	assert.equal(isDocumentList([{ id: "a".repeat(64) + ".xlsx", name: "doc.xlsx", bytes: MAX_DOCUMENT_BYTES + 1 }]), false);
});
