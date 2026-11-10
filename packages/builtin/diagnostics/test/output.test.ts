import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Message, PluginContext } from "@plume/contract";
import type { DiagnosticsApi } from "../src/api.ts";
import plugin from "../src/index.ts";

it("完整输出只读本会话结果登记的日志，拒绝跨会话和软链接越界", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-diagnostic-output-"));
	const dataDir = join(dir, "plugin");
	const root = join(dir, "scratch", "a", "tool-output");
	await mkdir(dataDir);
	await mkdir(root, { recursive: true });
	const path = join(root, "output.log");
	await writeFile(path, "complete output");
	const outside = join(dir, "outside.txt");
	await writeFile(outside, "outside");
	await symlink(outside, join(root, "link.log"));
	let messages: Message[] = [];
	let api!: DiagnosticsApi;
	const disposers: Array<() => void> = [];
	try {
		plugin.apply({
			dataDir,
			appDataDir: dir,
			locale: () => "en",
			use: () => ({}),
			effect: (dispose: () => void) => disposers.push(dispose),
			serve: (value: DiagnosticsApi) => {
				api = value;
			},
			sessions: { observe() {}, onDeleted() {}, list: async () => [{ id: "a" }, { id: "b" }], messages: async (id: string) => (id === "a" ? messages : []) },
		} as unknown as PluginContext);
		const result = (outputPath: string): Message => ({
			role: "toolResult",
			toolCallId: "c",
			toolName: "bash",
			content: [],
			isError: false,
			timestamp: 1,
			details: { outputPath },
		});
		messages = [result(path)];
		expect((await api.fullOutput("a", "c")).contents).toMatchObject({ text: "complete output", truncated: false });
		await expect(api.fullOutput("b", "c")).rejects.toThrow();
		await expect(api.fullOutput("missing", "c")).rejects.toThrow();
		messages = [result(outside)];
		await expect(api.fullOutput("a", "c")).rejects.toThrow();
		messages = [result(join(root, "link.log"))];
		await expect(api.fullOutput("a", "c")).rejects.toThrow();
	} finally {
		for (const dispose of disposers.reverse()) dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
