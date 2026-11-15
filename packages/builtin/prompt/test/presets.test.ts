/**
 * 身份与准则：人能换的那一块怎么存、怎么校验、坏了怎么退，以及一个会话用哪一套在它第一次请求时定下、之后不变。
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, ModelContext, SessionScope } from "@plume/contract";
import { createPresets } from "../src/presets.ts";
import { BUILTIN_PERSONAS, buildPromptSections } from "../src/system.ts";

let dir: string;
let summaries: Map<string, { forkedFrom?: { sessionId: string } }>;
let trashed: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-presets-"));
	summaries = new Map();
	trashed = [];
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function open(locale: "zh-CN" | "en" = "zh-CN") {
	return createPresets({
		dataDir: join(dir, "data"),
		log: { warn() {}, info() {}, error() {} } as never,
		locale: () => locale,
		trash: async (path: string) => {
			trashed.push(path);
			await rm(path);
		},
		sessions: { get: async (id: string) => summaries.get(id) } as never,
	});
}

const hello: Message[] = [{ role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 }];
const request = (id: string, extra: Partial<SessionScope> = {}, messages: Message[] = hello): Pick<ModelContext, "sessionId" | "session" | "messages"> => ({
	sessionId: id,
	session: { id, kind: "top", ...extra },
	messages,
});
const draft = (name: string, identity = `You are ${name}.`, guidelines = "- Be careful.") => ({ name, identity, guidelines });

describe("选哪一套", () => {
	it("没选过时是「通用」；内置两套都列出来，带上固定的几条", async () => {
		const view = await open().view();
		expect(view.selected).toBe("general");
		expect(view.problem).toBeNull();
		expect(view.presets.map((preset) => [preset.id, preset.builtin])).toEqual([
			["general", true],
			["coding", true],
		]);
		expect(view.fixed.some((line) => line.startsWith("Write local file references"))).toBe(true);
	});

	it("改了选中的那套，已经开过头的会话还是原来那套，新开的会话用新的", async () => {
		const presets = open();
		expect(await presets.forRequest(request("s1"))).toMatchObject(BUILTIN_PERSONAS.general);
		await presets.select("coding");
		expect(await presets.forRequest(request("s1"))).toMatchObject(BUILTIN_PERSONAS.general);
		expect(await presets.forRequest(request("s2"))).toMatchObject(BUILTIN_PERSONAS.coding);
	});

	it("会话还没有消息时照选中的给、不记下：定下的时刻是人发第一句话", async () => {
		const presets = open();
		expect(await presets.forRequest(request("s1", {}, []))).toMatchObject(BUILTIN_PERSONAS.general);
		await presets.select("coding");
		expect(await presets.forRequest(request("s1"))).toMatchObject(BUILTIN_PERSONAS.coding);
	});

	it("记下的是全文：那套后来被改、被删，用它的会话不变；删的是选中的那套时改选「通用」、移进废纸篓", async () => {
		const presets = open();
		const created = await presets.save(undefined, draft("运维", "You are an ops agent.", "- Check before restarting."));
		const id = created.presets.find((preset) => preset.name === "运维")!.id;
		await presets.select(id);
		const used = await presets.forRequest(request("s1"));
		expect(used).toMatchObject({ identity: "You are an ops agent.", guidelines: "- Check before restarting." });

		await presets.save(id, draft("运维", "You are a different agent."));
		expect(await presets.forRequest(request("s1"))).toEqual(used);

		const after = await presets.remove(id);
		expect(after.selected).toBe("general");
		expect(after.presets.map((preset) => preset.id)).toEqual(["general", "coding"]);
		expect(trashed).toHaveLength(1);
		expect(await presets.forRequest(request("s1"))).toEqual(used);
		expect(await presets.forRequest(request("s2"))).toMatchObject(BUILTIN_PERSONAS.general);
	});

	it("子会话、分叉第一次请求时用父会话、来源会话记下的那份；对方没记过时用选中的", async () => {
		const presets = open();
		await presets.forRequest(request("main"));
		await presets.select("coding");
		expect(await presets.forRequest(request("child", { kind: "child", parentId: "main" }))).toMatchObject(BUILTIN_PERSONAS.general);
		summaries.set("fork", { forkedFrom: { sessionId: "main" } });
		expect(await presets.forRequest(request("fork"))).toMatchObject(BUILTIN_PERSONAS.general);
		expect(await presets.forRequest(request("orphan", { kind: "child", parentId: "never-asked" }))).toMatchObject(BUILTIN_PERSONAS.coding);
	});

	it("记下的那份落盘：重开应用后还是同一份；会话删掉时一起删", async () => {
		await open().forRequest(request("s1"));
		const reopened = open();
		await reopened.select("coding");
		expect(await reopened.forRequest(request("s1"))).toMatchObject(BUILTIN_PERSONAS.general);
		reopened.forget("s1");
		const file = join(dir, "data", "personas", "s1.json");
		for (let tries = 0; tries < 100 && (await readFile(file, "utf8").catch(() => null)) !== null; tries++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		await expect(readFile(file, "utf8")).rejects.toThrow();
		expect(await open().forRequest(request("s1"))).toMatchObject(BUILTIN_PERSONAS.coding);
	});
});

describe("存不进去的", () => {
	it("名字为空、太长、和别的重名（内置的两种语言的名字都算），身份为空、超限，都按界面语言说原因", async () => {
		const presets = open();
		await presets.save(undefined, draft("运维"));
		await expect(presets.save(undefined, draft("  "))).rejects.toThrow("名字不能为空");
		await expect(presets.save(undefined, draft("长".repeat(61)))).rejects.toThrow("最多 60 个字");
		await expect(presets.save(undefined, draft("运维"))).rejects.toThrow("已经有一套叫「运维」了");
		await expect(presets.save(undefined, draft("Coding"))).rejects.toThrow("已经有一套");
		await expect(presets.save(undefined, draft("新的", " "))).rejects.toThrow("身份不能为空");
		await expect(presets.save(undefined, draft("新的", "x".repeat(4 * 1024 + 1)))).rejects.toThrow("身份最多 4 KiB");
		await expect(open("en").save(undefined, draft("Fresh", "x", "y".repeat(32 * 1024 + 1)))).rejects.toThrow("Guidelines can be at most 32 KiB");
	});

	it("内置的不能改、不能删；找不到的选不了、改不了", async () => {
		const presets = open();
		await expect(presets.save("coding", draft("编程 2"))).rejects.toThrow("内置的不能改");
		await expect(presets.remove("general")).rejects.toThrow("内置的不能改");
		await expect(presets.select("custom-gone")).rejects.toThrow("找不到这一套");
		await expect(presets.save("custom-gone", draft("新的"))).rejects.toThrow("找不到这一套");
		await expect(presets.select("../x")).rejects.toThrow("找不到这一套");
	});

	it("改名时不和自己比重名", async () => {
		const presets = open();
		const id = (await presets.save(undefined, draft("运维"))).presets.at(-1)!.id;
		await expect(presets.save(id, draft("运维", "You are still ops."))).resolves.toBeDefined();
	});
});

describe("选中的那套坏了", () => {
	it("文件不见了或不合格：新会话用「通用」，设置页看得到原因", async () => {
		const presets = open();
		const id = (await presets.save(undefined, draft("运维"))).presets.at(-1)!.id;
		await presets.select(id);
		await writeFile(join(dir, "data", "presets", `${id}.json`), "{ 不是 JSON");
		expect(await presets.forRequest(request("s1"))).toMatchObject(BUILTIN_PERSONAS.general);
		expect(await presets.view()).toMatchObject({ selected: "general", problem: { id, reason: "invalid" } });

		await mkdir(join(dir, "data"), { recursive: true });
		await writeFile(join(dir, "data", "selected.json"), JSON.stringify({ id: "custom-gone" }));
		expect((await presets.view()).problem).toEqual({ id: "custom-gone", reason: "missing" });
	});
});

describe("拼进系统提示词", () => {
	const input = { cwd: "/w", platform: "darwin", modelName: "M", permissionMode: "auto" as const, isGitRepo: true, projectInstructions: [] };
	const guidelines = (persona: { identity: string; guidelines: string }) =>
		buildPromptSections({ ...input, persona }).find((section) => section.id === "guidelines")!.text;

	it("身份段是那一套的身份；准则段是那一套的准则接上固定的几条，准则写空了固定的照样在", () => {
		const sections = buildPromptSections({ ...input, persona: { identity: "You are an ops agent.", guidelines: "- Check twice." } });
		expect(sections.find((section) => section.id === "identity")).toEqual({ id: "identity", text: "You are an ops agent.", category: "identity" });
		expect(guidelines({ identity: "x", guidelines: "- Check twice." })).toMatch(/^Guidelines:\n- Check twice\.\n- Write local file references/);
		const empty = guidelines({ identity: "x", guidelines: "  " });
		expect(empty).toMatch(/^Guidelines:\n- Write local file references/);
		expect(empty).toContain("- Do not invent file paths");
		expect(empty).toContain("Reading or writing outside the workspace asks the user for approval");
	});

	it("编程那套比通用多三条改代码的准则，其余一样", () => {
		const general = guidelines(BUILTIN_PERSONAS.general).split("\n");
		const coding = guidelines(BUILTIN_PERSONAS.coding).split("\n");
		expect(coding.filter((line) => !general.includes(line)).map((line) => line.slice(0, 20))).toEqual([
			"- Match the surround",
			"- Make the simplest ",
			"- Verify your work w",
		]);
		expect(general.every((line) => coding.includes(line))).toBe(true);
	});
});
