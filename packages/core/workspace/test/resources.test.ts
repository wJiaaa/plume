/**
 * 资源地址：解析、路由、本体自己的几个 scheme，和两道边界。工具经地址读写（read、write、edit、ls）在 plume.tools 的
 * `test/tools/addresses.test.ts` 里测。
 *
 * 这个文件大半是为了边界：一条路径出不了它所在的命名空间——包括经软链，字面路径没出去、读却出去了的那种；
 * 几乎什么都不能写，模型不能靠地址改掉约束它的说明。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Message, ResourceHandler, ResourceScope, SessionSummary } from "@plume/contract";
import { ArtifactStore, artifactResource, pluginResource, scratchResource, sessionResource } from "../src/resources/handlers.ts";
import { parseResourceUrl, readOnly, ResourceRouter } from "../src/resources/router.ts";

let root: string;
let scratchDir: string;
let skillDir: string;

/** 一个只读、能列目录、给出位置的 scheme，代替别的插件登记的那种（技能插件的 `skill://`）。 */
const docsResource = (): ResourceHandler => ({
	scheme: "docs",
	describe: "`docs://<名字>` 一份文档",
	async resolve(url) {
		return { url: url.raw, content: "第一行\n第二行\n第三行", contentType: "text/plain" };
	},
	async list() {
		return [{ value: "docs://guide", description: "指南" }];
	},
	async locate(url) {
		return url.segments.length === 0 ? null : join(skillDir, ...url.segments);
	},
});

function router(): ResourceRouter {
	const r = new ResourceRouter();
	r.register(scratchResource);
	r.register(docsResource());
	return r;
}

const scope = (): ResourceScope => ({ cwd: root, sessionId: "s1", scratchDir });

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "plume-res-"));
	scratchDir = join(root, "scratch");
	skillDir = join(root, "skills", "pdf");
	await mkdir(join(skillDir, "references"), { recursive: true });
	await mkdir(scratchDir, { recursive: true });
	await writeFile(join(skillDir, "references", "03-guide.md"), "# 指南\n");
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

it("地址要有 scheme 和 `://`；Windows 盘符不是 scheme", () => {
	expect(parseResourceUrl("skill://pdf")?.scheme).toBe("skill");
	expect(parseResourceUrl("src/app.ts")).toBeNull();
	expect(parseResourceUrl("note:todo")).toBeNull();
	expect(parseResourceUrl("C:\\Users\\me\\file.ts")).toBeNull();
	expect(parseResourceUrl("C:/Users/me/file.ts")).toBeNull();
});

it("末尾的行范围从路径上拆下来；空段丢掉", () => {
	expect(parseResourceUrl("skill://pdf:10-40")).toMatchObject({ path: "pdf", range: { from: 10, to: 40 } });
	expect(parseResourceUrl("skill://pdf:7")?.range).toEqual({ from: 7 });
	expect(parseResourceUrl("skill://pdf/docs/a.md")?.segments).toEqual(["pdf", "docs", "a.md"]);
	expect(parseResourceUrl("skill://")?.segments).toEqual([]);
});

it("没人登记的 scheme 不揽过来；同一个 scheme 登记两次报错，撤下后能再登记", () => {
	const r = router();
	expect(r.canResolve("docs://guide")).toBe(true);
	expect(r.canResolve("acme://thing")).toBe(false);
	expect(() => r.register(docsResource())).toThrow(/already registered/);
	expect(() => r.register({ ...docsResource(), scheme: "Bad_Scheme" })).toThrow(/not valid/);
	const other = new ResourceRouter();
	const undo = other.register(docsResource());
	undo();
	expect(() => other.register(docsResource())).not.toThrow();
});

it("光秃秃的 scheme 列出里面有什么；行范围切出那几行", async () => {
	const r = router();
	expect((await r.resolve("docs://", scope())).content).toBe("- docs://guide: 指南");
	expect((await r.resolve("docs://guide:2-3", scope())).content).toBe("第二行\n第三行");
});

it("scratch:// 写了能读回来；第一次写时临时目录还不存在也行", async () => {
	const r = router();
	await r.write("scratch://notes/a.md", "写下来的内容", scope());
	expect((await r.resolve("scratch://notes/a.md", scope())).content).toBe("写下来的内容");

	const fresh = join(await mkdtemp(join(tmpdir(), "plume-scratch-fresh-")), "not-yet");
	await r.write("scratch://a/b.md", "ok", { ...scope(), scratchDir: fresh });
	expect((await r.resolve("scratch://a/b.md", { ...scope(), scratchDir: fresh })).content).toBe("ok");
	await rm(dirname(fresh), { recursive: true, force: true });
});

it("scratch:// 爬不出去，临时目录里的软链也带不出去读写", async () => {
	const r = router();
	await expect(r.write("scratch://../escaped.md", "x", scope())).rejects.toThrow(/临时目录外面/);

	const target = await mkdtemp(join(tmpdir(), "plume-scratch-out-"));
	try {
		await writeFile(join(target, "credentials"), "secret");
		await symlink(target, join(scratchDir, "out"));
		await symlink(join(target, "made-by-link"), join(scratchDir, "dangling"));
		await expect(r.resolve("scratch://out/credentials", scope())).rejects.toThrow(/临时目录外面/);
		await expect(r.write("scratch://out/credentials", "overwritten", scope())).rejects.toThrow(/临时目录外面/);
		await expect(r.write("scratch://out/new.txt", "x", scope())).rejects.toThrow(/临时目录外面/);
		await expect(r.write("scratch://out/deeper/new.txt", "x", scope())).rejects.toThrow(/临时目录外面/);
		await expect(r.write("scratch://dangling", "x", scope())).rejects.toThrow(/临时目录外面/);
		expect(await readFile(join(target, "credentials"), "utf8")).toBe("secret");
		expect(await readdir(target)).toEqual(["credentials"]);
	} finally {
		await rm(join(scratchDir, "out"), { force: true });
		await rm(join(scratchDir, "dangling"), { force: true });
		await rm(target, { recursive: true, force: true });
	}
});

it("除了 scratch:// 都是只读的", async () => {
	const r = router();
	await expect(r.write("docs://guide", "改掉", scope())).rejects.toThrow(/只读/);
	expect(
		r
			.schemes()
			.filter((s) => s.writable)
			.map((s) => s.scheme),
	).toEqual(["scratch"]);
});

it("插件登记时塞了 write 也写不进去：服务只留读的几样", async () => {
	const r = router();
	const written: string[] = [];
	const sneaky = { ...docsResource(), scheme: "sneaky", write: async (_url: unknown, content: string) => void written.push(content) };
	r.register(readOnly(sneaky));
	await expect(r.write("sneaky://guide", "改掉", scope())).rejects.toThrow(/只读/);
	expect(written).toEqual([]);
	expect((await r.resolve("sneaky://guide", scope())).content).toContain("第一行");
	expect((await r.resolve("sneaky://", scope())).content).toContain("docs://guide");
	expect(await r.locate("sneaky://guide", scope())).toBe(join(skillDir, "guide"));
});

it("artifact://：同一段原文换回同一个地址；每个会话最多 30 份，超了丢最旧的；取不到时说是重开过", async () => {
	const store = new ArtifactStore();
	const address = store.keep("s1", "bash", "完整输出");
	expect(store.keep("s1", "bash", "完整输出")).toBe(address);
	expect(new ArtifactStore().keep("s1", "bash", "完整输出")).toBe(address);
	expect(store.keep("s1", "bash", "另一段")).not.toBe(address);

	for (let i = 0; i < 40; i += 1) store.keep("s1", "bash", `第 ${i} 次`);
	const kept = store.list("s1").map((a) => a.content);
	expect(kept.length).toBe(30);
	expect(kept).not.toContain("第 0 次");
	expect(kept).toContain("第 39 次");

	const handler = artifactResource(store);
	const id = store.keep("s1", "grep", "三万行").slice("artifact://".length);
	const got = await handler.resolve(parseResourceUrl(`artifact://${id}`)!, scope());
	expect(got).toMatchObject({ content: "三万行", origin: "grep 的原始输出" });
	// 会话各管各的。
	await expect(handler.resolve(parseResourceUrl(`artifact://${id}`)!, { ...scope(), sessionId: "s2" })).rejects.toThrow(/重开会话后就没有了/);
	store.forget("s1");
	expect(store.list("s1")).toEqual([]);
});

const summary = (id: string, title: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
	({ id, title, cwd: "/", createdAt: 1, updatedAt: 1, running: false, kind: extra.parentId ? "child" : "top", ...extra }) as SessionSummary;

it("session:// 读另一次会话：一行一条，越界说一共几条；列表里没有当前会话、归档的和子会话", async () => {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "为什么慢" }], timestamp: 1 },
		{ role: "user", content: [{ type: "text", text: "（界面替人说的）" }], timestamp: 2, synthetic: true },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "因为没缓存" },
				{ type: "toolCall", id: "c", name: "read", arguments: {} },
			],
			timestamp: 3,
		} as Message,
		{ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "很长的文件" }], isError: false, timestamp: 4 },
	];
	const handler = sessionResource({
		list: async () => [summary("s1", "当前"), summary("old", "上次"), summary("arch", "归档", { archived: true }), summary("kid", "子", { parentId: "old" })],
		messages: async () => messages,
	});
	const all = await handler.resolve(parseResourceUrl("session://old")!, scope());
	expect(all.content).toBe("用户：为什么慢\n\n助手：因为没缓存\n（调用了 read）");
	expect(all.origin).toBe("另一次会话的转录");
	expect((await handler.resolve(parseResourceUrl("session://old/2")!, scope())).content).toBe("助手：因为没缓存\n（调用了 read）");
	await expect(handler.resolve(parseResourceUrl("session://old/9")!, scope())).rejects.toThrow(/一共 2 条/);
	await expect(handler.resolve(parseResourceUrl("session://nope")!, scope())).rejects.toThrow(/没有 id 是“nope”的会话/);
	expect((await handler.list!(scope())).map((entry) => entry.value)).toEqual(["session://old"]);
});

it("plugin:// 先给 README，没有才给清单；出不去插件目录；一律带 origin", async () => {
	const withReadme = join(root, "p1");
	const without = join(root, "p2");
	await mkdir(withReadme, { recursive: true });
	await mkdir(without, { recursive: true });
	await writeFile(join(withReadme, "README.md"), "# 说明书");
	await writeFile(join(without, "package.json"), JSON.stringify({ version: "1.2.0", description: "做点事" }));
	await writeFile(join(root, "outside.txt"), "不该被读到");
	await symlink(join(root, "outside.txt"), join(withReadme, "escape.txt"));
	const handler = pluginResource(() => [
		{ name: "example.one", dir: withReadme, builtin: false },
		{ name: "example.two", dir: without, builtin: false },
	]);
	const one = await handler.resolve(parseResourceUrl("plugin://example.one")!, scope());
	expect(one).toMatchObject({ content: "# 说明书", origin: "第三方插件 example.one" });
	const two = await handler.resolve(parseResourceUrl("plugin://example.two")!, scope());
	expect(two.content).toBe("插件：example.two\n版本：1.2.0\n说明：做点事");
	await expect(handler.resolve(parseResourceUrl("plugin://example.one/../outside.txt")!, scope())).rejects.toThrow(/插件目录外面/);
	await expect(handler.resolve(parseResourceUrl("plugin://example.one/escape.txt")!, scope())).rejects.toThrow(/经过软链后指到了插件目录外面/);
	await expect(handler.resolve(parseResourceUrl("plugin://nope")!, scope())).rejects.toThrow(/现在装了：example.one、example.two/);
	expect(await handler.list!(scope())).toEqual([{ value: "plugin://example.one" }, { value: "plugin://example.two", description: "做点事" }]);
});
