import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeImages, sweepImages } from "../src/media.ts";

let dir: string;
const kept = "a".repeat(40) + ".png";
const orphan = "b".repeat(40) + ".jpg";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-media-cleanup-"));
	await mkdir(join(dir, "thumbs"));
	for (const name of [kept, orphan, "notes.txt"]) await writeFile(join(dir, name), "x");
	for (const name of [`${"a".repeat(40)}.128.png`, `${"b".repeat(40)}.128.png`, `${"c".repeat(40)}.800.png`]) await writeFile(join(dir, "thumbs", name), "x");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

it("删掉没人用的图时连它的缩略图一起删，名字不对的不碰", async () => {
	await removeImages(dir, [orphan, "../notes.txt"]);
	expect((await readdir(dir)).sort()).toEqual([kept, "notes.txt", "thumbs"].sort());
	expect((await readdir(join(dir, "thumbs"))).sort()).toEqual([`${"a".repeat(40)}.128.png`, `${"c".repeat(40)}.800.png`]);
});

it("启动时清掉没有会话用着的图，和原图已经不在的缩略图", async () => {
	await sweepImages(dir, new Set([kept]));
	expect((await readdir(dir)).sort()).toEqual([kept, "notes.txt", "thumbs"].sort());
	expect(await readdir(join(dir, "thumbs"))).toEqual([`${"a".repeat(40)}.128.png`]);
});
