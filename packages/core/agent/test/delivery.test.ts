import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent, type Agent } from "../src/index.ts";
import { fakeAnthropic, type FakeModel } from "../src/testing.ts";
import type { TurnDelivery } from "../../../builtin/delivery/src/api.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string | undefined;
let agent: Agent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	if (dir) await rm(dir, { recursive: true, force: true });
});

it("真实插件链记录净变化，报告可读，重启后撤销不覆盖后续编辑", async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-delivery-"));
	const cwd = join(dir, "workspace");
	await mkdir(cwd);
	await writeFile(join(cwd, "existing.ts"), "original\n");
	model = await fakeAnthropic([
		{ toolCalls: [{ id: "read", name: "read", args: { path: "existing.ts" } }] },
		{
			toolCalls: [
				{ id: "edit1", name: "edit", args: { path: "existing.ts", old_string: "original", new_string: "middle" } },
				{ id: "edit2", name: "edit", args: { path: "existing.ts", old_string: "middle", new_string: "final" } },
				{ id: "write", name: "write", args: { path: "new.ts", content: "new\n" } },
			],
		},
		{ text: "交付完成。" },
	]);
	const options = { dataDir: join(dir, "data"), settingsFile: join(dir, "settings.json"), plugins: BUILTINS, log: () => undefined };
	agent = await createAgent(options);
	await agent.service.saveProvider({
		id: "",
		name: "test",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		apiKey: "test-key",
		models: [
			{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 1000, supportsThinking: false, supportsImages: false, supportsTools: true },
		],
	});
	await agent.service.setPermissionMode("full");
	const session = await agent.service.createSession({ cwd });
	agent.service.send(session.id, { content: [{ type: "text", text: "修改现有文件并新建文件。" }] });
	await vi.waitFor(
		async () => {
			const view = await agent!.service.getSession(session.id);
			expect(view.summary.running).toBe(false);
			expect(view.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		},
		{ timeout: 10_000 },
	);
	const view = await agent.service.getSession(session.id);
	const timestamp = view.messages.at(-1)!.timestamp;
	const call = (method: string, args: unknown[]) => agent!.service.callPlugin("plume.delivery", method, args, { signal: new AbortController().signal });
	let data = (await call("get", [session.id, timestamp])) as TurnDelivery;
	expect(data.warnings).toEqual([]);
	expect(data.files).toHaveLength(2);
	expect(data.files.find((file) => file.path.endsWith("existing.ts"))).toMatchObject({ added: 1, removed: 1, canUndo: true });
	expect(data.files.every((file) => file.canUndo)).toBe(true);
	const report = (await call("report", [session.id, timestamp])) as { path: string; contents: { text: string } };
	expect(report.path.startsWith(join(dir, "data"))).toBe(true);
	expect(report.contents.text).toContain("修改现有文件并新建文件。");
	expect(report.contents.text).toContain("existing.ts");
	expect((await stat(report.path)).mode & 0o777).toBe(0o600);

	await agent.shutdown();
	agent = await createAgent(options);
	data = (await call("get", [session.id, timestamp])) as TurnDelivery;
	expect(data.files.every((file) => file.canUndo)).toBe(true);
	await writeFile(join(cwd, "existing.ts"), "user later edit\n");
	await expect(call("undo", [session.id, timestamp, undefined])).rejects.toThrow();
	expect(await readFile(join(cwd, "existing.ts"), "utf8")).toBe("user later edit\n");
	expect(await readFile(join(cwd, "new.ts"), "utf8")).toBe("new\n");
	await call("undo", [session.id, timestamp, data.files.find((file) => file.path.endsWith("/new.ts"))!.path]);
	await expect(stat(join(cwd, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
	await writeFile(join(cwd, "existing.ts"), "final\n");
	await expect(call("undo", [session.id, timestamp, join(cwd, "existing.ts")])).rejects.toThrow();
	expect(await readFile(join(cwd, "existing.ts"), "utf8")).toBe("final\n");
});
