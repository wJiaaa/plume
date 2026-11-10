import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelContext } from "@plume/contract";
import nativeUi from "../../../../../plume-plugins/plugins/native-ui/src/index.ts";
import { PluginHost } from "../src/host.ts";

it("原生 UI 的模型说明和只读帮助工具随插件启停，不改变原始消息", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-native-ui-"));
	const host = new PluginHost({
		dataDir: dir,
		appDataDir: dir,
		log: () => {},
		notice: () => {},
		model: {
			complete: async () => "",
			usage: async () => ({ requests: [], providerNames: {}, archived: [] }),
			findImageModel: async () => ({ reason: "none", candidates: [] }),
			image: async () => ({ ok: false, failure: { summary: "" } }),
		},
	});
	try {
		const input: ModelContext = {
			sessionId: "s",
			cwd: dir,
			scratchDir: join(dir, "scratch"),
			model: { id: "m", name: "M" },
			permissionMode: "auto",
			personalization: { tone: "professional", customInstructions: "" },
			systemPrompt: "base",
			sections: [{ id: "identity", text: "base" }],
			messages: [],
			tools: [],
		};
		const before = structuredClone(input);
		await host.load([{ key: "native-ui", load: async () => nativeUi }]);
		const active = await host.run("model.context", input, async (value) => value);
		expect(active.sections.map((section) => section.text).join("\n")).toContain("ui_help");
		expect(active.sections.length).toBeGreaterThan(before.sections.length);
		expect(host.toolSpecs().length).toBeGreaterThan(0);
		expect(input).toEqual(before);
		await host.setEnabled(nativeUi.name, false);
		expect(host.toolSpecs()).toEqual([]);
		expect((await host.run("model.context", input, async (value) => value)).systemPrompt).toBe("base");
		await host.setEnabled(nativeUi.name, true);
		expect((await host.run("model.context", input, async (value) => value)).sections).toEqual(active.sections);
	} finally {
		await host.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
