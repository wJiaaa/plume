import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ResourceAddress, ResourceScope } from "@plume/contract";
import type { Skill } from "../src/loader.ts";
import { skillResource } from "../src/resource.ts";

let root: string;
let skillDir: string;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "plume-skill-res-"));
	skillDir = join(root, "skills", "pdf");
	await mkdir(join(skillDir, "references"), { recursive: true });
	await writeFile(join(skillDir, "template.txt"), "模板内容\n");
	await writeFile(join(skillDir, "references", "03-guide.md"), "# 指南\n");
	await writeFile(join(root, "secret.txt"), "不该被读到\n");
	await symlink(join(root, "secret.txt"), join(skillDir, "escape.txt"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

const skill = (): Skill => ({
	name: "pdf",
	description: "读 PDF",
	content: "# PDF 技能\n\n模板在 ${CLAUDE_SKILL_DIR}/template.txt",
	path: join(skillDir, "SKILL.md"),
	dir: skillDir,
	scope: "workspace",
	root: join(root, "skills"),
	manualOnly: false,
});

const handler = () => skillResource(async () => [skill(), { ...skill(), name: "hidden", manualOnly: true }]);
const scope = (): ResourceScope => ({ cwd: root, sessionId: "s", scratchDir: join(root, "scratch") });

/** 和服务 `resources` 拆出来的一样。 */
function address(raw: string): ResourceAddress {
	const path = raw.slice("skill://".length);
	return { scheme: "skill", path, segments: path.split("/").filter(Boolean), raw };
}

test("skill://<名字> 是换好路径变量的正文", async () => {
	const body = await handler().resolve(address("skill://pdf"), scope());
	assert.equal(body.content, `# PDF 技能\n\n模板在 ${skillDir}/template.txt`);
	assert.equal(body.label, "技能“pdf”的完整正文");
});

test("skill://<名字>/<路径> 读目录里的文件；末尾带 / 的列目录，哪一层都行", async () => {
	assert.equal((await handler().resolve(address("skill://pdf/template.txt"), scope())).content, "模板内容\n");
	const top = await handler().resolve(address("skill://pdf/"), scope());
	assert.match(top.content, /^- skill:\/\/pdf\/references\/$/m);
	assert.match(top.content, /^- skill:\/\/pdf\/template\.txt$/m);
	const sub = await handler().resolve(address("skill://pdf/references/"), scope());
	assert.equal(sub.content, "- skill://pdf/references/03-guide.md");
});

test("出不去技能目录：爬上去的、经软链出去的都拒", async () => {
	await assert.rejects(() => handler().resolve(address("skill://pdf/../../secret.txt"), scope()), /技能目录外面/);
	await assert.rejects(() => handler().resolve(address("skill://pdf/escape.txt"), scope()), /经过软链后指到了技能目录外面/);
	await assert.rejects(() => handler().locate!(address("skill://pdf/../.."), scope()), /技能目录外面/);
});

test("没有这个技能时说有哪些；列表里没有只给人点的；ls 拿到的是技能目录", async () => {
	await assert.rejects(() => handler().resolve(address("skill://nope"), scope()), /现有的是：pdf、hidden/);
	assert.deepEqual(await handler().list!(scope()), [{ value: "skill://pdf", description: "读 PDF" }]);
	assert.equal(await handler().locate!(address("skill://pdf/references"), scope()), join(skillDir, "references"));
	assert.equal(await handler().locate!(address("skill://"), scope()), null);
});
