import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAgent } from "../src/index.ts";
import { managedMediaPath, readManagedMedia, readMediaBytes } from "../src/media-access.ts";
import { saveImage } from "../src/media.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
let dir: string;
let mediaDir: string;
let name: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-media-access-"));
	mediaDir = join(dir, "data", "session-media");
	name = (await saveImage(mediaDir, PNG, "image/png"))!;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

it("托管图片在独立于项目的目录读取，返回规范路径和只读元数据", async () => {
	const path = join(mediaDir, name);
	expect(await managedMediaPath(mediaDir, path)).toBe(await realpath(path));
	expect(await readManagedMedia(mediaDir, path)).toMatchObject({ text: "", binary: true, truncated: false, bytes: Buffer.from(PNG, "base64").length });
	expect((await readMediaBytes(mediaDir, name))?.toString("base64")).toBe(PNG);
	const alias = join(dir, "media-alias");
	await symlink(mediaDir, alias);
	expect(await managedMediaPath(alias, await realpath(path))).toBe(await realpath(path));
});

it("拒绝路径片段、伪造绝对路径、数据目录其他文件、目录及图片软链", async () => {
	const secret = join(dir, name);
	await writeFile(secret, "outside");
	for (const invalid of ["../" + name, secret, "name.png", name.toUpperCase(), "", "\0"]) {
		expect(await readMediaBytes(mediaDir, invalid)).toBeNull();
	}
	expect(await managedMediaPath(mediaDir, name)).toBeNull();
	expect(await managedMediaPath(mediaDir, secret)).toBeNull();
	expect(await readManagedMedia(mediaDir, join(dir, "data", "settings.json"))).toBeNull();
	const link = `${"a".repeat(40)}.png`;
	await symlink(secret, join(mediaDir, link));
	expect(await managedMediaPath(mediaDir, join(mediaDir, link))).toBeNull();
	expect(await readMediaBytes(mediaDir, link)).toBeNull();
	expect(await readManagedMedia(mediaDir, join(mediaDir, link))).toBeNull();
	const inside = `${"b".repeat(40)}.png`;
	await symlink(join(mediaDir, name), join(mediaDir, inside));
	expect(await managedMediaPath(mediaDir, join(mediaDir, inside))).toBeNull();
	const directory = `${"c".repeat(40)}.png`;
	await mkdir(join(mediaDir, directory));
	expect(await managedMediaPath(mediaDir, join(mediaDir, directory))).toBeNull();
});

it("普通文件面板可读托管图片，缺失会话、其他目录和写操作不因此获得权限", async () => {
	const cwd = join(dir, "workspace");
	await mkdir(cwd);
	const path = join(mediaDir, name);
	const outside = join(dir, name);
	await writeFile(outside, "outside");
	const agent = await createAgent({ dataDir: join(dir, "data"), settingsFile: join(dir, "settings.json"), plugins: [], log: () => undefined });
	try {
		const session = await agent.service.createSession({ cwd });
		expect(await agent.service.readFile(session.id, path)).toMatchObject({ binary: true, bytes: Buffer.from(PNG, "base64").length });
		expect(await agent.filePath(session.id, path)).toBe(await realpath(path));
		expect(await agent.service.readFile(session.id, outside)).toBeNull();
		expect(await agent.filePath(session.id, outside)).toBeNull();
		expect(await agent.service.readFile("missing", path)).toBeNull();
		expect(await agent.filePath("missing", path)).toBeNull();
		await expect(agent.service.listDirectory(session.id, mediaDir)).rejects.toThrow();
		expect(await agent.service.fileOperation(session.id, { type: "rename", from: path, to: join(mediaDir, "renamed.png") })).toMatchObject({ ok: false });
	} finally {
		await agent.shutdown();
	}
});
