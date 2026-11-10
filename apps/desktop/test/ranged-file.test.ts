/**
 * 音视频要能拖进度：Range 请求拿到那一段和 206，每个回答都说「收 Range」。整个文件回 200 的源 `seekable`
 * 是 [0, 0]，每次拖进度条都回到第一帧。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { byteRange, serveRanged } from "../src/main/ranged-file.ts";

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

async function clip(): Promise<{ path: string; done: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "plume-ranged-"));
	const path = join(dir, "clip.mp4");
	await writeFile(path, BYTES);
	return { path, done: () => rm(dir, { recursive: true, force: true }) };
}

const ask = (range?: string, method = "GET") => new Request("plume-media://f/s/clip.mp4", { method, headers: range ? { range } : {} });

test("要一段就给那一段，206 并写明是总共多少里的哪一段", async () => {
	const { path, done } = await clip();
	try {
		const answer = await serveRanged(path, ask("bytes=100-199"), "video/mp4");
		assert.equal(answer.status, 206);
		assert.equal(answer.headers.get("content-range"), "bytes 100-199/1000");
		assert.equal(answer.headers.get("content-length"), "100");
		assert.equal(answer.headers.get("accept-ranges"), "bytes");
		assert.equal(answer.headers.get("content-type"), "video/mp4");
		assert.deepEqual(new Uint8Array(await answer.arrayBuffer()), BYTES.slice(100, 200));
	} finally {
		await done();
	}
});

test("第一次请求不带 Range：整个文件，也已经说了收 Range", async () => {
	const { path, done } = await clip();
	try {
		const answer = await serveRanged(path, ask(), "video/mp4");
		assert.equal(answer.status, 200);
		assert.equal(answer.headers.get("accept-ranges"), "bytes");
		assert.equal(answer.headers.get("content-length"), "1000");
		assert.equal((await answer.arrayBuffer()).byteLength, 1000);
	} finally {
		await done();
	}
});

test("到文件尾的、取最后几个字节的、超出文件的范围，以及不存在的文件", async () => {
	const { path, done } = await clip();
	try {
		const tail = await serveRanged(path, ask("bytes=900-"), "video/mp4");
		assert.equal(tail.headers.get("content-range"), "bytes 900-999/1000");
		assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), BYTES.slice(900));
		const last = await serveRanged(path, ask("bytes=-10"), "video/mp4");
		assert.equal(last.headers.get("content-range"), "bytes 990-999/1000");
		const beyond = await serveRanged(path, ask("bytes=5000-"), "video/mp4");
		assert.equal(beyond.status, 416);
		assert.equal(beyond.headers.get("content-range"), "bytes */1000");
		assert.equal((await serveRanged(`${path}.gone`, ask("bytes=0-1"), "video/mp4")).status, 404);
	} finally {
		await done();
	}
});

test("只把媒体元素发的那一种单段写法当成范围", () => {
	assert.deepEqual(byteRange("bytes=0-0", 10), { start: 0, end: 0 });
	assert.deepEqual(byteRange("bytes=5-999", 10), { start: 5, end: 9 }, "终点超过文件尾，停在最后一个字节");
	assert.equal(byteRange("bytes=0-1,4-5", 10), null, "多段：整个文件");
	assert.equal(byteRange("items=0-1", 10), null);
	assert.equal(byteRange("bytes=-", 10), null);
	assert.equal(byteRange(null, 10), null);
	assert.equal(byteRange("bytes=7-3", 10), "unsatisfiable");
});
