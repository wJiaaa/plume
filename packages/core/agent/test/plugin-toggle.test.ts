import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ModelContext, Plugin } from "@plume/contract";
import { PluginHost } from "../src/host.ts";

// 往系统提示词里加一节、注册一个只读工具的插件（原生 UI 插件就是这样）：停用后两样都撤下，再启用原样回来；层不改调用方的原始消息。
const hint: Plugin = {
	name: "test.hint",
	apply(ctx) {
		ctx.hook("model.context", (input, next) => next({ ...input, sections: [...input.sections, { id: "hint", text: "需要时调 hint_help" }] }));
		ctx.tools.register({
			name: "hint_help",
			description: "读说明",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ output: "说明" }),
		});
	},
};

it("模型说明和只读工具随插件启停，不改变原始消息", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-plugin-toggle-"));
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
			session: { id: "s", kind: "top" },
			cwd: dir,
			scratchDir: join(dir, "scratch"),
			model: { id: "m", name: "M" },
			permissionMode: "auto",
			shell: { kind: "posix", label: "zsh", sandbox: "workspace-write" },
			personalization: { tone: "professional", customInstructions: "" },
			systemPrompt: "base",
			sections: [{ id: "identity", text: "base" }],
			messages: [],
			tools: [],
		};
		const before = structuredClone(input);
		await host.load([{ key: "hint", load: async () => hint }]);
		const active = await host.run("model.context", input, async (value) => value);
		expect(active.sections.map((section) => section.text).join("\n")).toContain("hint_help");
		expect(active.sections.length).toBeGreaterThan(before.sections.length);
		expect(host.toolSpecs().map((spec) => spec.name)).toEqual(["hint_help"]);
		expect(input).toEqual(before);
		await host.setEnabled("hint", false);
		expect(host.toolSpecs()).toEqual([]);
		expect((await host.run("model.context", input, async (value) => value)).sections).toEqual(before.sections);
		await host.setEnabled("hint", true);
		expect((await host.run("model.context", input, async (value) => value)).sections).toEqual(active.sections);
	} finally {
		await host.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
